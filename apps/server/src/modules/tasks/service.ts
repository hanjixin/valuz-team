/**
 * Tasks — goal-driven multi-agent work. A task owns a plan (a DAG of subtasks)
 * and a set of runs (sessions on a device). Its lead drives
 * `plan → dispatch → await → review → finish` through the task toolkit;
 * members just work and report with their final message.
 *
 * Three things move a task forward, and each has exactly one entry point here:
 *
 *   a tool call from the lead      → `callTool`
 *   a turn ending on a device      → `handleTurnEnd`
 *   a person intervening           → `intervene` / `inject` / `commit`
 *
 * Every plan write happens inside `mutate` (row lock + transition tables);
 * anything that talks to a device runs after the transaction commits.
 */
import type { Db } from "@agent-base/db";
import type { Actor } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { type Selectable, sql } from "kysely";
import type { Database } from "@agent-base/db";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, badRequest, conflict, notFound } from "../../infra/errors.ts";
import { ToolError, toolkitServer } from "../../infra/toolkit.ts";
import * as members from "../agents/members.ts";
import * as notifications from "../notifications/service.ts";
import { type TurnEnd, type TurnExtras, dispatchTurn } from "../sessions/dispatch.ts";
import * as sessions from "../sessions/service.ts";
import { PlanError, type Subtask, TaskPlan, TaskStateError, type TaskStatus, assertTaskTransition } from "./plan.ts";
import {
  LEAD_PROTOCOL,
  MEMBER_PROTOCOL,
  type MailboxItem,
  TASK_TOOLKIT,
  type TaskRole,
  kickoffText,
  memberBrief,
  renderInbox,
  roleMetadata,
  roleOf,
} from "./prompts.ts";

// Timeline event names are the ones the task UI already knows (`committed`,
// `task_planned`, `subtask_spawned`, `subtask_reviewed`, …) — see TaskEventType
// in packages/core/src/api/tasks-api.ts.
export const taskChannel = (taskId: string): string => `task:${taskId}`;
const wakeChannel = (taskId: string): string => `task:${taskId}:wake`;

const MAX_IDLE_NUDGES = 2;
const SUMMARY_LIMIT = 8000;

export type TaskRow = Selectable<Database["tasks"]>;
export type TaskEventRow = Selectable<Database["task_events"]>;

interface Scope {
  tx: Db;
  task: TaskRow;
  plan: TaskPlan;
  /** Record a timeline event (published after commit). */
  event(type: string, actor: string, payload?: Record<string, unknown>, sessionId?: string | null): Promise<void>;
  /** Run once the transaction has committed — device calls go here. */
  after(fn: () => Promise<unknown>): void;
  setStatus(
    status: TaskStatus,
    extra?: { committed_at?: Date; ended_at?: Date | null; result?: unknown },
  ): Promise<void>;
  mailbox(sessionId: string, kind: string, text: string, payload?: Record<string, unknown>): Promise<void>;
}

