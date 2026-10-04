import { type Kysely, sql } from "kysely";

/** Projects and the agents deployed to them. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("projects")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull().defaultTo("project"))
    .addColumn("icon", "text")
    .addColumn("instructions_md", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("default_lead_agent_slug", "text")
    // The folder is on a device, not on the server.
    .addColumn("device_id", "uuid", (c) => c.references("devices.id").onDelete("set null"))
    .addColumn("root_path", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("projects_org").on("projects").column("org_id").execute();

  // A deployment is a live reference to the library agent, not a copy.
  await db.schema
    .createTable("project_members")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("project_id", "uuid", (c) => c.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("agent_id", "uuid", (c) => c.notNull().references("agents.id").onDelete("cascade"))
    // The handle the agent goes by inside this project.
    .addColumn("agent_slug", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("project_members_slug", ["project_id", "agent_slug"])
    .addUniqueConstraint("project_members_agent", ["project_id", "agent_id"])
    .execute();
  await db.schema.createIndex("project_members_agent_idx").on("project_members").column("agent_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("project_members").execute();
  await db.schema.dropTable("projects").execute();
}
