import { type Kysely, sql } from "kysely";

/** Connectors: MCP servers an agent can call. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("connectors")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    // What agents refer to it by, and the prefix of its tools' names.
    .addColumn("slug", "text", (c) => c.notNull())
    .addColumn("display_name", "text", (c) => c.notNull())
    .addColumn("description", "text")
    .addColumn("transport", "text", (c) => c.notNull())
    .addColumn("auth_type", "text", (c) => c.notNull().defaultTo("none"))
    // Everything that is not a secret: url, command, args, working_dir, and the
    // headers / params / env entries (a secret entry is listed here without its value).
    .addColumn("config", "jsonb", (c) => c.notNull())
    // The secret values, sealed: { "headers:Authorization": "…", "env:API_KEY": "…" }.
    .addColumn("secret_enc", "text")
    .addColumn("enabled", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("status", "text", (c) => c.notNull().defaultTo("untested"))
    .addColumn("tool_count", "integer")
    .addColumn("last_tested_at", "timestamptz")
    .addColumn("error_message", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("connectors_org_slug", ["org_id", "slug"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("connectors").execute();
}
