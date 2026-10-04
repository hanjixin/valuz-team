import type { Db } from "@agent-base/db";

export type BindingRow = NonNullable<Awaited<ReturnType<typeof byId>>>;

export const find = (db: Db, orgId: string, platform: string, agentSlug: string) =>
  db
    .selectFrom("channel_bindings")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("platform", "=", platform)
    .where("agent_slug", "=", agentSlug)
    .executeTakeFirst();

export const byId = (db: Db, id: string) =>
  db.selectFrom("channel_bindings").selectAll().where("id", "=", id).executeTakeFirst();

/** The enabled bots a device keeps connected. */
export const listOnDevice = (db: Db, deviceId: string) =>
  db.selectFrom("channel_bindings").selectAll().where("device_id", "=", deviceId).where("enabled", "=", true).execute();

/** Give a member's bots that no device holds to this one of theirs. */
export const claim = async (db: Db, orgId: string, ownerId: string, deviceId: string): Promise<void> => {
  await db
    .updateTable("channel_bindings")
    .set({ device_id: deviceId })
    .where("org_id", "=", orgId)
    .where("owner_id", "=", ownerId)
    .where("device_id", "is", null)
    .execute();
};

export const upsert = (
  db: Db,
  row: {
    id: string;
    org_id: string;
    owner_id: string;
    platform: string;
    agent_slug: string;
    app_id: string;
    secret_enc: string;
    enabled: boolean;
    device_id: string | null;
  },
) =>
  db
    .insertInto("channel_bindings")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["org_id", "platform", "agent_slug"]).doUpdateSet({
        owner_id: row.owner_id,
        app_id: row.app_id,
        secret_enc: row.secret_enc,
        enabled: row.enabled,
        device_id: row.device_id,
        updated_at: new Date(),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

export const threadSession = async (db: Db, bindingId: string, chatId: string): Promise<string | undefined> =>
  (
    await db
      .selectFrom("channel_threads")
      .select("session_id")
      .where("binding_id", "=", bindingId)
      .where("external_chat_id", "=", chatId)
      .executeTakeFirst()
  )?.session_id;

/** Remember which session a chat talks to. Two messages racing to open it agree on the first. */
export async function openThread(db: Db, bindingId: string, chatId: string, sessionId: string): Promise<string> {
  await db
    .insertInto("channel_threads")
    .values({ binding_id: bindingId, external_chat_id: chatId, session_id: sessionId })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return (await threadSession(db, bindingId, chatId)) ?? sessionId;
}

export const closeThread = (db: Db, bindingId: string, chatId: string) =>
  db.deleteFrom("channel_threads").where("binding_id", "=", bindingId).where("external_chat_id", "=", chatId).execute();