/** Who is calling the toolkit: the lead session of one task. */
export interface Caller {
  sessionId: string;
  projectId: string;
  role: TaskRole;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const clip = (text: string): string =>
  text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}\n… [truncated]` : text;

// ---------------------------------------------------------------- plumbing

const loadTask = (db: Db, id: string) => db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();

const finishListeners = new WeakMap<Ctx, ((taskId: string) => Promise<void>)[]>();

/** Hear when a task completes. (Memory reviews what the team learned.) */
export function onTaskFinished(ctx: Ctx, listener: (taskId: string) => Promise<void>): void {
  finishListeners.set(ctx, [...(finishListeners.get(ctx) ?? []), listener]);
}

/** Tell the listeners; one that fails is logged and does not stop the others. */
function finished(ctx: Ctx, taskId: string): void {
  for (const listener of finishListeners.get(ctx) ?? [])
    void listener(taskId).catch((err: unknown) => ctx.log(err, `task ${taskId}: a finish listener failed`));
}

/** A task by id, for a caller that has already been authorized another way. */
export const find = (ctx: Ctx, id: string) => loadTask(ctx.db, id);

async function mutate<T>(ctx: Ctx, taskId: string, fn: (s: Scope) => Promise<T>): Promise<T> {
  const after: (() => Promise<unknown>)[] = [];
  const published: TaskEventRow[] = [];
  const result = await ctx.db.transaction().execute(async (tx) => {
    const task = await tx.selectFrom("tasks").selectAll().where("id", "=", taskId).forUpdate().executeTakeFirst();
    if (!task) throw notFound("task");
    const plan = TaskPlan.fromJson(task.plan);
    const before = JSON.stringify(plan.toJson());
    const scope: Scope = {
      tx,
      task,
      plan,
      after: (f) => void after.push(f),
      event: async (type, actor, payload = {}, sessionId = null) => {
        published.push(
          await tx
            .insertInto("task_events")
            .values({ task_id: taskId, type, actor, session_id: sessionId, payload: JSON.stringify(payload) })
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      },
      setStatus: async (status, extra = {}) => {
        assertTaskTransition(task.status as TaskStatus, status);
        const { result: finalResult, ...times } = extra;
        await tx
          .updateTable("tasks")
          .set({
            status,
            updated_at: new Date(),
            ...times,
            ...(finalResult !== undefined ? { result: JSON.stringify(finalResult) } : {}),
          })
          .where("id", "=", taskId)
          .execute();
        task.status = status;
      },
      mailbox: async (sessionId, kind, text, payload = {}) =>
        void (await tx
          .insertInto("task_mailbox")
          .values({ task_id: taskId, session_id: sessionId, kind, text, payload: JSON.stringify(payload) })
          .execute()),
    };
    const out = await fn(scope);
    const now = JSON.stringify(plan.toJson());
    if (now !== before)
      await tx
        .updateTable("tasks")
        .set({ plan: now, plan_version: sql`plan_version + 1`, updated_at: new Date() })
        .where("id", "=", taskId)
        .execute();
    return out;
  });
  for (const event of published) await ctx.pubsub.publish(taskChannel(taskId), event);
  await ctx.pubsub.publish(wakeChannel(taskId), {});
  for (const step of after)
    await step().catch((err: unknown) => ctx.log(err, `task ${taskId}: a post-commit step failed`));
  return result;
}

/** Server-initiated turns run as the task's owner. */
async function ownerOf(ctx: Ctx, task: TaskRow): Promise<{ auth: Auth; actor: Actor }> {
  const user = await ctx.db.selectFrom("users").select("name").where("id", "=", task.owner_id).executeTakeFirst();
  const name = user?.name ?? "";
  return {
    auth: { userId: task.owner_id, orgId: task.org_id, role: "member", name },
    actor: { user_id: task.owner_id, name },
  };
}

async function interruptSessions(ctx: Ctx, task: TaskRow, sessionIds: string[]): Promise<void> {
  if (!task.device_id || sessionIds.length === 0) return;
  const { actor } = await ownerOf(ctx, task);
  const deviceId = task.device_id;
  await Promise.all(
    sessionIds.map((id) =>
      ctx.hub.call(deviceId, "session.interrupt", { session_id: id }, actor, 10_000).catch(() => undefined),
    ),
  );
}

const sessionStatus = async (db: Db, sessionId: string): Promise<string | undefined> =>
  (await db.selectFrom("sessions").select("status").where("id", "=", sessionId).executeTakeFirst())?.status;

/**
 * Deliver an idle actor's pending mailbox as a new turn. Returns false when
 * there was nothing to deliver or the actor is mid-turn (it will be woken
 * again when that turn ends).
 */
async function wake(ctx: Ctx, task: TaskRow, sessionId: string): Promise<boolean> {
  const status = await sessionStatus(ctx.db, sessionId);
  if (!status || status === "running") return false;
  const { rows: items } = await sql<MailboxItem & { id: number }>`
    UPDATE task_mailbox SET consumed_at = now()
     WHERE id IN (SELECT id FROM task_mailbox WHERE session_id = ${sessionId}::uuid AND consumed_at IS NULL
                   ORDER BY id FOR UPDATE SKIP LOCKED)
    RETURNING id, kind, text, payload`.execute(ctx.db);
  if (items.length === 0) return false;
  items.sort((a, b) => a.id - b.id);
  try {
    await dispatchTurn(ctx, sessionId, renderInbox(items), (await ownerOf(ctx, task)).actor);
    return true;
  } catch (err) {
    // Nothing was delivered: put the mail back so the next wake carries it.
    await ctx.db
      .updateTable("task_mailbox")
      .set({ consumed_at: null })
      .where(
        "id",
        "in",
        items.map((item) => item.id),
      )
      .execute();
    if (err instanceof HttpError && err.code === "session_busy") return false;
    throw err;
  }
}

async function wakeLead(ctx: Ctx, taskId: string): Promise<void> {
  const task = await loadTask(ctx.db, taskId);
  if (!task || task.status !== "active" || !task.lead_session_id) return;
  try {
    await wake(ctx, task, task.lead_session_id);
  } catch (err) {
    await mutate(ctx, taskId, async (s) => {
      if (s.task.status === "active") await markBlocked(ctx, s, `could not reach the lead: ${(err as Error).message}`);
    });
  }
}

/** Blocked is the one state a person must act on, so its owner is always told. */
async function markBlocked(ctx: Ctx, s: Scope, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
  await s.setStatus("blocked");
  await s.event("task_blocked", "system", { reason, ...extra });
  const task = s.task;
  s.after(() =>
    notifications.notify(
      ctx,
      { orgId: task.org_id, userId: task.owner_id },
      {
        kind: "task_blocked",
        title: `任务受阻：${task.title}`,
        body: reason,
        route: `/tasks/${task.id}`,
        projectId: task.project_id,
      },
    ),
  );
}

// ------------------------------------------------------------ people's API

/** A page of the tasks in these projects, newest first — ordered like `sessions.recent`, to interleave with it. */
export async function recent(
  ctx: Ctx,
  projectIds: string[],
  page: { projectId?: string; before?: { sortAt: number; id: string }; limit: number },
) {
  if (projectIds.length === 0) return [];
  const sortAt = sql<string>`floor(extract(epoch from updated_at) * 1000)::bigint`;
  let query = ctx.db
    .selectFrom("tasks")
    .select(["id", "title", "status", "project_id", sortAt.as("sort_at")])
    .where("project_id", "in", projectIds)
    .orderBy(sortAt, "desc")
    .orderBy("id", "desc")
    .limit(page.limit);
  if (page.projectId) query = query.where("project_id", "=", page.projectId);
  if (page.before)
    query = query.where(sql<boolean>`(${sortAt}, id) < (${page.before.sortAt}::bigint, ${page.before.id}::uuid)`);
  return query.execute();
}

export interface NewTask {
  owner: Auth;
  projectId: string;
  deviceId: string;
  cwd: string;
  title: string;
  goal: string;
  leadAgentSlug: string;
  draft: boolean;
}

/** Open a task. Unless it is a draft, its lead is started on the goal at once. */
export async function create(app: FastifyInstance, input: NewTask): Promise<string> {
  const ctx = app.ctx;
  const id = crypto.randomUUID();
  await ctx.db
    .insertInto("tasks")
    .values({
      id,
      org_id: input.owner.orgId,
      owner_id: input.owner.userId,
      project_id: input.projectId,
      device_id: input.deviceId,
      title: input.title,
      goal: input.goal,
      status: "draft",
      lead_agent_slug: input.leadAgentSlug,
      cwd: input.cwd,
    })
    .execute();
  await mutate(ctx, id, (s) => s.event("task_drafted", input.owner.name || "user", { title: input.title }));
  if (!input.draft) {
    try {
      await commit(ctx, id, input.owner.name || "user");
    } catch (err) {
      // A task that could not start leaves nothing behind.
      await ctx.db
        .deleteFrom("sessions")
        .where("id", "in", (qb) => qb.selectFrom("task_runs").select("session_id").where("task_id", "=", id))
        .execute();
      await ctx.db.deleteFrom("tasks").where("id", "=", id).execute();
      throw err;
    }
  }
  return id;
}

/** draft → active: build the lead's session and hand it the goal. */
export async function commit(ctx: Ctx, taskId: string, by: string, leadOverride?: string | null): Promise<TaskRow> {
  const leadSessionId = await mutate(ctx, taskId, async (s) => {
    const slug = leadOverride?.trim() || s.task.lead_agent_slug;
    await s.setStatus("active", { committed_at: new Date() });
    const lead = (await members.teamFor(s.tx, s.task.project_id)).find((member) => member.slug === slug);
    if (!lead) throw badRequest(`lead agent "${slug}" is not on this project's team`, "agent_unavailable");
    if (!s.task.device_id) throw conflict("the device this task was to run on was removed", "device_removed");
    const { auth } = await ownerOf(ctx, s.task);
    const sessionId = await sessions.createForRun(ctx, s.tx, {
      owner: auth,
      projectId: s.task.project_id,
      deviceId: s.task.device_id,
      agent: lead.agent,
      agentSlug: slug,
      cwd: s.task.cwd,
      name: `${s.task.title} · lead`,
      metadata: roleMetadata({ task_id: taskId, role: "lead" }),
      origin: "task",
    });
    await s.tx
      .updateTable("tasks")
      .set({ lead_session_id: sessionId, lead_agent_slug: slug })
      .where("id", "=", taskId)
      .execute();
    await s.tx
      .insertInto("task_runs")
      .values({ id: crypto.randomUUID(), task_id: taskId, session_id: sessionId, agent_slug: slug, kind: "lead" })
      .execute();
    await s.event("committed", by, { lead_agent: slug }, sessionId);
    return sessionId;
  });
  const task = (await loadTask(ctx.db, taskId)) as TaskRow;
  await dispatchTurn(ctx, leadSessionId, kickoffText(task.title, task.goal), (await ownerOf(ctx, task)).actor);
  return task;
}

