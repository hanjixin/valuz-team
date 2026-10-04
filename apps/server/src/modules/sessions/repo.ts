import type { Db } from "@agent-base/db";
import { sql } from "kysely";
import type { Auth } from "../../infra/context.ts";
import { permissionOf } from "../sharing/service.ts";
import type { StoredEventRow } from "./translate.ts";

// -- Sessions --

const withPermission = (db: Db, auth: Auth) =>
  db
    .selectFrom("sessions as r")
    .selectAll("r")
    .select(permissionOf(auth, "session", "r").as("permission"))
    .where("r.org_id", "=", auth.orgId);

export type SessionRow = NonNullable<Awaited<ReturnType<typeof find>>>;

export const find = (db: Db, auth: Auth, id: string) =>
  withPermission(db, auth).where("r.id", "=", id).executeTakeFirst();

/** Sessions the caller owns or was given, plus every session in the projects listed. */
export function list(db: Db, auth: Auth, projectIds: string[], filter: { projectId?: string; q?: string }) {
  let query = withPermission(db, auth)
    .where((eb) =>
      eb.or([
        sql<boolean>`${permissionOf(auth, "session", "r")} IS NOT NULL`,
        ...(projectIds.length ? [eb("r.project_id", "in", projectIds)] : []),
      ]),
    )
    .orderBy("r.updated_at", "desc")
    .limit(500);
  if (filter.projectId) query = query.where("r.project_id", "=", filter.projectId);
  if (filter.q) query = query.where("r.name", "ilike", `%${filter.q.replace(/[%_\\]/g, "\\$&")}%`);
  return query.execute();
}

export interface NewSession {
  id: string;
  org_id: string;
  owner_id: string;
  project_id: string;
  device_id: string;
  agent_id: string | null;
  agent_slug: string | null;
  provider_id: string | null;
  name: string | null;
  runtime_provider: string;
  model: string;
  cwd: string;
  effort: string | null;
  permission_mode: string;
  /** What the session is for, beyond a conversation — e.g. its role in a task. */
  metadata?: Record<string, unknown>;
}

export const insert = async (db: Db, row: NewSession): Promise<void> =>
  void (await db
    .insertInto("sessions")
    .values({ ...row, metadata: JSON.stringify(row.metadata ?? {}) })
    .execute());

export const rename = async (db: Db, id: string, name: string): Promise<void> =>
  void (await db.updateTable("sessions").set({ name, updated_at: new Date() }).where("id", "=", id).execute());

export const remove = async (db: Db, id: string): Promise<void> =>
  void (await db.deleteFrom("sessions").where("id", "=", id).execute());

export const byId = (db: Db, id: string) =>
  db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();

/**
 * The status flip is the lock: only one sender can move a session to `running`.
 * Returns the status it had — what to put back if the turn does not start — or
 * null when it was already running. Read and written in one statement, so the
 * status handed back is never another claimant's transient `running`.
 */
export async function claimForTurn(db: Db, id: string): Promise<string | null> {
  const { rows } = await sql<{ previous: string }>`
    UPDATE sessions AS s SET status = 'running', stop_reason = NULL, updated_at = now()
      FROM (SELECT id, status FROM sessions WHERE id = ${id}::uuid FOR UPDATE) AS before
     WHERE s.id = before.id AND before.status <> 'running'
    RETURNING before.status AS previous`.execute(db);
  return rows[0]?.previous ?? null;
}

/** Remember what was last said, and name a session that has no name yet after it. */
export const noteUserMessage = async (db: Db, id: string, text: string, name: string): Promise<void> =>
  void (await db
    .updateTable("sessions")
    .set((eb) => ({ last_user_message_text: text, name: eb.fn.coalesce("name", eb.val(name)) }))
    .where("id", "=", id)
    .execute());

export const setStatus = async (db: Db, id: string, status: string): Promise<void> =>
  void (await db.updateTable("sessions").set({ status, updated_at: new Date() }).where("id", "=", id).execute());

