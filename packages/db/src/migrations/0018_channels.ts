import { type Kysely, sql } from "kysely";

/** An IM bot bound to an agent: people talk to the agent from the chat app, and each chat is a session. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("channel_bindings")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    // Conversations started from the chat app are this member's, on their device.
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("platform", "text", (c) => c.notNull())
    .addColumn("agent_slug", "text", (c) => c.notNull())
    .addColumn("app_id", "text", (c) => c.notNull())
    // Sealed JSON: app_secret, and for the HTTP callback a verification token and/or encrypt key.
    .addColumn("secret_enc", "text", (c) => c.notNull())
    .addColumn("enabled", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("channel_bindings_agent", ["org_id", "platform", "agent_slug"])
    .execute();

  // Which session a chat talks to. Removing the row starts the chat afresh.
  await db.schema
    .createTable("channel_threads")
    .addColumn("binding_id", "uuid", (c) => c.notNull().references("channel_bindings.id").onDelete("cascade"))
    .addColumn("external_chat_id", "text", (c) => c.notNull())
    .addColumn("session_id", "uuid", (c) => c.notNull().references("sessions.id").onDelete("cascade"))
    .addPrimaryKeyConstraint("channel_threads_pkey", ["binding_id", "external_chat_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("channel_threads").execute();
  await db.schema.dropTable("channel_bindings").execute();
}
