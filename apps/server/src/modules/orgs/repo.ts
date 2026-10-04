import type { Db, OrgRole } from "@agent-base/db";
import { sql } from "kysely";

export async function insertOrgWithOwner(db: Db, org: { id: string; name: string; created_by: string }): Promise<void> {
  await db.insertInto("orgs").values(org).execute();
  await db.insertInto("org_members").values({ org_id: org.id, user_id: org.created_by, role: "owner" }).execute();
}

export const findOrg = (db: Db, id: string) =>
  db.selectFrom("orgs").select(["id", "name"]).where("id", "=", id).executeTakeFirst();

export const renameOrg = async (db: Db, id: string, name: string): Promise<void> =>
  void (await db.updateTable("orgs").set({ name }).where("id", "=", id).execute());

export const listMemberships = (db: Db, userId: string): Promise<{ id: string; name: string; role: OrgRole }[]> =>
  db
    .selectFrom("org_members as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.id", "o.name", "m.role"])
    .where("m.user_id", "=", userId)
    .orderBy("m.joined_at")
    .execute();

const members = (db: Db, orgId: string) =>
  db
    .selectFrom("org_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["u.id", "u.email", "u.name", "m.role", "m.joined_at"])
    .where("m.org_id", "=", orgId);

export const listMembers = (db: Db, orgId: string) => members(db, orgId).orderBy("m.joined_at").execute();

export const findMember = (db: Db, orgId: string, userId: string) =>
  members(db, orgId).where("m.user_id", "=", userId).executeTakeFirst();

export const findMemberByEmail = (db: Db, orgId: string, email: string) =>
  members(db, orgId).where("u.email", "=", email).executeTakeFirst();

export const setRole = async (db: Db, orgId: string, userId: string, role: OrgRole): Promise<void> =>
  void (await db
    .updateTable("org_members")
    .set({ role })
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .execute());

export const removeMember = async (db: Db, orgId: string, userId: string): Promise<void> =>
  void (await db.deleteFrom("org_members").where("org_id", "=", orgId).where("user_id", "=", userId).execute());

/**
 * The organization's owners, locked for the rest of the transaction — so two
 * concurrent demotions cannot both conclude "there is still another owner".
 */
export const lockOwners = async (db: Db, orgId: string): Promise<string[]> =>
  (
    await db
      .selectFrom("org_members")
      .select("user_id")
      .where("org_id", "=", orgId)
      .where("role", "=", "owner")
      .forUpdate()
      .execute()
  ).map((row) => row.user_id);

export const addMember = async (db: Db, orgId: string, userId: string, role: OrgRole): Promise<void> =>
  void (await db
    .insertInto("org_members")
    .values({ org_id: orgId, user_id: userId, role })
    .onConflict((oc) => oc.doNothing())
    .execute());

export interface InviteRow {
  id: string;
  org_id: string;
  email: string;
  role: "admin" | "member";
  token_hash: string;
  invited_by: string;
  expires_at: Date;
}

export const insertInvite = (db: Db, invite: InviteRow) =>
  db
    .insertInto("org_invites")
    .values(invite)
    .returning(["id", "email", "role", "expires_at", "created_at"])
    .executeTakeFirstOrThrow();

export const listPendingInvites = (db: Db, orgId: string) =>
  db
    .selectFrom("org_invites")
    .select(["id", "email", "role", "expires_at", "created_at"])
    .where("org_id", "=", orgId)
    .where("accepted_at", "is", null)
    .where("expires_at", ">", sql<Date>`now()`)
    .orderBy("created_at", "desc")
    .execute();

export const deleteInvite = async (db: Db, orgId: string, id: string): Promise<boolean> =>
  (
    await db
      .deleteFrom("org_invites")
      .where("org_id", "=", orgId)
      .where("id", "=", id)
      .where("accepted_at", "is", null)
      .executeTakeFirst()
  ).numDeletedRows > 0n;

/** A usable invite, locked so it is accepted once. */
export const lockUsableInvite = (db: Db, tokenHash: string) =>
  db
    .selectFrom("org_invites")
    .select(["id", "org_id", "email", "role"])
    .where("token_hash", "=", tokenHash)
    .where("accepted_at", "is", null)
    .where("expires_at", ">", sql<Date>`now()`)
    .forUpdate()
    .executeTakeFirst();

export const markInviteAccepted = async (db: Db, id: string): Promise<void> =>
  void (await db.updateTable("org_invites").set({ accepted_at: new Date() }).where("id", "=", id).execute());
