import { type Kysely, sql } from "kysely";

/** A member's inbox, and what people said about individual turns. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("notifications")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("body", "text", (c) => c.notNull().defaultTo(""))
    // Where clicking it leads, inside the app.
    .addColumn("route", "text")
    .addColumn("action", "text", (c) => c.notNull().defaultTo("none"))
    .addColumn("urgency", "text", (c) => c.notNull().defaultTo("info"))
    .addColumn("project_id", "uuid")
    .addColumn("session_id", "uuid")
    .addColumn("payload", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("read_at", "timestamptz")
    // Dismissed, or no longer needing anything: out of the inbox, still in the history.
    .addColumn("resolved_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("notifications_inbox")
    .on("notifications")
    .columns(["user_id", "org_id", "created_at desc"])
    .execute();

  await db.schema
    .createTable("message_feedback")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("session_id", "uuid", (c) => c.notNull().references("sessions.id").onDelete("cascade"))
    .addColumn("message_id", "uuid", (c) => c.notNull())
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("action", "text", (c) => c.notNull())
    // "" is the whole turn; otherwise a block inside it (a code block, an artifact).
    .addColumn("block_ref", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("value", "text")
    .addColumn("reason_code", "text")
    .addColumn("reason", "text")
    .addColumn("source", "text", (c) => c.notNull().defaultTo("api"))
    .addColumn("surface", "text")
    .addColumn("occurrences", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("metadata", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    // One row per person, turn, kind of action and block: doing it again updates it.
    .addUniqueConstraint("message_feedback_once", ["user_id", "message_id", "action", "block_ref"])
    .execute();
  await db.schema.createIndex("message_feedback_session").on("message_feedback").column("session_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("message_feedback").execute();
  await db.schema.dropTable("notifications").execute();
}
