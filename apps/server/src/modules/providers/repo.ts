import type { Db, StoredModel } from "@agent-base/db";
import { sql } from "kysely";
import type { Auth } from "../../infra/context.ts";
import { permissionOf } from "../sharing/service.ts";

/** Channels the caller has any permission on, each labelled with that permission. */
const visible = (db: Db, auth: Auth) =>
  db
    .selectFrom("providers as r")
    .selectAll("r")
    .select(permissionOf(auth, "provider", "r").as("permission"))
    .where("r.org_id", "=", auth.orgId)
    .where(sql<boolean>`${permissionOf(auth, "provider", "r")} IS NOT NULL`);

export type ProviderRow = Awaited<ReturnType<typeof list>>[number];

export const list = (db: Db, auth: Auth) => visible(db, auth).orderBy("r.created_at").execute();

export const find = (db: Db, auth: Auth, id: string) => visible(db, auth).where("r.id", "=", id).executeTakeFirst();

export interface ProviderValues {
  name: string;
  provider_kind: string;
  protocol: string | null;
  base_url: string | null;
  default_model: string | null;
  models: StoredModel[];
  secret_enc: string | null;
  test_status: string;
}

export const insert = async (
  db: Db,
  row: ProviderValues & { id: string; org_id: string; owner_id: string },
): Promise<void> =>
  void (await db
    .insertInto("providers")
    .values({ ...row, models: JSON.stringify(row.models) })
    .execute());

export async function update(db: Db, id: string, values: Partial<ProviderValues>): Promise<void> {
  const { models, ...rest } = values;
  await db
    .updateTable("providers")
    .set({ ...rest, ...(models ? { models: JSON.stringify(models) } : {}), updated_at: new Date() })
    .where("id", "=", id)
    .execute();
}

export const remove = async (db: Db, id: string): Promise<void> =>
  void (await db.deleteFrom("providers").where("id", "=", id).execute());

/** A channel by id with no permission check — for callers that already established the right to it. */
export const findInOrg = (db: Db, orgId: string, id: string) =>
  db.selectFrom("providers").selectAll().where("org_id", "=", orgId).where("id", "=", id).executeTakeFirst();
