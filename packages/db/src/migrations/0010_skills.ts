import { type Kysely, sql } from "kysely";

/** The skill library, and every content change of a skill so it can be inspected and restored. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("skills")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    // What agents refer to it by; unique in the organization.
    .addColumn("slug", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("description", "text", (c) => c.notNull().defaultTo(""))
    // [{ path, content }] — the whole package, SKILL.md included.
    .addColumn("files", "jsonb", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("creation_origin", "text", (c) => c.notNull().defaultTo("created"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("skills_org_slug", ["org_id", "slug"])
    .execute();

  await db.schema
    .createTable("skill_versions")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("skill_id", "uuid", (c) => c.notNull().references("skills.id").onDelete("cascade"))
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("description", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("files", "jsonb", (c) => c.notNull())
    .addColumn("created_by", "uuid", (c) => c.references("users.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("skill_versions_number", ["skill_id", "version"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("skill_versions").execute();
  await db.schema.dropTable("skills").execute();
}
