import { type Kysely, sql } from "kysely";

/**
 * What agents remember between sessions. `user` and `global` entries are a
 * member's own; `project` entries belong to the project and reach everyone who
 * works in it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("memories")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("target", "text", (c) => c.notNull().check(sql`target IN ('user', 'global', 'project')`))
    .addColumn("user_id", "uuid", (c) => c.references("users.id").onDelete("cascade"))
    .addColumn("project_id", "uuid", (c) => c.references("projects.id").onDelete("cascade"))
    .addColumn("content", "text", (c) => c.notNull())
    // Who wrote it: an agent's tool call, the background review, or a person.
    .addColumn("source", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "memories_scope",
      sql`(target = 'project' AND project_id IS NOT NULL) OR (target <> 'project' AND user_id IS NOT NULL)`,
    )
    .execute();
  await db.schema.createIndex("memories_member").on("memories").columns(["org_id", "user_id", "target"]).execute();
  await db.schema.createIndex("memories_project").on("memories").column("project_id").execute();

  // How far into a session the background review has read.
  await db.schema
    .createTable("memory_reviews")
    .addColumn("session_id", "uuid", (c) => c.primaryKey().references("sessions.id").onDelete("cascade"))
    .addColumn("reviewed_until", "bigint", (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("memory_reviews").execute();
  await db.schema.dropTable("memories").execute();
}
