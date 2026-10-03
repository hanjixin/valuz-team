/**
 * Access control. Every shareable resource row carries `org_id` + `owner_id`;
 * the caller's permission is:
 *
 *   owner or org owner/admin → admin
 *   otherwise                → the strongest matching share (org / team / user)
 *   no match                 → none (the row is invisible)
 */
import { type Permission, type ResourceType, type ShareInput, permissionAtLeast, permissionRank } from "@agent-base/protocol";
import { type Auth, isOrgAdmin } from "./context.ts";
import type { Queryable } from "./db.ts";
import { badRequest, forbidden, notFound } from "./http.ts";

/**
 * SQL expression yielding the caller's permission on row alias `r`.
 * Binds `$1` = user id, `$2` = org id, `$3` = caller is org admin — every
 * query that uses it must pass `aclParams(auth)` as its first three params.
 */
export const permissionSql = (type: ResourceType, alias = "r"): string => `
  CASE WHEN ${alias}.owner_id = $1::uuid OR $3::boolean THEN 'admin' ELSE (
    SELECT s.permission FROM resource_shares s
     WHERE s.resource_type = '${type}' AND s.resource_id = ${alias}.id AND (
           (s.principal_type = 'org'  AND s.principal_id = $2::uuid)
        OR (s.principal_type = 'user' AND s.principal_id = $1::uuid)
        OR (s.principal_type = 'team' AND s.principal_id IN (SELECT team_id FROM team_members WHERE user_id = $1::uuid)))
     ORDER BY s.rank DESC LIMIT 1) END`;

export const aclParams = (auth: Auth): [string, string, boolean] => [auth.userId, auth.orgId, isOrgAdmin(auth)];

const TABLES: Record<ResourceType, string> = {
  agent: "agents",
  skill: "skills",
  connector: "connectors",
  provider: "providers",
  project: "projects",
  device: "devices",
  session: "sessions",
  file: "files",
};

export async function getPermission(
  db: Queryable,
  auth: Auth,
  type: ResourceType,
  id: string,
): Promise<Permission | null> {
  const row = await db.one<{ permission: Permission | null }>(
    `SELECT ${permissionSql(type)} AS permission FROM ${TABLES[type]} r WHERE r.id = $4 AND r.org_id = $2::uuid`,
    [...aclParams(auth), id],
  );
  return row?.permission ?? null;
}

/** 404 when the caller cannot even see the row, 403 when they can but lack the level. */
export async function requirePermission(
  db: Queryable,
  auth: Auth,
  type: ResourceType,
  id: string,
  needed: Permission,
): Promise<Permission> {
  const held = await getPermission(db, auth, type, id);
  if (!held) throw notFound(type);
  if (!permissionAtLeast(held, needed)) throw forbidden(`this needs "${needed}" permission on the ${type}`);
  return held;
}

export async function listShares(db: Queryable, type: ResourceType, id: string) {
  return db.query(
    `SELECT s.id, s.principal_type, s.principal_id, s.permission, s.created_at,
            COALESCE(u.name, t.name, o.name) AS principal_name
       FROM resource_shares s
       LEFT JOIN users u ON s.principal_type = 'user' AND u.id = s.principal_id
       LEFT JOIN teams t ON s.principal_type = 'team' AND t.id = s.principal_id
       LEFT JOIN orgs  o ON s.principal_type = 'org'  AND o.id = s.principal_id
      WHERE s.resource_type = $1 AND s.resource_id = $2 ORDER BY s.created_at`,
    [type, id],
  );
}

/** Grant (or change) a share. The principal must belong to the caller's org. */
export async function putShare(db: Queryable, auth: Auth, type: ResourceType, id: string, input: ShareInput) {
  let principalId = input.principal_id;
  if (input.principal_type === "org") {
    principalId = auth.orgId;
  } else if (!principalId) {
    throw badRequest("principal_id is required");
  } else if (input.principal_type === "user") {
    const member = await db.one("SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2", [auth.orgId, principalId]);
    if (!member) throw badRequest("that user is not a member of this organization");
  } else {
    const team = await db.one("SELECT 1 FROM teams WHERE org_id = $1 AND id = $2", [auth.orgId, principalId]);
    if (!team) throw badRequest("that team does not exist in this organization");
  }
  return db.one(
    `INSERT INTO resource_shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, rank, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
     DO UPDATE SET permission = EXCLUDED.permission, rank = EXCLUDED.rank
     RETURNING id, principal_type, principal_id, permission`,
    [crypto.randomUUID(), auth.orgId, type, id, input.principal_type, principalId, input.permission, permissionRank(input.permission), auth.userId],
  );
}

export async function audit(
  db: Queryable,
  auth: Pick<Auth, "userId" | "orgId">,
  action: string,
  resource: { type?: string; id?: string } = {},
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    "INSERT INTO audit_logs (org_id, actor_id, action, resource_type, resource_id, detail) VALUES ($1, $2, $3, $4, $5, $6)",
    [auth.orgId, auth.userId, action, resource.type ?? null, resource.id ?? null, JSON.stringify(detail)],
  );
}
