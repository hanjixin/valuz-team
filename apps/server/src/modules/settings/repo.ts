import type { Db } from "@agent-base/db";

export interface Scope {
  orgId: string;
  userId: string;
}

export async function read(db: Db, scope: Scope, key: string): Promise<unknown> {
  const row = await db
    .selectFrom("user_settings")
    .select("value")
    .where("org_id", "=", scope.orgId)
    .where("user_id", "=", scope.userId)
    .where("key", "=", key)
    .executeTakeFirst();
  return row?.value;
}

export const write = async (db: Db, scope: Scope, key: string, value: unknown): Promise<void> =>
  void (await db
    .insertInto("user_settings")
    .values({ org_id: scope.orgId, user_id: scope.userId, key, value: JSON.stringify(value) })
    .onConflict((oc) =>
      oc.columns(["org_id", "user_id", "key"]).doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }),
    )
    .execute());
