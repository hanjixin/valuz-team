import type { Db } from "@agent-base/db";
import { sql } from "kysely";
import type { Auth } from "../../infra/context.ts";
import { permissionOf } from "../sharing/service.ts";

/** Projects the caller has any permission on, each labelled with that permission. */
const visible = (db: Db, auth: Auth) =>
  db
    .selectFrom("projects as r")
    .selectAll("r")
    .select(permissionOf(auth, "project", "r").as("permission"))
    .where("r.org_id", "=", auth.orgId)
    .where(sql<boolean>`${permissionOf(auth, "project", "r")} IS NOT NULL`);

export type ProjectRow = Awaited<ReturnType<typeof list>>[number];

export const list = (db: Db, auth: Auth) => visible(db, auth).orderBy("r.updated_at", "desc").execute();

export const find = (db: Db, auth: Auth, id: string) => visible(db, auth).where("r.id", "=", id).executeTakeFirst();

export const insert = async (
  db: Db,
  row: {
    id: string;
    org_id: string;
    owner_id: string;
    name: string;
    kind?: "chat" | "project";
    icon: string | null;
    device_id: string | null;
    root_path: string | null;
  },
): Promise<void> => void (await db.insertInto("projects").values(row).execute());

export const update = async (
  db: Db,
  id: string,
  values: { name?: string; instructions_md?: string; default_lead_agent_slug?: string | null },
): Promise<void> =>
  void (await db
    .updateTable("projects")
    .set({ ...values, updated_at: new Date() })
    .where("id", "=", id)
    .execute());

export const remove = async (db: Db, id: string): Promise<void> =>
  void (await db.deleteFrom("projects").where("id", "=", id).execute());

/** A project by id with no permission check — for callers that already established the right to it. */
export const byId = (db: Db, id: string) =>
  db.selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirst();