export async function abandon(ctx: Ctx, taskId: string, by: string, reason?: string | null): Promise<void> {
  await mutate(ctx, taskId, async (s) => {
    await s.setStatus("abandoned", { ended_at: new Date() });
    await s.event("abandoned", by, reason ? { reason } : {});
  });
}

/** Park every in-flight node and run, then interrupt the sessions. */
async function park(ctx: Ctx, s: Scope): Promise<void> {
  for (const key of s.plan.keysIn("in_progress")) s.plan.setStatus(key, "paused");
  const running = await s.tx
    .updateTable("task_runs")
    .set({ status: "paused" })
    .where("task_id", "=", s.task.id)
    .where("status", "=", "active")
    .where("kind", "=", "subtask")
    .returning("session_id")
    .execute();
  const toStop = [...running.map((run) => run.session_id), ...(s.task.lead_session_id ? [s.task.lead_session_id] : [])];
  const task = s.task;
  s.after(() => interruptSessions(ctx, task, toStop));
}

export async function intervene(
  ctx: Ctx,
  taskId: string,
  action: "pause" | "resume" | "stop",
  by: string,
): Promise<void> {
  await mutate(ctx, taskId, async (s) => {
    if (action === "pause") {
      await s.setStatus("paused");
      await park(ctx, s);
      await s.event("paused", by);
    } else if (action === "stop") {
      await s.setStatus("stopped", { ended_at: new Date() });
      await park(ctx, s);
      await s.event("stopped", by, { by: "user" });
    } else {
      const from = s.task.status;
      if (!s.task.lead_session_id) throw conflict("this task was never started", "task_not_started");
      await s.setStatus("active", { ended_at: null });
      await s.tx.updateTable("tasks").set({ idle_nudges: 0 }).where("id", "=", taskId).execute();
      await s.tx
        .updateTable("task_runs")
        .set({ status: "active", ended_at: null })
        .where("task_id", "=", taskId)
        .where("kind", "=", "lead")
        .execute();
      await s.mailbox(
        s.task.lead_session_id,
        "task_resumed",
        `The user resumed this task (it was ${from}). Call get_plan to see where things stand, re-dispatch any paused or rework subtasks, and drive it to finish_task.`,
      );
      await s.event("resumed", by, { from });
      s.after(() => wakeLead(ctx, taskId));
    }
  });
}

/** A person talks to a running task: the message reaches the lead at its next turn. */
export async function inject(
  ctx: Ctx,
  taskId: string,
  text: string,
  by: string,
  kind = "user_inject",
): Promise<string | null> {
  return mutate(ctx, taskId, async (s) => {
    if (s.task.status !== "active" || !s.task.lead_session_id)
      throw conflict(`this task is ${s.task.status}; resume it before sending a message`, "task_not_active");
    await s.tx.updateTable("tasks").set({ idle_nudges: 0 }).where("id", "=", taskId).execute();
    await s.mailbox(s.task.lead_session_id, kind, text);
    await s.event("user_inject", by, { text });
    s.after(() => wakeLead(ctx, taskId));
    return s.task.lead_session_id;
  });
}

