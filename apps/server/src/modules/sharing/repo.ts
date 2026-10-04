import type { Db, PrincipalType, SharePermission } from "@agent-base/db";
import { sql } from "kysely";

export function listForResource(db: Db, type: string, resourceId: string) {
  return db
    .selectFrom("resource_shares as s")
    .leftJoin("users as u", (join) => join.on("s.principal_type", "=", "user").onRef("u.id", "=", "s.principal_id"))
    .leftJoin("teams as t", (join) => join.on("s.principal_type", "=", "team").onRef("t.id", "=", "s.principal_id"))
    .leftJoin("orgs as o", (join) => join.on("s.principal_type", "=", "org").onRef("o.id", "=", "s.principal_id"))
    .select(["s.id", "s.principal_type", "s.principal_id", "s.permission", "s.created_at"])
    .select(sql<string | null>`COALESCE(u.name, t.name, o.name)`.as("principal_name"))
    .where("s.resource_type", "=", type)
    .where("s.resource_id", "=", resourceId)
    .orderBy("s.created_at")
    .execute();
}

/** Whether a user or team belongs to the organization (so it can be shared with). */
export async function principalInOrg(db: Db, orgId: string, type: "user" | "team", id: string): Promise<boolean> {
  const row =
    type === "user"
      ? await db
          .selectFrom("org_members")
          .select("user_id")
          .where("org_id", "=", orgId)
          .where("user_id", "=", id)
          .executeTakeFirst()
      : await db.selectFrom("teams").select("id").where("org_id", "=", orgId).where("id", "=", id).executeTakeFirst();
  return row !== undefined;
}

export interface ShareRow {
  id: string;
  org_id: string;
  resource_type: string;
  resource_id: string;
  principal_type: PrincipalType;
  principal_id: string;
  permission: SharePermission;
  rank: number;
  created_by: string;
}

export const upsert = (db: Db, share: ShareRow) =>
  db
    .insertInto("resource_shares")
    .values(share)
    .onConflict((oc) =>
      oc
        .columns(["resource_type", "resource_id", "principal_type", "principal_id"])
        .doUpdateSet({ permission: share.permission, rank: share.rank }),
    )
    .returning(["id", "principal_type", "principal_id", "permission", "created_at"])
    .executeTakeFirstOrThrow();

export const remove = async (db: Db, type: string, resourceId: string, shareId: string): Promise<boolean> =>
  (
    await db
      .deleteFrom("resource_shares")
      .where("id", "=", shareId)
      .where("resource_type", "=", type)
      .where("resource_id", "=", resourceId)
      .executeTakeFirst()
  ).numDeletedRows > 0n;

export const removeForPrincipal = async (
  db: Db,
  orgId: string,
  principalType: PrincipalType,
  principalId: string,
): Promise<void> =>
  void (await db
    .deleteFrom("resource_shares")
    .where("org_id", "=", orgId)
    .where("principal_type", "=", principalType)
    .where("principal_id", "=", principalId)
    .execute());

export const removeForResource = async (db: Db, type: string, resourceId: string): Promise<void> =>
  void (await db
    .deleteFrom("resource_shares")
    .where("resource_type", "=", type)
    .where("resource_id", "=", resourceId)
    .execute());
