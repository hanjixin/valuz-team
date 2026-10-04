import { type Kysely, sql } from "kysely";

/**
 * The built-in assistant. Every member has one of their own, all under the same
 * slug — so a slug is unique in the organization among the agents people make,
 * and the built-in is one per member.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("agents")
    .addColumn("kind", "text", (c) => c.notNull().defaultTo("standard"))
    .execute();
  await db.schema.alterTable("agents").dropConstraint("agents_org_slug").execute();
  // Assistants the first-run tour made before they were built in: the first per member becomes theirs.
  await sql`
    UPDATE agents SET kind = 'system', slug = 'valurion'
    WHERE id IN (
      SELECT DISTINCT ON (org_id, owner_id) id FROM agents
      WHERE slug = 'valurion' OR slug = 'valurion-' || left(owner_id::text, 6)
      ORDER BY org_id, owner_id, created_at
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX agents_org_slug ON agents (org_id, slug) WHERE kind = 'standard'`.execute(db);
  await sql`CREATE UNIQUE INDEX agents_builtin_owner ON agents (org_id, owner_id) WHERE kind = 'system'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX agents_builtin_owner`.execute(db);
  await sql`DROP INDEX agents_org_slug`.execute(db);
  // Back to one slug per organization: each built-in takes a slug of its member's own.
  await sql`UPDATE agents SET slug = 'valurion-' || left(owner_id::text, 6) WHERE kind = 'system'`.execute(db);
  await db.schema.alterTable("agents").addUniqueConstraint("agents_org_slug", ["org_id", "slug"]).execute();
  await db.schema.alterTable("agents").dropColumn("kind").execute();
}
