import type { Db } from "@agent-base/db";

/** A project's team: each member with the library agent it refers to. */
const members = (db: Db) =>
  db
    .selectFrom("project_members as m")
    .innerJoin("agents as a", "a.id", "m.agent_id")
    .select([
      "m.id",
      "m.project_id",
      "m.agent_slug",
      "a.id as agent_id",
      "a.slug as source_agent_slug",
      "a.name",
      "a.model",
      "a.runtime",
      "a.instructions",
      "a.skills",
      "a.connector_types",
      "a.provider_id",
      "a.effort",
    ]);

export type MemberRow = Awaited<ReturnType<typeof listForProject>>[number];

export const listForProject = (db: Db, projectId: string) =>
  members(db).where("m.project_id", "=", projectId).orderBy("m.created_at").execute();

export const findInProject = (db: Db, projectId: string, agentSlug: string) =>
  members(db).where("m.project_id", "=", projectId).where("m.agent_slug", "=", agentSlug).executeTakeFirst();

export const insert = async (
  db: Db,
  member: { id: string; project_id: string; agent_id: string; agent_slug: string },
): Promise<void> => void (await db.insertInto("project_members").values(member).execute());

export const remove = async (db: Db, id: string): Promise<void> =>
  void (await db.deleteFrom("project_members").where("id", "=", id).execute());

/** Every project the agent is deployed to — including ones the caller cannot see. */
export const listForAgent = (db: Db, agentId: string) =>
  db.selectFrom("project_members").select(["project_id", "agent_slug"]).where("agent_id", "=", agentId).execute();
