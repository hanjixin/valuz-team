import type { Kysely } from "kysely";

/**
 * An attachment can be a knowledge-base document instead of an upload: nothing
 * is kept in storage for it, it points at the document.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("attachments")
    .addColumn("kb_document_id", "uuid", (c) => c.references("kb_documents.id").onDelete("cascade"))
    .execute();
  await db.schema
    .alterTable("attachments")
    .alterColumn("storage_key", (c) => c.dropNotNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // A reference has no bytes to fall back on.
  await db
    .deleteFrom("attachments" as never)
    .where("storage_key" as never, "is", null)
    .execute();
  await db.schema
    .alterTable("attachments")
    .alterColumn("storage_key", (c) => c.setNotNull())
    .execute();
  await db.schema.alterTable("attachments").dropColumn("kb_document_id").execute();
}