/** Change how the session runs from its next turn on. */
export const setControls = async (
  db: Db,
  id: string,
  controls: { permission_mode?: string; mode?: string; effort?: string | null },
): Promise<void> =>
  void (await db
    .updateTable("sessions")
    .set({ ...controls, updated_at: new Date() })
    .where("id", "=", id)
    .execute());

export const setQueuePaused = async (db: Db, id: string, paused: boolean): Promise<void> =>
  void (await db.updateTable("sessions").set({ queue_paused: paused }).where("id", "=", id).execute());

export interface SessionPatch {
  status?: string;
  stop_reason?: unknown;
  runtime_session_id?: string | null;
  todos?: unknown;
  mode?: string;
}

/** Apply what the device reports — only to a session that runs on that device. */
export async function applyPatch(db: Db, deviceId: string, id: string, patch: SessionPatch): Promise<string | null> {
  const row = await db
    .updateTable("sessions")
    .set({
      updated_at: new Date(),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.stop_reason !== undefined ? { stop_reason: JSON.stringify(patch.stop_reason) } : {}),
      ...(patch.runtime_session_id !== undefined ? { runtime_session_id: patch.runtime_session_id } : {}),
      ...(patch.todos !== undefined ? { todos: JSON.stringify(patch.todos) } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    })
    .where("id", "=", id)
    .where("device_id", "=", deviceId)
    .returning("org_id")
    .executeTakeFirst();
  return row?.org_id ?? null;
}

/** The organization of a session that runs on this device — undefined when it does not. */
export const orgOfSessionOn = async (db: Db, deviceId: string, sessionId: string): Promise<string | undefined> =>
  (
    await db
      .selectFrom("sessions")
      .select("org_id")
      .where("id", "=", sessionId)
      .where("device_id", "=", deviceId)
      .executeTakeFirst()
  )?.org_id;

/** Sessions the server believes are running on a device, other than the ones it says it still has. */
export const strandedOn = async (db: Db, deviceId: string, stillRunning: string[]): Promise<string[]> =>
  (
    await db
      .selectFrom("sessions")
      .select("id")
      .where("device_id", "=", deviceId)
      .where("status", "=", "running")
      .$if(stillRunning.length > 0, (qb) => qb.where("id", "not in", stillRunning))
      .execute()
  ).map((row) => row.id);

// -- Messages (turns) --

export const insertMessage = async (
  db: Db,
  message: { id: string; session_id: string; actor_id: string; user_message: unknown; started_at: number },
): Promise<void> =>
  void (await db
    .insertInto("messages")
    .values({ ...message, user_message: JSON.stringify(message.user_message) })
    .execute());

/** The turns that finished after `since`, oldest first: what was asked and what was answered. */
export const completedTurnsSince = (db: Db, sessionId: string, since: number, limit: number) =>
  db
    .selectFrom("messages")
    .select(["user_message", "assistant_message", "ended_at"])
    .where("session_id", "=", sessionId)
    .where("status", "=", "completed")
    .where("ended_at", ">", since)
    .orderBy("ended_at")
    .limit(limit)
    .execute();

export const deleteMessage = async (db: Db, id: string): Promise<void> =>
  void (await db.deleteFrom("messages").where("id", "=", id).execute());

export interface TurnState {
  id: string;
  session_id: string;
  user_message: unknown;
  status: string;
  assistant_message: string | null;
  error_message: unknown;
  stop_reason: unknown;
  total_turns: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  model_usage: unknown;
  metadata: unknown;
  todos: unknown;
  started_at: number;
  ended_at: number | null;
}

const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

