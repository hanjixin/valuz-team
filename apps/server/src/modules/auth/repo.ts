import type { Db, OrgRole } from "@agent-base/db";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
}

export const findUserByEmail = (db: Db, email: string): Promise<UserRow | undefined> =>
  db.selectFrom("users").select(["id", "email", "name", "password_hash"]).where("email", "=", email).executeTakeFirst();

export const findUserById = (db: Db, id: string) =>
  db.selectFrom("users").select(["id", "email", "name"]).where("id", "=", id).executeTakeFirst();

/** Create a user together with the organization they own. */
export async function createUserWithOrg(db: Db, user: UserRow, orgName: string): Promise<string> {
  const orgId = crypto.randomUUID();
  await db.transaction().execute(async (tx) => {
    await tx.insertInto("users").values(user).execute();
    await tx.insertInto("orgs").values({ id: orgId, name: orgName, created_by: user.id }).execute();
    await tx.insertInto("org_members").values({ org_id: orgId, user_id: user.id, role: "owner" }).execute();
  });
  return orgId;
}

export const listMemberships = (db: Db, userId: string): Promise<{ id: string; name: string; role: OrgRole }[]> =>
  db
    .selectFrom("org_members as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.id", "o.name", "m.role"])
    .where("m.user_id", "=", userId)
    .orderBy("m.joined_at")
    .execute();
