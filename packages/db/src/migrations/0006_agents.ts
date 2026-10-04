import { type Kysely, sql } from "kysely";

/** The agent library: each agent's identity, working method, brain and equipment. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  const emptyList = sql`'[]'::jsonb`;
  await db.schema
    .createTable("agents")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("slug", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("description", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("instructions", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("runtime", "text", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("provider_id", "uuid", (c) => c.references("providers.id").onDelete("set null"))
    .addColumn("effort", "text")
    .addColumn("skills", "jsonb", (c) => c.notNull().defaultTo(emptyList))
    .addColumn("connector_types", "jsonb", (c) => c.notNull().defaultTo(emptyList))
    .addColumn("knowledge_scope", "jsonb", (c) => c.notNull().defaultTo(emptyList))
    .addColumn("inherit_global_instructions", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("permission_mode", "text", (c) => c.notNull().defaultTo("full_access"))
    .addColumn("avatar", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    // The slug is how an agent is addressed (URLs, @mentions), so it is unique in its organization.
    .addUniqueConstraint("agents_org_slug", ["org_id", "slug"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("agents").execute();
}