/** The device's final (or progressing) word on a turn. */
export async function upsertMessage(db: Db, m: TurnState): Promise<void> {
  const state = {
    status: m.status,
    assistant_message: m.assistant_message,
    error_message: json(m.error_message),
    stop_reason: json(m.stop_reason),
    total_turns: m.total_turns,
    input_tokens: m.input_tokens,
    output_tokens: m.output_tokens,
    cache_read_tokens: m.cache_read_tokens,
    cache_write_tokens: m.cache_write_tokens,
    model_usage: json(m.model_usage),
    metadata: JSON.stringify(m.metadata ?? {}),
    todos: json(m.todos),
    ended_at: m.ended_at,
  };
  await db
    .insertInto("messages")
    .values({
      id: m.id,
      session_id: m.session_id,
      user_message: JSON.stringify(m.user_message),
      started_at: m.started_at,
      ...state,
    })
    .onConflict((oc) => oc.column("id").doUpdateSet(state))
    .execute();
}

/** Turns still marked running in a session: they died with the device's previous process. */
export const failRunningMessages = async (
  db: Db,
  sessionId: string,
  error: Record<string, unknown>,
): Promise<string[]> =>
  (
    await db
      .updateTable("messages")
      .set({ status: "errored", ended_at: Date.now(), error_message: JSON.stringify(error) })
      .where("session_id", "=", sessionId)
      .where("status", "=", "running")
      .returning("id")
      .execute()
  ).map((row) => row.id);

