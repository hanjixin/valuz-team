import { type Kysely, sql } from "kysely";

/** Instance-level key/value facts (schema generation, install id, …). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("app_meta")
    .addColumn("key", "text", (c) => c.primaryKey())
    .addColumn("value", "jsonb", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("app_meta").execute();
}
