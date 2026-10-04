import { type Kysely, sql } from "kysely";

/**
 * The organization's knowledge bases. Unlike project files, these live on the
 * server: they are for every member and every device's agents, at any time.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  // Trigram matching: substring search that works for CJK as well as space-separated languages.
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  await db.schema
    .createTable("knowledge_bases")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("knowledge_bases_org").on("knowledge_bases").column("org_id").execute();

  await db.schema
    .createTable("kb_documents")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("kb_id", "uuid", (c) => c.notNull().references("knowledge_bases.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    // Where it sits inside the knowledge base: "reports/q3.pdf".
    .addColumn("relative_path", "text", (c) => c.notNull())
    .addColumn("filename", "text", (c) => c.notNull())
    .addColumn("mime_type", "text")
    .addColumn("size_bytes", "bigint", (c) => c.notNull())
    .addColumn("storage_key", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .defaultTo("queued")
        .check(sql`status IN ('queued', 'processing', 'ready', 'failed')`),
    )
    .addColumn("error", "text")
    // The full extracted text; chunks are only the search index over it.
    .addColumn("content", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("chunk_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("kb_documents_path", ["kb_id", "relative_path"])
    .execute();
  await db.schema.createIndex("kb_documents_org").on("kb_documents").column("org_id").execute();

  await db.schema
    .createTable("kb_chunks")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("document_id", "uuid", (c) => c.notNull().references("kb_documents.id").onDelete("cascade"))
    .addColumn("ord", "integer", (c) => c.notNull())
    .addColumn("content", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("kb_chunks_document").on("kb_chunks").columns(["document_id", "ord"]).execute();
  await sql`CREATE INDEX kb_chunks_trgm ON kb_chunks USING gin (content gin_trgm_ops)`.execute(db);

  // One batch of parsing, so its progress can be followed.
  await db.schema
    .createTable("kb_tasks")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("kb_id", "uuid", (c) => c.references("knowledge_bases.id").onDelete("cascade"))
    .addColumn("task_type", "text", (c) => c.notNull())
    .addColumn("total_items", "integer", (c) => c.notNull())
    .addColumn("processed_items", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("failed_items", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();

  // What a project's agents may consult. No rows = everything in the organization.
  await db.schema
    .createTable("project_kb_bindings")
    .addColumn("project_id", "uuid", (c) => c.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("binding_kind", "text", (c) => c.notNull().check(sql`binding_kind IN ('kb', 'folder', 'document')`))
    .addColumn("target_id", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("project_kb_bindings_pkey", ["project_id", "binding_kind", "target_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["project_kb_bindings", "kb_tasks", "kb_chunks", "kb_documents", "knowledge_bases"])
    await db.schema.dropTable(table).execute();
}
