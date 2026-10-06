import { type Kysely, sql } from "kysely";

/**
 * What a memory scope held before it was rewritten as a whole — consolidated,
 * or restored. Consolidating loses detail on purpose; this is the way back.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("memory_snapshots")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("target", "text", (c) => c.notNull().check(sql`target IN ('user', 'global', 'project')`))
    .addColumn("user_id", "uuid", (c) => c.references("users.id").onDelete("cascade"))
    .addColumn("project_id", "uuid", (c) => c.references("projects.id").onDelete("cascade"))
    // The entries as they were: [{content, source, created_at}], oldest first.
    .addColumn("entries", "jsonb", (c) => c.notNull())
    // Why the scope was rewritten: consolidated, or restored.
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex("memory_snapshots_scope")
    .on("memory_snapshots")
    .columns(["org_id", "target", "user_id", "project_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("memory_snapshots").execute();
}