/** Change what the task is for; the lead is told at its next turn. */
export async function reviseGoal(ctx: Ctx, taskId: string, goal: string, by: string): Promise<void> {
  await mutate(ctx, taskId, async (s) => {
    await s.tx.updateTable("tasks").set({ goal, updated_at: new Date() }).where("id", "=", taskId).execute();
    await s.event("goal_revised", by, { goal });
    if (s.task.status === "active" && s.task.lead_session_id) {
      await s.mailbox(
        s.task.lead_session_id,
        "goal_revised",
        `The user revised the task's goal. It is now:\n\n${goal}\n\nCall get_plan and adjust the plan with modify_plan where it no longer fits.`,
      );
      s.after(() => wakeLead(ctx, taskId));
    }
  });
}

// ------------------------------------------------------------- device hook

interface TaskSession {
  id: string;
  role: TaskRole;
  agentSlug: string;
}

async function taskSession(db: Db, sessionId: string): Promise<TaskSession | null> {
  const row = await db
    .selectFrom("sessions")
    .select(["id", "metadata", "agent_slug"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  const role = row ? roleOf(row.metadata) : null;
  return row && role ? { id: row.id, role, agentSlug: row.agent_slug ?? "" } : null;
}

/** Called when a turn reaches its final state on a device. */
export async function handleTurnEnd(ctx: Ctx, turn: TurnEnd): Promise<void> {
  if (turn.status === "running") return;
  const session = await taskSession(ctx.db, turn.session_id);
  if (!session) return;
  if (session.role.role === "member") await memberTurnEnded(ctx, session, turn);
  else await leadTurnEnded(ctx, session.role, turn);
}

const errorText = (turn: TurnEnd): string => str((turn.error_message as { message?: unknown } | null)?.message);

async function memberTurnEnded(ctx: Ctx, session: TaskSession, turn: TurnEnd): Promise<void> {
  const { role } = session;
  const task = await loadTask(ctx.db, role.task_id);
  if (!task) return;
  // The lead nudged this member mid-turn: let it answer before it reports.
  if (turn.status === "completed" && task.status === "active" && (await wake(ctx, task, session.id).catch(() => false)))
    return;

  await mutate(ctx, role.task_id, async (s) => {
    const node = role.subtask_key ? s.plan.get(role.subtask_key) : undefined;
    // Stale: the node was parked, stopped, or re-dispatched to another run.
    if (!node || node.status !== "in_progress" || node.latest_run_session_id !== session.id) return;
    const done = turn.status === "completed";
    const status = done ? "completed" : turn.status === "cancelled" ? "cancelled" : "error";
    const summary = done
      ? clip(turn.assistant_message ?? "(the member finished without a final message)")
      : `The member run ${status === "cancelled" ? "was interrupted" : "failed"}: ${errorText(turn) || "no details"}`;
    if (done) {
      s.plan.setStatus(node.key, "in_review");
    } else {
      // Not a deliverable: park it for re-dispatch rather than presenting a dead run for review.
      s.plan.setStatus(node.key, "rework", { review_feedback: summary });
      await s.tx
        .updateTable("task_runs")
        .set({ status: status === "cancelled" ? "rejected" : "archived", ended_at: new Date() })
        .where("session_id", "=", session.id)
        .execute();
    }
    if (s.task.lead_session_id)
      await s.mailbox(s.task.lead_session_id, "member_done", summary, {
        subtask_key: node.key,
        session_id: session.id,
        agent: session.agentSlug,
        status,
        review_criteria: node.review_criteria,
      });
    // The run's outcome, which the timeline pairs with its dispatch — and, for a run
    // that finished, the report it handed to the lead.
    await s.event(
      done ? "subtask_completed" : "subtask_failed",
      session.agentSlug,
      { subtask_key: node.key, status },
      session.id,
    );
    if (done) await s.event("subtask_reported", session.agentSlug, { subtask_key: node.key, status }, session.id);
    s.after(() => wakeLead(ctx, role.task_id));
  });
}

async function leadTurnEnded(ctx: Ctx, role: TaskRole, turn: TurnEnd): Promise<void> {
  const outcome = await mutate(ctx, role.task_id, async (s): Promise<"wake" | "nudge" | null> => {
    if (s.task.status !== "active" || !s.task.lead_session_id) return null;
    if (turn.status === "errored") {
      await markBlocked(ctx, s, `the lead's turn failed: ${errorText(turn)}`);
      return null;
    }
    // Mail that arrived while this turn was running — a member's report, or what a
    // person said after interrupting it — is delivered now, however the turn ended.
    const pending = await s.tx
      .selectFrom("task_mailbox")
      .select("id")
      .where("session_id", "=", s.task.lead_session_id)
      .where("consumed_at", "is", null)
      .limit(1)
      .executeTakeFirst();
    if (pending) return "wake";
    // Interrupted by a person with nothing said yet: leave it active; they will say what comes next.
    if (turn.status === "cancelled") return null;
    // Members still working: the lead is woken when one reports.
    if (s.plan.keysIn("in_progress").length > 0) return null;

    // Nothing in flight and the lead walked away without finishing.
    if (s.task.idle_nudges >= MAX_IDLE_NUDGES) {
      await markBlocked(ctx, s, "the lead stopped working while the task was unfinished", {
        unresolved: s.plan.unresolvedKeys(),
      });
      return null;
    }
    await s.tx
      .updateTable("tasks")
      .set({ idle_nudges: sql`idle_nudges + 1` })
      .where("id", "=", role.task_id)
      .execute();
    const unresolved = s.plan.unresolvedKeys();
    const list = (keys: string[]): string => keys.join(", ") || "none";
    await s.mailbox(
      s.task.lead_session_id,
      "task_unfinished",
      unresolved.length === 0
        ? "Every subtask is resolved but the task is still open. Call finish_task(summary, artifacts) now."
        : `You ended your turn but the task is not finished and no member is running. Unresolved subtasks: ${unresolved.join(", ")}. ` +
            `Ready to dispatch: ${list(s.plan.readyKeys())}. Awaiting your review: ${list(s.plan.keysIn("in_review"))}. ` +
            `Needs re-dispatch (rework): ${list(s.plan.keysIn("rework"))}. Continue, or call finish_task(status="stopped") if the goal cannot be reached.`,
    );
    return "nudge";
  });
  if (outcome) await wakeLead(ctx, role.task_id);
}

/**
 * A task's session became free. Mail that could not be delivered while it was
 * mid-turn — the turn's end and the session going idle arrive in either order —
 * goes out now.
 */
export async function handleSessionIdle(ctx: Ctx, sessionId: string): Promise<void> {
  const session = await taskSession(ctx.db, sessionId);
  const task = session ? await loadTask(ctx.db, session.role.task_id) : undefined;
  if (task?.status === "active") await wake(ctx, task, sessionId);
}

/** What a task adds to its sessions' turns: the role's protocol, and for the lead, the toolkit. */
export async function turnExtras(
  app: FastifyInstance,
  session: { id: string; metadata: unknown },
): Promise<TurnExtras | null> {
  const role = roleOf(session.metadata);
  const task = role ? await loadTask(app.ctx.db, role.task_id) : undefined;
  if (!role || !task) return null;
  // Members report with their final message; only the lead holds the toolkit.
  if (role.role === "member")
    return { instructions: `${MEMBER_PROTOCOL}\n\n(Parent task: ${task.title})`, mcpServers: [] };
  return {
    instructions: `${LEAD_PROTOCOL}\n\n### Task: ${task.title}\n${task.goal}`,
    // await_members parks for minutes; never let a client's shorter default abort it.
    mcpServers: [toolkitServer(app, session.id, TASK_TOOLKIT, 660)],
  };
}

/** Who a session is to the task toolkit: only a task's lead may use it. */
export async function authorizeToolCaller(ctx: Ctx, sessionId: string): Promise<Caller | null> {
  const row = await ctx.db
    .selectFrom("sessions")
    .select(["id", "metadata", "project_id"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  const role = row ? roleOf(row.metadata) : null;
  return row && role?.role === "lead" ? { sessionId: row.id, projectId: row.project_id, role } : null;
}

// ------------------------------------------------------------------ toolkit

export async function callTool(
  ctx: Ctx,
  caller: Caller,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const taskId = caller.role.task_id;
  try {
    switch (name) {
      case "list_members":
        return { members: await memberList(ctx.db, caller.projectId) };
      case "get_plan":
        return await planView(ctx, taskId);
      case "plan_task":
        return await leadWrite(ctx, taskId, (s) => planTask(s, args));
      case "modify_plan":
        return await leadWrite(ctx, taskId, (s) => modifyPlan(s, args));
      case "dispatch":
        return await dispatch(ctx, taskId, args);
      case "await_members":
        return await awaitMembers(ctx, caller, args);
      case "review_subtask":
        return await leadWrite(ctx, taskId, (s) => review(ctx, s, args));
      case "stop_subtask":
        return await leadWrite(ctx, taskId, (s) => stopSubtask(ctx, s, args));
      case "send":
        return await leadWrite(ctx, taskId, (s) => send(ctx, s, args));
      case "finish_task":
        return await leadWrite(ctx, taskId, (s) => finish(ctx, s, args), true);
      case "update_deliverable":
        return await mutate(ctx, taskId, async (s) => {
          const result = { summary: str(args["summary"]), artifacts: strings(args["artifacts"]) };
          await s.tx
            .updateTable("tasks")
            .set({ result: JSON.stringify(result), updated_at: new Date() })
            .where("id", "=", taskId)
            .execute();
          await s.event("deliverable_updated", s.task.lead_agent_slug, result);
          return { updated: true };
        });
      default:
        throw new ToolError(`unknown tool "${name}"`);
    }
  } catch (err) {
    // Domain failures are the lead's to read and correct, not crashes.
    if (err instanceof PlanError || err instanceof TaskStateError || err instanceof HttpError)
      throw new ToolError(err.message);
    throw err;
  }
}

/** A plan-changing lead call: the task must be active, and progress resets the idle counter. */
function leadWrite<T>(ctx: Ctx, taskId: string, fn: (s: Scope) => Promise<T>, anyStatus = false): Promise<T> {
  return mutate(ctx, taskId, async (s) => {
    if (!anyStatus && s.task.status !== "active") throw new ToolError(`the task is ${s.task.status}, not active`);
    await s.tx.updateTable("tasks").set({ idle_nudges: 0 }).where("id", "=", taskId).execute();
    try {
      return await fn(s);
    } catch (err) {
      // Roll the transaction back, but hand the lead a readable reason.
      if (err instanceof PlanError || err instanceof TaskStateError) throw new ToolError(err.message);
      throw err;
    }
  });
}

const memberList = async (db: Db, projectId: string) =>
  (await members.teamFor(db, projectId)).map(({ slug, agent }) => ({
    slug,
    name: agent.name,
    runtime: agent.runtime,
    role_summary: agent.description,
  }));

/** The plan as its panel and the lead's get_plan both read it. */
export async function planView(ctx: Ctx, taskId: string) {
  const task = await loadTask(ctx.db, taskId);
  if (!task) throw notFound("task");
  const plan = TaskPlan.fromJson(task.plan);
  return {
    task_status: task.status,
    subtasks: plan.toPanel(),
    ready: plan.readyKeys(),
    unresolved: plan.unresolvedKeys(),
    counts: plan.counts(),
    all_done: !plan.isEmpty && plan.unresolvedKeys().length === 0,
    current_version: task.plan_version,
  };
}

async function assertAgents(s: Scope, nodes: { agent?: unknown }[]): Promise<void> {
  const slugs = new Set((await memberList(s.tx, s.task.project_id)).map((member) => member.slug));
  for (const node of nodes) {
    if (node.agent && !slugs.has(String(node.agent)))
      throw new ToolError(
        `agent "${String(node.agent)}" is not a member of this project (members: ${[...slugs].join(", ") || "none"})`,
      );
  }
}

type Fields = Record<string, unknown>;
const records = (value: unknown): Fields[] => (Array.isArray(value) ? (value as Fields[]) : []);

async function planTask(s: Scope, args: Fields, by = s.task.lead_agent_slug) {
  if (!s.plan.isEmpty) throw new ToolError("a plan already exists — use modify_plan to add or change subtasks");
  const subtasks = records(args["subtasks"]);
  if (subtasks.length === 0) throw new ToolError("'subtasks' must be a non-empty list");
  await assertAgents(s, subtasks);
  s.plan.add(subtasks);
  await s.event("task_planned", by, { subtasks: s.plan.toPanel(), plan_version: s.task.plan_version + 1 });
  return { subtasks: s.plan.toPanel(), ready: s.plan.readyKeys() };
}

async function modifyPlan(s: Scope, args: Fields, by = s.task.lead_agent_slug) {
  const add = records(args["add"]);
  const update = records(args["update"]);
  if (add.length + update.length === 0) throw new ToolError("pass 'add' and/or 'update'");
  await assertAgents(s, [...add, ...update]);
  for (const patch of update) {
    const node = s.plan.get(str(patch["key"]));
    if (!node) throw new ToolError(`no subtask with key "${str(patch["key"])}"`);
    if (node.status === "done")
      throw new ToolError(`subtask "${node.key}" is already approved; add a new subtask instead of changing it`);
    if (node.status === "in_progress")
      throw new ToolError(`subtask "${node.key}" is running; stop_subtask it before changing it`);
    s.plan.patch(node.key, patch);
  }
  if (add.length) s.plan.add(add);
  await s.event("plan_revised", by, {
    subtasks: s.plan.toPanel(),
    plan_version: s.task.plan_version + 1,
    added: add.map((node) => node["key"]),
    updated: update.map((node) => node["key"]),
  });
  return { subtasks: s.plan.toPanel(), ready: s.plan.readyKeys() };
}

/** A person edits the plan directly — of a draft, or of a running task they are steering. */
export async function writePlan(
  ctx: Ctx,
  taskId: string,
  by: string,
  input: {
    subtasks?: Fields[] | null;
    add?: Fields[] | null;
    update?: Fields[] | null;
    expected_version?: number | null;
  },
) {
  try {
    await mutate(ctx, taskId, async (s) => {
      if (["abandoned", "completed"].includes(s.task.status))
        throw conflict(`the plan of a task that is ${s.task.status} cannot be changed`, "task_closed");
      // On a running task the lead may be writing too: the caller says which version they saw.
      if (input.expected_version != null && input.expected_version !== s.task.plan_version)
        throw conflict("the plan changed since you read it; reload it and try again", "plan_version_mismatch");
      if (input.subtasks) await planTask(s, { subtasks: input.subtasks }, by);
      else await modifyPlan(s, { add: input.add ?? [], update: input.update ?? [] }, by);
    });
  } catch (err) {
    if (err instanceof PlanError || err instanceof ToolError) throw badRequest(err.message, "invalid_plan");
    throw err;
  }
  return planView(ctx, taskId);
}

function findNode(s: Scope, args: Fields): Subtask {
  const key = str(args["subtask_key"]);
  const sessionId = str(args["session_id"]);
  const node = key ? s.plan.get(key) : s.plan.all.find((n) => n.latest_run_session_id === sessionId);
  if (!node) throw new ToolError(key ? `no subtask with key "${key}"` : "pass subtask_key or the member's session_id");
  return node;
}

const setRun = async (tx: Db, sessionId: string | null, status: string, ended = true): Promise<void> => {
  if (!sessionId) return;
  await tx
    .updateTable("task_runs")
    .set({ status, ended_at: ended ? new Date() : null })
    .where("session_id", "=", sessionId)
    .execute();
};

/** Start (or restart) a member on a ready node. Non-blocking for the lead. */
async function dispatch(ctx: Ctx, taskId: string, args: Fields) {
  const started = await leadWrite(ctx, taskId, async (s) => {
    const node = findNode(s, args);
    if (!["planned", "rework", "paused"].includes(node.status))
      throw new ToolError(
        `subtask "${node.key}" is ${node.status}; only planned, rework or paused subtasks can be dispatched`,
      );
    if (!s.plan.depsDone(node.key)) {
      const waiting = node.depends_on.filter((dep) => s.plan.get(dep)?.status !== "done");
      throw new ToolError(`subtask "${node.key}" is blocked on unfinished dependencies: ${waiting.join(", ")}`);
    }
    const slug = str(args["agent"]) || node.agent;
    if (!slug) throw new ToolError(`subtask "${node.key}" has no agent; pass one (see list_members)`);
    await assertAgents(s, [{ agent: slug }]);
    const goal = str(args["goal"]) || node.goal;

    // A retry goes back to the same member, which still holds its working context.
    const prior = node.latest_run_session_id
      ? await s.tx
          .selectFrom("task_runs as r")
          .innerJoin("sessions as x", "x.id", "r.session_id")
          .select("x.id")
          .where("x.id", "=", node.latest_run_session_id)
          .where("r.agent_slug", "=", slug)
          .where("x.status", "<>", "running")
          .executeTakeFirst()
      : undefined;
    let sessionId = prior?.id;
    if (sessionId) {
      await setRun(s.tx, sessionId, "active", false);
    } else {
      const member = (await members.teamFor(s.tx, s.task.project_id)).find((m) => m.slug === slug);
      if (!member || !s.task.device_id) throw new ToolError(`agent "${slug}" cannot be started right now`);
      sessionId = await sessions.createForRun(ctx, s.tx, {
        owner: (await ownerOf(ctx, s.task)).auth,
        projectId: s.task.project_id,
        deviceId: s.task.device_id,
        agent: member.agent,
        agentSlug: slug,
        cwd: s.task.cwd,
        name: `${s.task.title} · ${node.title}`,
        metadata: roleMetadata({ task_id: taskId, role: "member", subtask_key: node.key }),
        origin: "task",
      });
      await s.tx
        .insertInto("task_runs")
        .values({
          id: crypto.randomUUID(),
          task_id: taskId,
          session_id: sessionId,
          agent_slug: slug,
          kind: "subtask",
          subtask_key: node.key,
        })
        .execute();
    }
    const brief = memberBrief(node, goal, strings(args["refs"]));
    s.plan.setStatus(node.key, "in_progress", { attempts: node.attempts + 1, latest_run_session_id: sessionId });
    if (str(args["agent"])) s.plan.patch(node.key, { agent: slug });
    await s.event(
      "subtask_spawned",
      s.task.lead_agent_slug,
      { subtask_key: node.key, agent: slug, attempt: node.attempts },
      sessionId,
    );
    return { sessionId, key: node.key, slug, brief, task: s.task };
  });

  try {
    await dispatchTurn(ctx, started.sessionId, started.brief, (await ownerOf(ctx, started.task)).actor);
  } catch (err) {
    const reason = `could not start the member: ${(err as Error).message}`;
    await mutate(ctx, taskId, async (s) => {
      s.plan.setStatus(started.key, "rework", { review_feedback: reason });
      await setRun(s.tx, started.sessionId, "archived");
      await s.event("subtask_failed", "system", { subtask_key: started.key, reason });
    });
    throw new ToolError(`${reason}. The subtask is back in rework; dispatch it again once the device is reachable.`);
  }
  return { status: "dispatched", subtask_key: started.key, session_id: started.sessionId, agent: started.slug };
}

/** Block until dispatched members report (or the wait times out). Meant to be looped. */
async function awaitMembers(ctx: Ctx, caller: Caller, args: Fields) {
  const taskId = caller.role.task_id;
  const lead = caller.sessionId;
  const keys = Array.isArray(args["keys"]) && args["keys"].length ? strings(args["keys"]) : null;
  const mode = args["mode"] === "all" ? "all" : "any";
  const timeoutS = Math.min(Math.max(Number(args["timeout_s"]) || 120, 1), 600);
  const deadline = Date.now() + timeoutS * 1000;
  const results: Fields[] = [];

  let notify: (() => void) | null = null;
  const unsubscribe = await ctx.pubsub.subscribe(wakeChannel(taskId), () => notify?.());
  try {
    for (;;) {
      const wanted = keys ? sql`AND payload->>'subtask_key' = ANY(${keys}::text[])` : sql``;
      const { rows: reports } = await sql<{ text: string; payload: Fields }>`
        UPDATE task_mailbox SET consumed_at = now()
         WHERE id IN (SELECT id FROM task_mailbox
                       WHERE session_id = ${lead}::uuid AND consumed_at IS NULL AND kind = 'member_done' ${wanted}
                       ORDER BY id FOR UPDATE SKIP LOCKED)
        RETURNING text, payload`.execute(ctx.db);
      for (const report of reports) results.push({ ...report.payload, summary: report.text });

      const task = await loadTask(ctx.db, taskId);
      const plan = TaskPlan.fromJson(task?.plan);
      const running = plan.keysIn("in_progress").filter((key) => !keys || keys.includes(key));
      if (results.length > 0 && (mode === "any" || running.length === 0)) return { results, pending: running };
      if (running.length === 0)
        return {
          results,
          error: keys ? `none of ${keys.join(", ")} is running` : "no dispatched member is in flight — dispatch first",
          ready: plan.readyKeys(),
          awaiting_review: plan.keysIn("in_review"),
        };
      // Someone talked to the task while we were parked: surface it instead of sleeping on.
      const mail = await ctx.db
        .selectFrom("task_mailbox")
        .select("id")
        .where("session_id", "=", lead)
        .where("consumed_at", "is", null)
        .where("kind", "<>", "member_done")
        .limit(1)
        .executeTakeFirst();
      if (task?.status !== "active" || mail || Date.now() >= deadline)
        return {
          results,
          pending: running,
          pending_status: Object.fromEntries(running.map((key) => [key, "running"])),
          note: mail
            ? "a new message is waiting for you — end this wait and read it"
            : task?.status !== "active"
              ? `the task is ${task?.status ?? "gone"}`
              : "timed out; members are still running — call await_members again",
        };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(5000, Math.max(deadline - Date.now(), 50)));
        notify = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      notify = null;
    }
  } finally {
    unsubscribe();
  }
}

async function review(ctx: Ctx, s: Scope, args: Fields) {
  const node = findNode(s, args);
  const feedback = str(args["feedback"]);
  if (args["decision"] === "approve") {
    if (node.status === "done") return { subtask_key: node.key, already_done: true, ready: s.plan.readyKeys() };
    if (node.attempts === 0) throw new ToolError(`subtask "${node.key}" was never dispatched — dispatch it first`);
    if (node.status === "in_progress")
      throw new ToolError(`subtask "${node.key}" is still running — await_members before reviewing it`);
    s.plan.setStatus(node.key, "done", { review_feedback: feedback || null });
    await setRun(s.tx, node.latest_run_session_id, "completed");
    await s.event(
      "subtask_reviewed",
      s.task.lead_agent_slug,
      { subtask_key: node.key, decision: "approve", feedback },
      node.latest_run_session_id,
    );
    return { subtask_key: node.key, status: "done", ready: s.plan.readyKeys(), unresolved: s.plan.unresolvedKeys() };
  }
  if (args["decision"] !== "rework") throw new ToolError("decision must be 'approve' or 'rework'");
  if (!feedback) throw new ToolError("rework needs 'feedback' telling the member what to change");
  if (node.status !== "in_review")
    throw new ToolError(
      `subtask "${node.key}" is ${node.status}; only a reported subtask (in_review) can be sent back`,
    );
  const memberId = node.latest_run_session_id;
  const exists = memberId ? await sessionStatus(s.tx, memberId) : undefined;
  s.plan.setStatus(node.key, "rework", { review_feedback: feedback });
  await s.event(
    "subtask_reviewed",
    s.task.lead_agent_slug,
    { subtask_key: node.key, decision: "rework", feedback },
    memberId,
  );
  if (!memberId || !exists)
    return {
      subtask_key: node.key,
      status: "rework",
      note: "the member's session is gone — dispatch the subtask again",
    };
  // Straight back to the same member, which still holds its working context.
  s.plan.setStatus(node.key, "in_progress", { attempts: node.attempts + 1 });
  await s.mailbox(
    memberId,
    "lead_message",
    `The lead reviewed your work and asks for changes:\n\n${feedback}\n\nRevise it, then report again.`,
  );
  const task = s.task;
  s.after(async () => {
    if (await wake(ctx, task, memberId).catch(() => false)) return;
    // The member could not be reached: the node is not really in progress.
    await mutate(ctx, task.id, async (x) => {
      if (x.plan.get(node.key)?.status === "in_progress") x.plan.setStatus(node.key, "rework");
    });
  });
  return {
    subtask_key: node.key,
    status: "in_progress",
    session_id: memberId,
    note: "feedback sent; await_members to collect the revision",
  };
}

async function stopSubtask(ctx: Ctx, s: Scope, args: Fields) {
  const node = findNode(s, args);
  if (node.status !== "in_progress" || !node.latest_run_session_id)
    throw new ToolError(`subtask "${node.key}" is ${node.status}, not running`);
  const sessionId = node.latest_run_session_id;
  const reason = str(args["reason"]) || "stopped by the lead";
  s.plan.setStatus(node.key, "rework", { review_feedback: reason });
  await setRun(s.tx, sessionId, "rejected");
  // A synthetic report, so an await on this key returns instead of hanging.
  if (s.task.lead_session_id)
    await s.mailbox(s.task.lead_session_id, "member_done", `Stopped by the lead: ${reason}`, {
      subtask_key: node.key,
      session_id: sessionId,
      agent: node.agent ?? "",
      status: "cancelled",
    });
  await s.event("subtask_stopped", s.task.lead_agent_slug, { subtask_key: node.key, reason }, sessionId);
  const task = s.task;
  s.after(() => interruptSessions(ctx, task, [sessionId]));
  return {
    subtask_key: node.key,
    status: "rework",
    note: "stopped; re-dispatch it (optionally after modify_plan) or leave it",
  };
}

async function send(ctx: Ctx, s: Scope, args: Fields) {
  const sessionId = str(args["session_id"]);
  const text = str(args["text"]);
  if (!text) throw new ToolError("'text' is required");
  const run = /^[0-9a-f-]{36}$/i.test(sessionId)
    ? await s.tx
        .selectFrom("task_runs")
        .select("id")
        .where("task_id", "=", s.task.id)
        .where("session_id", "=", sessionId)
        .where("kind", "=", "subtask")
        .executeTakeFirst()
    : undefined;
  if (!run) throw new ToolError("that session is not a member of this task");
  await s.mailbox(sessionId, "lead_message", text);
  const task = s.task;
  s.after(() => wake(ctx, task, sessionId).catch(() => false));
  return { delivered: "queued — the member reads it at its next turn boundary" };
}

async function finish(ctx: Ctx, s: Scope, args: Fields) {
  const status = args["status"] === "stopped" ? "stopped" : "completed";
  if (s.task.status !== "active") throw new ToolError(`the task is already ${s.task.status}`);
  const running = s.plan.keysIn("in_progress");
  if (status === "completed") {
    const unresolved = s.plan.unresolvedKeys();
    if (unresolved.length > 0)
      throw new ToolError(
        `cannot complete: unresolved subtasks remain (${unresolved.join(", ")}). Finish and approve them, or finish with status="stopped".`,
      );
  } else if (running.length > 0 && args["force"] !== true) {
    throw new ToolError(
      `members are still running (${running.join(", ")}). A quiet member is usually mid-work, not dead — await it, stop_subtask it, or pass force=true to terminate anyway.`,
    );
  }
  const result = { summary: str(args["summary"]), artifacts: strings(args["artifacts"]) };
  if (!result.summary) throw new ToolError("'summary' is required");
  await s.setStatus(status, { result, ended_at: new Date() });
  await s.tx
    .updateTable("task_runs")
    .set({ status: "completed", ended_at: new Date() })
    .where("task_id", "=", s.task.id)
    .where("kind", "=", "lead")
    .execute();
  const task = s.task;
  if (running.length > 0) {
    for (const key of running) s.plan.setStatus(key, "paused");
    const parked = await s.tx
      .updateTable("task_runs")
      .set({ status: "paused" })
      .where("task_id", "=", task.id)
      .where("status", "=", "active")
      .where("kind", "=", "subtask")
      .returning("session_id")
      .execute();
    s.after(() =>
      interruptSessions(
        ctx,
        task,
        parked.map((run) => run.session_id),
      ),
    );
  }
  await s.event(status === "completed" ? "task_completed" : "task_stopped", s.task.lead_agent_slug, result);
  if (status === "completed") s.after(async () => finished(ctx, task.id));
  s.after(() =>
    notifications.notify(
      ctx,
      { orgId: task.org_id, userId: task.owner_id },
      {
        kind: `task_${status}`,
        title: `任务${status === "completed" ? "已完成" : "已停止"}：${task.title}`,
        body: result.summary.slice(0, 300),
        route: `/tasks/${task.id}`,
        projectId: task.project_id,
      },
    ),
  );
  return { status, note: "the task is closed — end your turn" };
}
