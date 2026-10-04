import type { ConnectorConfig, Db } from "@agent-base/db";
import { sql } from "kysely";
import type { Auth } from "../../infra/context.ts";
import { permissionOf } from "../sharing/service.ts";

/** Connectors the caller has any permission on, each labelled with that permission. */
const visible = (db: Db, auth: Auth) =>
  db
    .selectFrom("connectors as r")
    .selectAll("r")
    .select(permissionOf(auth, "connector", "r").as("permission"))
    .where("r.org_id", "=", auth.orgId)
    .where(sql<boolean>`${permissionOf(auth, "connector", "r")} IS NOT NULL`);

export type ConnectorRow = Awaited<ReturnType<typeof list>>[number];

export const list = (db: Db, auth: Auth) => visible(db, auth).orderBy("r.created_at").execute();

/** By id, or by slug — agents refer to connectors by slug. */
export const find = (db: Db, auth: Auth, key: string, byId: boolean) =>
  visible(db, auth)
    .where(byId ? "r.id" : "r.slug", "=", key)
    .executeTakeFirst();

export const slugsInOrg = async (db: Db, orgId: string): Promise<Set<string>> =>
  new Set(
    (await db.selectFrom("connectors").select("slug").where("org_id", "=", orgId).execute()).map((row) => row.slug),
  );

export interface Values {
  display_name: string;
  description: string | null;
  transport: string;
  auth_type: string;
  config: ConnectorConfig;
  secret_enc: string | null;
  enabled: boolean;
}

export const insert = async (
  db: Db,
  row: Values & { id: string; org_id: string; owner_id: string; slug: string },
): Promise<void> =>
  void (await db
    .insertInto("connectors")
    .values({ ...row, config: JSON.stringify(row.config) })
    .execute());

export async function update(
  db: Db,
  id: string,
  values: Partial<Values> & {
    status?: string;
    tool_count?: number | null;
    last_tested_at?: Date;
    error_message?: string | null;
  },
): Promise<void> {
  const { config, ...rest } = values;
  await db
    .updateTable("connectors")
    .set({ ...rest, ...(config ? { config: JSON.stringify(config) } : {}), updated_at: new Date() })
    .where("id", "=", id)
    .execute();
}

export const remove = async (db: Db, id: string): Promise<void> =>
  void (await db.deleteFrom("connectors").where("id", "=", id).execute());

/** The enabled connectors an agent's turn needs, by slug. No permission check: the agent using them is the authorization. */
export const enabledBySlug = (db: Db, orgId: string, slugs: string[]) =>
  slugs.length === 0
    ? Promise.resolve([])
    : db
        .selectFrom("connectors")
        .selectAll()
        .where("org_id", "=", orgId)
        .where("slug", "in", slugs)
        .where("enabled", "=", true)
        .execute();
