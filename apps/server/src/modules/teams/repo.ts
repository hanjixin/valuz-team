import type { Db } from "@agent-base/db";
import { sql } from "kysely";

const withMembers = (db: Db, orgId: string) =>
  db
    .selectFrom("teams as t")
    .leftJoin("team_members as tm", "tm.team_id", "t.id")
    .select(["t.id", "t.name"])
    .select(
      sql<string[]>`COALESCE(array_agg(tm.user_id ORDER BY tm.user_id) FILTER (WHERE tm.user_id IS NOT NULL), '{}')`.as(
        "member_ids",
      ),
    )
    .where("t.org_id", "=", orgId)
    .groupBy("t.id");

export const list = (db: Db, orgId: string) => withMembers(db, orgId).orderBy("t.name").execute();

export const find = (db: Db, orgId: string, id: string) =>
  withMembers(db, orgId).where("t.id", "=", id).executeTakeFirst();

export const findByName = (db: Db, orgId: string, name: string) =>
  db.selectFrom("teams").select("id").where("org_id", "=", orgId).where("name", "=", name).executeTakeFirst();

export const insert = async (db: Db, team: { id: string; org_id: string; name: string }): Promise<void> =>
  void (await db.insertInto("teams").values(team).execute());

export const rename = async (db: Db, orgId: string, id: string, name: string): Promise<void> =>
  void (await db.updateTable("teams").set({ name }).where("org_id", "=", orgId).where("id", "=", id).execute());

export const remove = async (db: Db, orgId: string, id: string): Promise<boolean> =>
  (await db.deleteFrom("teams").where("org_id", "=", orgId).where("id", "=", id).executeTakeFirst()).numDeletedRows >
  0n;

export async function replaceMembers(db: Db, teamId: string, userIds: string[]): Promise<void> {
  await db.deleteFrom("team_members").where("team_id", "=", teamId).execute();
  if (userIds.length)
    await db
      .insertInto("team_members")
      .values(userIds.map((user_id) => ({ team_id: teamId, user_id })))
      .execute();
}

export const removeUser = async (db: Db, orgId: string, userId: string): Promise<void> =>
  void (await db
    .deleteFrom("team_members")
    .where("user_id", "=", userId)
    .where("team_id", "in", (qb) => qb.selectFrom("teams").select("id").where("org_id", "=", orgId))
    .execute());

/** How many of these users belong to the organization. */
export async function countOrgMembers(db: Db, orgId: string, userIds: string[]): Promise<number> {
  if (userIds.length === 0) return 0;
  const row = await db
    .selectFrom("org_members")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .where("user_id", "in", userIds)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