export async function usageTotals(db: Db, sessionId: string): Promise<number> {
  const row = await db
    .selectFrom("messages")
    .select(
      sql<number>`COALESCE(sum(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_tokens,0)), 0)::bigint`.as(
        "total",
      ),
    )
    .where("session_id", "=", sessionId)
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

// -- Events --

const EVENT_COLUMNS = ["seq", "message_id", "type", "data", "ts", "event_uid"] as const;

/** Store an event once. Returns null when this uid was already stored (a frame sent again). */
export async function appendEvent(
  db: Db,
  event: { session_id: string; message_id: string; type: string; data: unknown; ts: number; event_uid: string },
): Promise<StoredEventRow | null> {
  const row = await db
    .insertInto("events")
    .values({ ...event, data: JSON.stringify(event.data) })
    .onConflict((oc) => oc.column("event_uid").doNothing())
    .returning(EVENT_COLUMNS)
    .executeTakeFirst();
  return row ?? null;
}

export const eventsAfter = (db: Db, sessionId: string, afterSeq: number, limit: number): Promise<StoredEventRow[]> =>
  db
    .selectFrom("events")
    .select(EVENT_COLUMNS)
    .where("session_id", "=", sessionId)
    .where("seq", ">", afterSeq)
    .orderBy("seq")
    .limit(limit)
    .execute();

/**
 * The events of the last `turnLimit` turns before `beforeSeq`, oldest first,
 * and whether an earlier turn exists. A turn is never cut in half.
 */
export async function eventWindow(
  db: Db,
  sessionId: string,
  beforeSeq: number | undefined,
  turnLimit: number,
): Promise<{ rows: StoredEventRow[]; hasMore: boolean }> {
  let turns = db
    .selectFrom("events")
    .select(["message_id", (eb) => eb.fn.min("seq").as("first_seq")])
    .where("session_id", "=", sessionId)
    .groupBy("message_id")
    .orderBy("first_seq", "desc")
    .limit(turnLimit + 1);
  if (beforeSeq !== undefined) turns = turns.having((eb) => eb.fn.min("seq"), "<", beforeSeq);
  const found = await turns.execute();
  const kept = found.slice(0, turnLimit);
  if (kept.length === 0) return { rows: [], hasMore: false };
  const rows = await db
    .selectFrom("events")
    .select(EVENT_COLUMNS)
    .where("session_id", "=", sessionId)
    .where(
      "message_id",
      "in",
      kept.map((turn) => turn.message_id),
    )
    .orderBy("seq")
    .execute();
  return { rows, hasMore: found.length > turnLimit };
}

export const lastSeq = async (db: Db, sessionId: string): Promise<number> =>
  (
    await db
      .selectFrom("events")
      .select((eb) => eb.fn.max("seq").as("seq"))
      .where("session_id", "=", sessionId)
      .executeTakeFirst()
  )?.seq ?? 0;

// -- Queued input --

export const listQueue = (db: Db, sessionId: string) =>
  db.selectFrom("queued_inputs").selectAll().where("session_id", "=", sessionId).orderBy("position").execute();

export const enqueue = async (db: Db, item: { id: string; session_id: string; actor_id: string; text: string }) =>
  void (await db.insertInto("queued_inputs").values(item).execute());

export const editQueued = async (db: Db, sessionId: string, id: string, text: string): Promise<boolean> =>
  (
    await db
      .updateTable("queued_inputs")
      .set({ text, updated_at: new Date() })
      .where("session_id", "=", sessionId)
      .where("id", "=", id)
      .executeTakeFirst()
  ).numUpdatedRows > 0n;

export const deleteQueued = async (db: Db, sessionId: string, id: string): Promise<boolean> =>
  (await db.deleteFrom("queued_inputs").where("session_id", "=", sessionId).where("id", "=", id).executeTakeFirst())
    .numDeletedRows > 0n;

/** Move a queued input to the front of the queue. */
export const promoteQueued = async (db: Db, sessionId: string, id: string): Promise<boolean> =>
  (
    await db
      .updateTable("queued_inputs")
      .set((eb) => ({
        position: eb
          .selectFrom("queued_inputs as q")
          .select((sub) => sql<number>`${sub.fn.min("q.position")} - 1`.as("front"))
          .where("q.session_id", "=", sessionId),
      }))
      .where("session_id", "=", sessionId)
      .where("id", "=", id)
      .executeTakeFirst()
  ).numUpdatedRows > 0n;

/** Take the next queued input off the queue, with the name of whoever queued it. */
export async function takeNextQueued(db: Db, sessionId: string) {
  return db
    .deleteFrom("queued_inputs")
    .where("id", "=", (eb) =>
      eb
        .selectFrom("queued_inputs")
        .select("id")
        .where("session_id", "=", sessionId)
        .orderBy("position")
        .limit(1)
        .forUpdate()
        .skipLocked(),
    )
    .returning(["id", "text", "actor_id", "position", "created_at"])
    .executeTakeFirst();
}

/** Put an input that could not be sent back where it was. */
export const restoreQueued = async (
  db: Db,
  item: { id: string; session_id: string; actor_id: string; text: string; position: number; created_at: Date },
): Promise<void> => void (await db.insertInto("queued_inputs").values(item).execute());

export const userName = async (db: Db, userId: string): Promise<string> =>
  (await db.selectFrom("users").select("name").where("id", "=", userId).executeTakeFirst())?.name ?? "";

/** The event types that mark a run starting, changing status, or ending. */
export const LIFECYCLE_TYPES = ["user_message", "session_idle", "session_error", "session_update"] as const;

/** Lifecycle events, after a cursor, across the sessions the caller owns, was given, or can see through a project. */
export function lifecycleAfter(db: Db, auth: Auth, projectIds: string[], afterSeq: number, limit: number) {
  return db
    .selectFrom("events as e")
    .innerJoin("sessions as r", "r.id", "e.session_id")
    .select(["e.seq", "e.session_id", "e.message_id", "e.type", "e.data", "e.ts", "e.event_uid"])
    .where("r.org_id", "=", auth.orgId)
    .where("e.seq", ">", afterSeq)
    .where("e.type", "in", [...LIFECYCLE_TYPES])
    .where((eb) =>
      eb.or([
        sql<boolean>`${permissionOf(auth, "session", "r")} IS NOT NULL`,
        ...(projectIds.length ? [eb("r.project_id", "in", projectIds)] : []),
      ]),
    )
    .orderBy("e.seq")
    .limit(limit)
    .execute();
}
