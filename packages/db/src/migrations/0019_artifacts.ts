import { type Kysely, sql } from "kysely";

/**
 * What agents delivered. Only the record is kept here: a deliverable is a file
 * on a device, and each time an agent delivers it again is a new version.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("artifacts")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("project_id", "uuid", (c) => c.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("device_id", "uuid", (c) => c.references("devices.id").onDelete("set null"))
    // Where the file is on that device. One deliverable per path in a project.
    .addColumn("file_path", "text", (c) => c.notNull())
    .addColumn("display_name", "text", (c) => c.notNull())
    .addColumn("version_no", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("artifacts_path", ["project_id", "file_path"])
    .execute();

  await db.schema
    .createTable("artifact_revisions")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("artifact_id", "uuid", (c) => c.notNull().references("artifacts.id").onDelete("cascade"))
    .addColumn("version_no", "integer", (c) => c.notNull())
    .addColumn("session_id", "uuid", (c) => c.references("sessions.id").onDelete("set null"))
    .addColumn("file_size", "bigint", (c) => c.notNull())
    .addColumn("mime_type", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("artifact_revisions_session").on("artifact_revisions").column("session_id").execute();
  await db.schema.createIndex("artifact_revisions_artifact").on("artifact_revisions").column("artifact_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("artifact_revisions").execute();
  await db.schema.dropTable("artifacts").execute();
}
