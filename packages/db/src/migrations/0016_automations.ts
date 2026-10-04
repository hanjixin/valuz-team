import { type Kysely, sql } from "kysely";

/** Work an agent does on a schedule or when asked, and the record of each time it ran. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("automations")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    // Runs happen as this member: their devices, their model channels, their sessions.
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("project_id", "uuid", (c) => c.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("agent_kind", "text")
    .addColumn("agent_slug", "text")
    .addColumn("action_kind", "text", (c) => c.notNull().check(sql`action_kind IN ('chat', 'task')`))
    .addColumn("prompt_template", "text", (c) => c.notNull())
    // { kind: cron, cron_expr, timezone } | { kind: interval, seconds } | { kind: manual }
    .addColumn("trigger", "jsonb", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .defaultTo("enabled")
        .check(sql`status IN ('enabled', 'paused')`),
    )
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("automations_project").on("automations").column("project_id").execute();

  await db.schema
    .createTable("automation_runs")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("automation_id", "uuid", (c) => c.notNull().references("automations.id").onDelete("cascade"))
    .addColumn("trigger_type", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("input", "jsonb")
    .addColumn("result_summary", "text")
    .addColumn("error_code", "text")
    .addColumn("error_message", "text")
    // What the run started. Either may be deleted later; the run's record stays.
    .addColumn("session_id", "uuid", (c) => c.references("sessions.id").onDelete("set null"))
    .addColumn("task_id", "uuid", (c) => c.references("tasks.id").onDelete("set null"))
    .addColumn("triggered_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("started_at", "timestamptz")
    .addColumn("completed_at", "timestamptz")
    .addColumn("cancel_requested_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("automation_runs_automation")
    .on("automation_runs")
    .columns(["automation_id", "triggered_at"])
    .execute();
  await db.schema.createIndex("automation_runs_session").on("automation_runs").column("session_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("automation_runs").execute();
  await db.schema.dropTable("automations").execute();
}
