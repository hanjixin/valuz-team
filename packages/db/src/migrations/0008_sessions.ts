import { type Kysely, sql } from "kysely";

/** Sessions, their turns, the event log, and input waiting for a turn to finish. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("sessions")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("owner_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("project_id", "uuid", (c) => c.notNull().references("projects.id").onDelete("cascade"))
    // Where it runs. A session whose device is gone can still be read, not continued.
    .addColumn("device_id", "uuid", (c) => c.references("devices.id").onDelete("set null"))
    .addColumn("agent_id", "uuid", (c) => c.references("agents.id").onDelete("set null"))
    .addColumn("agent_slug", "text")
    .addColumn("provider_id", "uuid", (c) => c.references("providers.id").onDelete("set null"))
    .addColumn("name", "text")
    .addColumn("runtime_provider", "text", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("cwd", "text", (c) => c.notNull())
    .addColumn("effort", "text")
    .addColumn("permission_mode", "text", (c) => c.notNull().defaultTo("full_access"))
    .addColumn("mode", "text", (c) => c.notNull().defaultTo("default"))
    .addColumn("status", "text", (c) => c.notNull().defaultTo("created"))
    .addColumn("origin", "text", (c) => c.notNull().defaultTo("user"))
    .addColumn("stop_reason", "jsonb")
    .addColumn("runtime_session_id", "text")
    .addColumn("todos", "jsonb")
    .addColumn("metadata", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("last_user_message_text", "text")
    // After an interrupt, queued input waits for the person to say "go on".
    .addColumn("queue_paused", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("sessions_org_updated").on("sessions").columns(["org_id", "updated_at desc"]).execute();
  await db.schema.createIndex("sessions_project").on("sessions").column("project_id").execute();
  await db.schema.createIndex("sessions_device").on("sessions").column("device_id").execute();

  await db.schema
    .createTable("messages")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("session_id", "uuid", (c) => c.notNull().references("sessions.id").onDelete("cascade"))
    // Who sent it — in a shared session, not necessarily the session's owner.
    .addColumn("actor_id", "uuid", (c) => c.references("users.id"))
    .addColumn("user_message", "jsonb", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("running"))
    .addColumn("assistant_message", "text")
    .addColumn("error_message", "jsonb")
    .addColumn("stop_reason", "jsonb")
    .addColumn("total_turns", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("input_tokens", "bigint")
    .addColumn("output_tokens", "bigint")
    .addColumn("cache_read_tokens", "bigint")
    .addColumn("cache_write_tokens", "bigint")
    .addColumn("model_usage", "jsonb")
    .addColumn("metadata", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("todos", "jsonb")
    .addColumn("started_at", "bigint", (c) => c.notNull())
    .addColumn("ended_at", "bigint")
    .execute();
  await db.schema.createIndex("messages_session").on("messages").columns(["session_id", "started_at"]).execute();

  await db.schema
    .createTable("events")
    // The global, gap-tolerant cursor clients page and resume by.
    .addColumn("seq", "bigserial", (c) => c.primaryKey())
    .addColumn("session_id", "uuid", (c) => c.notNull().references("sessions.id").onDelete("cascade"))
    .addColumn("message_id", "uuid", (c) => c.notNull())
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("data", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("ts", "bigint", (c) => c.notNull())
    // The host's id for the event: a frame delivered twice is stored once.
    .addColumn("event_uid", "uuid", (c) => c.notNull().unique())
    .execute();
  await db.schema.createIndex("events_session_seq").on("events").columns(["session_id", "seq"]).execute();

  await db.schema
    .createTable("queued_inputs")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("session_id", "uuid", (c) => c.notNull().references("sessions.id").onDelete("cascade"))
    .addColumn("actor_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("text", "text", (c) => c.notNull())
    .addColumn("position", "bigserial", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("queued_inputs_session")
    .on("queued_inputs")
    .columns(["session_id", "position"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["queued_inputs", "events", "messages", "sessions"]) await db.schema.dropTable(table).execute();
}
