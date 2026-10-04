import type { Db } from "@agent-base/db";
import { sql } from "kysely";
import type { Auth } from "../../infra/context.ts";
import { permissionOf } from "../sharing/service.ts";

/** Agents the caller has any permission on, each labelled with that permission. */
const visible = (db: Db, auth: Auth) =>
  db
    .selectFrom("agents as r")
    .innerJoin("users as u", "u.id", "r.owner_id")
    .selectAll("r")
    .select("u.name as owner_name")
    .select(permissionOf(auth, "agent", "r").as("permission"))
    .where("r.org_id", "=", auth.orgId)
    .where(sql<boolean>`${permissionOf(auth, "agent", "r")} IS NOT NULL`);

export type AgentRow = Awaited<ReturnType<typeof list>>[number];

export const list = (db: Db, auth: Auth) => visible(db, auth).orderBy("r.created_at").execute();

export const findBySlug = (db: Db, auth: Auth, slug: string) =>
  visible(db, auth).where("r.slug", "=", slug).executeTakeFirst();

/** Every slug in the organization — including agents the caller cannot see, which still hold their slug. */
export const slugsInOrg = async (db: Db, orgId: string): Promise<Set<string>> =>
  new Set((await db.selectFrom("agents").select("slug").where("org_id", "=", orgId).execute()).map((row) => row.slug));

export interface AgentValues {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  runtime: string;
  model: string;
  provider_id: string | null;
  effort: string | null;
  skills: string[];
  connector_types: string[];
  knowledge_scope: string[];
  inherit_global_instructions: boolean;
  permission_mode: string;
  avatar: string | null;
}

const lists = (values: Partial<AgentValues>) => ({
  ...(values.skills ? { skills: JSON.stringify(values.skills) } : {}),
  ...(values.connector_types ? { connector_types: JSON.stringify(values.connector_types) } : {}),
  ...(values.knowledge_scope ? { knowledge_scope: JSON.stringify(values.knowledge_scope) } : {}),
});

export const insert = async (
  db: Db,
  row: AgentValues & { id: string; org_id: string; owner_id: string },
): Promise<void> =>
  void (await db
    .insertInto("agents")
    .values({ ...row, ...lists(row) } as never)
    .execute());

export const update = async (db: Db, id: string, values: Partial<AgentValues>): Promise<void> =>
  void (await db
    .updateTable("agents")
    .set({ ...values, ...lists(values), updated_at: new Date() } as never)
    .where("id", "=", id)
    .execute());

export const remove = async (db: Db, id: string): Promise<void> =>
  void (await db.deleteFrom("agents").where("id", "=", id).execute());

/** An agent by id, with no permission check — for callers that already established the right to it. */
export const findById = (db: Db, id: string) =>
  db.selectFrom("agents").selectAll().where("id", "=", id).executeTakeFirst();
