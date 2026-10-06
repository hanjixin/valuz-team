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

// -- Chats bound to projects --

export type ChatBindingRow = NonNullable<Awaited<ReturnType<typeof chatBinding>>>;

/** The project a chat stands for, if it was bound to one. */
export const chatBinding = (db: Db, bindingId: string, chatId: string) =>
  db
    .selectFrom("channel_chat_bindings as c")
    .innerJoin("channel_bindings as b", "b.id", "c.binding_id")
    .selectAll("c")
    .select("b.platform")
    .where("c.binding_id", "=", bindingId)
    .where("c.external_chat_id", "=", chatId)
    .executeTakeFirst();

/** Every bound chat in an organization; by project when one is named. Ordered by name, as the picker is. */
export const chatBindings = (db: Db, orgId: string, projectId?: string) => {
  let query = db
    .selectFrom("channel_chat_bindings as c")
    .innerJoin("channel_bindings as b", "b.id", "c.binding_id")
    .selectAll("c")
    .select(["b.platform", "b.owner_id as bot_owner_id"])
    .where("c.org_id", "=", orgId);
  if (projectId) query = query.where("c.project_id", "=", projectId);
  return query.orderBy("c.external_chat_name").execute();
};

/** Bind a chat to a project. A chat holds one project: binding it again moves it. */
export const bindChat = (
  db: Db,
  row: {
    org_id: string;
    binding_id: string;
    external_chat_id: string;
    project_id: string;
    external_chat_name: string | null;
    default_agent_slug: string | null;
    created_by_bot?: boolean;
  },
) =>
  db
    .insertInto("channel_chat_bindings")
    .values({ ...row, id: crypto.randomUUID() })
    .onConflict((oc) =>
      oc.columns(["binding_id", "external_chat_id"]).doUpdateSet({
        project_id: row.project_id,
        default_agent_slug: row.default_agent_slug,
        ...(row.external_chat_name ? { external_chat_name: row.external_chat_name } : {}),
        ...(row.created_by_bot ? { created_by_bot: true } : {}),
      }),
    )
    .execute();

export const unbindChat = async (db: Db, bindingId: string, chatId: string): Promise<boolean> =>
  Number(
    (
      await db
        .deleteFrom("channel_chat_bindings")
        .where("binding_id", "=", bindingId)
        .where("external_chat_id", "=", chatId)
        .executeTakeFirst()
    ).numDeletedRows,
  ) > 0;

/** A member's own enabled bot on a platform: the one bound to `agentSlug`, or their first. */
export const ownBot = (db: Db, orgId: string, ownerId: string, platform: string, agentSlug?: string) => {
  let query = db
    .selectFrom("channel_bindings")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("owner_id", "=", ownerId)
    .where("platform", "=", platform)
    .where("enabled", "=", true);
  if (agentSlug) query = query.where("agent_slug", "=", agentSlug);
  return query.orderBy("created_at").executeTakeFirst();
};
