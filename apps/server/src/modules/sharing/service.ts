/**
 * Access control. Every shareable row carries `org_id` and `owner_id`; the
 * caller's permission on it is:
 *
 *   its owner, or an organization owner/admin → admin
 *   otherwise                                 → the strongest share that reaches them
 *                                               (the whole org, one of their teams, or them)
 *   nothing reaches them                      → none: the row is invisible
 */
import type { Schema } from "@agent-base/contract";
import type { Db, PrincipalType, SharePermission } from "@agent-base/db";
import { type RawBuilder, sql } from "kysely";
import { isOrgAdmin } from "../../infra/auth.ts";
import type { Auth } from "../../infra/context.ts";
import { badRequest, forbidden, notFound } from "../../infra/errors.ts";
import * as repo from "./repo.ts";

export type ShareableType = Schema<"ShareableType">;
export type Permission = SharePermission | "admin";

const LADDER: readonly Permission[] = ["view", "use", "edit", "control", "admin"];
export const permissionRank = (permission: Permission): number => LADDER.indexOf(permission) + 1;
export const permissionAtLeast = (held: Permission, needed: Permission): boolean =>
  permissionRank(held) >= permissionRank(needed);

/** Which table holds each shareable type. A module registers its own when it loads. */
const tables = new Map<ShareableType, string>();
export function registerShareable(type: ShareableType, table: string): void {
  tables.set(type, table);
}

/**
 * SQL expression for the caller's permission on the row aliased `alias` — NULL
 * when they have none. Select it to label rows, or filter a list with
 * `WHERE <expression> IS NOT NULL`.
 */
export function permissionOf(auth: Auth, type: ShareableType, alias: string): RawBuilder<Permission | null> {
  const owner = sql.ref(`${alias}.owner_id`);
  const id = sql.ref(`${alias}.id`);
  return sql<Permission | null>`CASE WHEN ${owner} = ${auth.userId}::uuid OR ${isOrgAdmin(auth)}::boolean THEN 'admin' ELSE (
    SELECT s.permission FROM resource_shares s
     WHERE s.resource_type = ${type} AND s.resource_id = ${id} AND (
           (s.principal_type = 'org'  AND s.principal_id = ${auth.orgId}::uuid)
        OR (s.principal_type = 'user' AND s.principal_id = ${auth.userId}::uuid)
        OR (s.principal_type = 'team' AND s.principal_id IN (
              SELECT team_id FROM team_members WHERE user_id = ${auth.userId}::uuid)))
     ORDER BY s.rank DESC LIMIT 1) END`;
}

export async function getPermission(db: Db, auth: Auth, type: ShareableType, id: string): Promise<Permission | null> {
  const table = tables.get(type);
  if (!table) return null;
  const { rows } = await sql<{ permission: Permission | null }>`
    SELECT ${permissionOf(auth, type, "r")} AS permission
      FROM ${sql.table(table)} AS r WHERE r.id = ${id}::uuid AND r.org_id = ${auth.orgId}::uuid`.execute(db);
  return rows[0]?.permission ?? null;
}

/** 404 when the caller cannot even see the row; 403 when they can but not at this level. */
export async function requirePermission(
  db: Db,
  auth: Auth,
  type: ShareableType,
  id: string,
  needed: Permission,
): Promise<Permission> {
  const held = await getPermission(db, auth, type, id);
  if (!held) throw notFound(type);
  if (!permissionAtLeast(held, needed)) throw forbidden(`this needs "${needed}" permission on the ${type}`);
  return held;
}

export const listShares = repo.listForResource;

/** Grant a share, or change the one that principal already has. The principal must be in the caller's organization. */
export async function putShare(db: Db, auth: Auth, type: ShareableType, id: string, input: Schema<"ShareRequest">) {
  let principalId = input.principal_id;
  if (input.principal_type === "org") principalId = auth.orgId;
  else if (!principalId) throw badRequest("principal_id is required");
  else if (!(await repo.principalInOrg(db, auth.orgId, input.principal_type, principalId)))
    throw badRequest(
      input.principal_type === "user"
        ? "that user is not a member of this organization"
        : "that team does not exist in this organization",
    );
  return repo.upsert(db, {
    id: crypto.randomUUID(),
    org_id: auth.orgId,
    resource_type: type,
    resource_id: id,
    principal_type: input.principal_type,
    principal_id: principalId,
    permission: input.permission,
    rank: permissionRank(input.permission),
    created_by: auth.userId,
  });
}

export const deleteShare = repo.remove;

/** A member left or a team was deleted: every grant made to them ends. */
export const revokeForPrincipal = (db: Db, orgId: string, type: PrincipalType, id: string): Promise<void> =>
  repo.removeForPrincipal(db, orgId, type, id);

/** A resource was deleted: its shares go with it. */
export const revokeForResource = repo.removeForResource;
