import { type Kysely, sql } from "kysely";

/** Files members attach to messages: kept in storage, then delivered to the session's device. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("attachments")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    // Null while staged: uploaded, not yet part of a message.
    .addColumn("session_id", "uuid", (c) => c.references("sessions.id").onDelete("cascade"))
    .addColumn("file_name", "text", (c) => c.notNull())
    .addColumn("size_bytes", "bigint", (c) => c.notNull())
    .addColumn("mime_type", "text")
    .addColumn("storage_key", "text", (c) => c.notNull())
    // Where the device put it, once delivered.
    .addColumn("device_path", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("consumed_at", "timestamptz")
    .execute();
  await db.schema.createIndex("attachments_session").on("attachments").column("session_id").execute();
  await db.schema.createIndex("attachments_staged").on("attachments").columns(["owner_id", "org_id"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("attachments").execute();
}
