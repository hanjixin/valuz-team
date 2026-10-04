import type { Db, SkillFile } from "@agent-base/db";
import { sql } from "kysely";
import type { Auth } from "../../infra/context.ts";
import { permissionOf } from "../sharing/service.ts";

/** Skills the caller has any permission on, each labelled with that permission. */
const visible = (db: Db, auth: Auth) =>
  db
    .selectFrom("skills as r")
    .selectAll("r")
    .select(permissionOf(auth, "skill", "r").as("permission"))
    .where("r.org_id", "=", auth.orgId)
    .where(sql<boolean>`${permissionOf(auth, "skill", "r")} IS NOT NULL`);

export type SkillRow = Awaited<ReturnType<typeof list>>[number];

export const list = (db: Db, auth: Auth) => visible(db, auth).orderBy("r.name").execute();

/** By id, or by slug — agents and people refer to skills by slug. */
export const find = (db: Db, auth: Auth, key: string, byId: boolean) =>
  visible(db, auth)
    .where(byId ? "r.id" : "r.slug", "=", key)
    .executeTakeFirst();

export const slugsInOrg = async (db: Db, orgId: string): Promise<Set<string>> =>
  new Set((await db.selectFrom("skills").select("slug").where("org_id", "=", orgId).execute()).map((row) => row.slug));

export interface Content {
  name: string;
  description: string;
  files: SkillFile[];
}

/** Create a skill at version 1, with that version on record. */
export async function insert(
  db: Db,
  row: Content & { id: string; org_id: string; owner_id: string; slug: string; creation_origin: string },
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto("skills")
      .values({ ...row, files: JSON.stringify(row.files) })
      .execute();
    await tx
      .insertInto("skill_versions")
      .values({
        id: crypto.randomUUID(),
        skill_id: row.id,
        version: 1,
        name: row.name,
        description: row.description,
        files: JSON.stringify(row.files),
        created_by: row.owner_id,
      })
      .execute();
  });
}

/** Replace a skill's content: the version number moves on and the new content is put on record. */
export async function saveContent(db: Db, id: string, content: Content, by: string): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const { version } = await tx
      .updateTable("skills")
      .set({
        name: content.name,
        description: content.description,
        files: JSON.stringify(content.files),
        version: sql`version + 1`,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returning("version")
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("skill_versions")
      .values({
        id: crypto.randomUUID(),
        skill_id: id,
        version,
        name: content.name,
        description: content.description,
        files: JSON.stringify(content.files),
        created_by: by,
      })
      .execute();
    return version;
  });
}

export const remove = async (db: Db, id: string): Promise<void> =>
  void (await db.deleteFrom("skills").where("id", "=", id).execute());

export const listVersions = (db: Db, skillId: string) =>
  db.selectFrom("skill_versions").selectAll().where("skill_id", "=", skillId).orderBy("version", "desc").execute();

export const findVersion = (db: Db, skillId: string, revisionId: string) =>
  db
    .selectFrom("skill_versions")
    .selectAll()
    .where("skill_id", "=", skillId)
    .where("id", "=", revisionId)
    .executeTakeFirst();

/** The packages an agent's turn needs, by slug. No permission check: the agent using them is the authorization. */
export const bundlesBySlug = (db: Db, orgId: string, slugs: string[]) =>
  slugs.length === 0
    ? Promise.resolve([])
    : db
        .selectFrom("skills")
        .select(["slug", "version", "files"])
        .where("org_id", "=", orgId)
        .where("slug", "in", slugs)
        .execute();
