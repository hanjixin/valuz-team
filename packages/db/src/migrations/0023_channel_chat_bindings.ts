import { type Kysely, sql } from "kysely";

/**
 * "This group is that project": a chat a bot is in, bound to a project. What is
 * said to the bot there becomes work in the project rather than a quick chat.
 * A chat holds one project.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("channel_chat_bindings")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    // The bot that is in the chat.
    .addColumn("binding_id", "uuid", (c) => c.notNull().references("channel_bindings.id").onDelete("cascade"))
    .addColumn("external_chat_id", "text", (c) => c.notNull())
    .addColumn("project_id", "uuid", (c) => c.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("external_chat_name", "text")
    // Who answers there, when not the bot's own agent.
    .addColumn("default_agent_slug", "text")
    // The bot made the group, so it owns it and may dissolve it.
    .addColumn("created_by_bot", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("channel_chat_bindings_chat", ["binding_id", "external_chat_id"])
    .execute();
  await db.schema
    .createIndex("channel_chat_bindings_project")
    .on("channel_chat_bindings")
    .column("project_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("channel_chat_bindings").execute();
}
