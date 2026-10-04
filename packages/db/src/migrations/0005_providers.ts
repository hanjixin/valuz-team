import { type Kysely, sql } from "kysely";

/** Model channels, and per-member settings (model defaults, preferences). */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("providers")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("provider_kind", "text", (c) => c.notNull())
    .addColumn("protocol", "text")
    .addColumn("base_url", "text")
    .addColumn("default_model", "text")
    // [{ id, label? }] — what the upstream offered, or what the owner typed for a custom endpoint.
    .addColumn("models", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    // The API key, sealed with the server's secret. Never leaves the server.
    .addColumn("secret_enc", "text")
    .addColumn("test_status", "text", (c) => c.notNull().defaultTo("never"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("providers_org").on("providers").column("org_id").execute();

  await db.schema
    .createTable("user_settings")
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("value", "jsonb", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addPrimaryKeyConstraint("user_settings_pkey", ["org_id", "user_id", "key"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("user_settings").execute();
  await db.schema.dropTable("providers").execute();
}
