import { type Kysely, sql } from "kysely";

/**
 * Goal-driven multi-agent tasks: a durable header that owns a plan (a DAG of
 * subtasks), the runs it spawned (each a session), an append-only timeline,
 * and a mailbox of messages waiting for the lead or a member.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("tasks")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("project_id", "uuid", (c) => c.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("device_id", "uuid", (c) => c.references("devices.id").onDelete("set null"))
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("goal", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status IN ('draft', 'active', 'paused', 'stopped', 'completed', 'blocked', 'abandoned')`),
    )
    .addColumn("lead_agent_slug", "text", (c) => c.notNull())
    .addColumn("lead_session_id", "uuid", (c) => c.references("sessions.id").onDelete("set null"))
    .addColumn("cwd", "text", (c) => c.notNull())
    .addColumn("plan", "jsonb", (c) => c.notNull().defaultTo(sql`'{"subtasks": []}'::jsonb`))
    .addColumn("plan_version", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("result", "jsonb")
    // Consecutive lead turns that ended with work outstanding and nothing in flight.
    .addColumn("idle_nudges", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("committed_at", "timestamptz")
    .addColumn("ended_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("tasks_project").on("tasks").columns(["project_id", "created_at desc"]).execute();
  await db.schema.createIndex("tasks_org").on("tasks").columns(["org_id", "updated_at desc"]).execute();

  // A run is one session working for the task: the lead, or one dispatch of a subtask.
  await db.schema
    .createTable("task_runs")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("task_id", "uuid", (c) => c.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("session_id", "uuid", (c) => c.notNull().unique().references("sessions.id").onDelete("cascade"))
    .addColumn("agent_slug", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind IN ('lead', 'subtask')`))
    .addColumn("subtask_key", "text")
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .defaultTo("active")
        .check(sql`status IN ('active', 'paused', 'completed', 'rejected', 'archived')`),
    )
    .addColumn("sequence", "serial", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("ended_at", "timestamptz")
    .execute();
  await db.schema.createIndex("task_runs_task").on("task_runs").columns(["task_id", "sequence"]).execute();

  await db.schema
    .createTable("task_events")
    .addColumn("seq", "bigserial", (c) => c.primaryKey())
    .addColumn("task_id", "uuid", (c) => c.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("actor", "text", (c) => c.notNull())
    .addColumn("session_id", "uuid")
    .addColumn("payload", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("task_events_task").on("task_events").columns(["task_id", "seq"]).execute();

  // Messages waiting for an actor (the lead or a member). Each is consumed exactly once.
  await db.schema
    .createTable("task_mailbox")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("task_id", "uuid", (c) => c.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("session_id", "uuid", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("text", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("payload", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("consumed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await sql`CREATE INDEX task_mailbox_pending ON task_mailbox (session_id, id) WHERE consumed_at IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["task_mailbox", "task_events", "task_runs", "tasks"]) await db.schema.dropTable(table).execute();
}
