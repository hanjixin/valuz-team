/**
 * TaskService — the lead/member orchestration, server side.
 *
 * A task owns a plan DAG and a set of runs (kernel sessions on a device). The
 * lead drives `plan → dispatch → await → review → finish` through the task
 * toolkit; members just work and report with their final message. Three
 * things move a task forward, and each has exactly one entry point here:
 *
 *   a tool call from the lead      → `callTool`
 *   a turn ending on a device      → `onTurnEnd`
 *   a person intervening           → `intervene` / `inject` / `commit`
 *
 * Every plan write happens inside `mutate` (row lock + transition tables);
 * anything that talks to a device runs after the transaction commits.
 */
import type { Actor } from "@agent-base/protocol";
import type { Ctx } from "../context.ts";
import { type Queryable, type Row, json } from "../db.ts";
import type { TurnEnd } from "../device-hub.ts";
import { createSession, dispatchTurn } from "../dispatch.ts";
import { HttpError, badRequest, conflict, notFound } from "../http.ts";
import { ToolError } from "../mcp.ts";
import { PlanError, type Subtask, TaskPlan, TaskStateError, type TaskStatus, assertTaskTransition } from "./plan.ts";
import { type MailboxItem, type TaskRole, kickoffText, memberBrief, renderInbox, taskRoleOf } from "./prompts.ts";

export const taskChannel = (taskId: string): string => `task:${taskId}`;
const wakeChannel = (taskId: string): string => `task:${taskId}:wake`;

const MAX_IDLE_NUDGES = 2;
const SUMMARY_LIMIT = 8000;

export { ToolError };

interface Scope {
  tx: Queryable;
  task: Row;
  plan: TaskPlan;
  /** Record a timeline event (published after commit). */
  event(type: string, actor: string, payload?: Record<string, unknown>, sessionId?: string | null): Promise<void>;
  /** Run once the transaction has committed — device calls go here. */
  after(fn: () => Promise<void>): void;
  setStatus(status: TaskStatus, extra?: Record<string, unknown>): Promise<void>;
  mailbox(sessionId: string, kind: string, text: string, payload?: Record<string, unknown>): Promise<void>;
}

export interface Caller {
  session: Row;
  role: TaskRole;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (text: string): string => (text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}\n… [truncated]` : text);

export class TaskService {
  constructor(private readonly ctx: Ctx) {}

  // ---------------------------------------------------------------- plumbing

  private async mutate<T>(taskId: string, fn: (s: Scope) => Promise<T>): Promise<T> {
    const after: (() => Promise<void>)[] = [];
    const published: Row[] = [];
    const result = await this.ctx.db.tx(async (tx) => {
      const task = await tx.one("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
      if (!task) throw notFound("task");
      const plan = TaskPlan.fromJson(task["plan"]);
      const before = JSON.stringify(plan.toJson());
      const scope: Scope = {
        tx,
        task,
        plan,
        after: (f) => void after.push(f),
        event: async (type, actor, payload = {}, sessionId = null) => {
          const row = await tx.one(
            "INSERT INTO task_events (task_id, type, actor, session_id, payload) VALUES ($1, $2, $3, $4, $5) RETURNING seq, task_id, type, actor, session_id, payload, created_at",
            [taskId, type, actor, sessionId, json(payload)],
          );
          published.push(row as Row);
        },
        setStatus: async (status, extra = {}) => {
          assertTaskTransition(task["status"] as TaskStatus, status);
          const cols = Object.keys(extra);
          await tx.query(
            `UPDATE tasks SET status = $2, updated_at = now()${cols.map((c, i) => `, ${c} = $${i + 3}`).join("")} WHERE id = $1`,
            [taskId, status, ...Object.values(extra)],
          );
          task["status"] = status;
        },
        mailbox: async (sessionId, kind, text, payload = {}) => {
          await tx.query("INSERT INTO task_mailbox (task_id, session_id, kind, text, payload) VALUES ($1, $2, $3, $4, $5)", [
            taskId, sessionId, kind, text, json(payload),
          ]);
        },
      };
      const out = await fn(scope);
      const now = JSON.stringify(plan.toJson());
      if (now !== before) {
        await tx.query("UPDATE tasks SET plan = $2, plan_version = plan_version + 1, updated_at = now() WHERE id = $1", [taskId, now]);
      }
      return out;
    });
    for (const event of published) await this.ctx.pubsub.publish(taskChannel(taskId), event);
    await this.ctx.pubsub.publish(wakeChannel(taskId), {});
    for (const f of after) await f().catch((err: unknown) => console.error(`[task ${taskId}] post-commit step failed:`, err));
    return result;
  }

  /** Server-initiated turns run as the task's owner. */
  private async ownerActor(task: Row): Promise<Actor> {
    const user = await this.ctx.db.one<{ name: string }>("SELECT name FROM users WHERE id = $1", [task["owner_id"]]);
    return { user_id: task["owner_id"] as string, name: user?.name ?? "" };
  }

  private async interrupt(task: Row, sessionIds: string[]): Promise<void> {
    if (!task["device_id"] || sessionIds.length === 0) return;
    const actor = await this.ownerActor(task);
    await Promise.all(
      sessionIds.map((id) =>
        this.ctx.hub.call(task["device_id"] as string, "session.interrupt", { session_id: id }, actor, 10_000).catch(() => undefined),
      ),
    );
  }

  /**
   * Deliver an idle actor's pending mailbox as a new turn. Returns false when
   * there was nothing to deliver or the actor is mid-turn (it will be woken
   * again when that turn ends).
   */
  private async wake(task: Row, sessionId: string): Promise<boolean> {
    const session = await this.ctx.db.one("SELECT * FROM sessions WHERE id = $1", [sessionId]);
    if (!session || session["status"] === "running") return false;
    const items = await this.ctx.db.query<MailboxItem & { id: number }>(
      `UPDATE task_mailbox SET consumed_at = now()
        WHERE id IN (SELECT id FROM task_mailbox WHERE session_id = $1 AND consumed_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, text, payload`,
      [sessionId],
    );
    if (items.length === 0) return false;
    items.sort((a, b) => a.id - b.id);
    try {
      await dispatchTurn(this.ctx, session, { text: renderInbox(items), attachments: [], additional_context: "" }, await this.ownerActor(task));
      return true;
    } catch (err) {
      // Nothing was delivered: put the mail back so the next wake carries it.
      await this.ctx.db.query("UPDATE task_mailbox SET consumed_at = NULL WHERE id = ANY($1::bigint[])", [items.map((i) => i.id)]);
      if (err instanceof HttpError && err.code === "session_busy") return false;
      throw err;
    }
  }

  private async wakeLead(taskId: string): Promise<void> {
    const task = await this.ctx.db.one("SELECT * FROM tasks WHERE id = $1", [taskId]);
    if (!task || task["status"] !== "active" || !task["lead_session_id"]) return;
    try {
      await this.wake(task, task["lead_session_id"] as string);
    } catch (err) {
      await this.block(taskId, `could not reach the lead: ${(err as Error).message}`);
    }
  }

  private async block(taskId: string, reason: string): Promise<void> {
    await this.mutate(taskId, async (s) => {
      if (s.task["status"] !== "active") return;
      await this.markBlocked(s, reason);
    });
  }

  /** Blocked is the one state a person must act on, so its owner is always told. */
  private async markBlocked(s: Scope, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    await s.setStatus("blocked");
    await s.event("task_blocked", "system", { reason, ...extra });
    const task = s.task;
    s.after(() => this.ctx.notify(task["owner_id"] as string, task["org_id"] as string, {
      kind: "task_blocked", title: `任务受阻：${String(task["title"])}`, body: reason, link: `/tasks/${String(task["id"])}`,
    }));
  }

  // ------------------------------------------------------------ people's API

  async create(input: {
    orgId: string;
    ownerId: string;
    projectId: string;
    title: string;
    goal: string;
    leadAgentSlug: string;
    deviceId: string;
    cwd: string;
    draft: boolean;
  }): Promise<Row> {
    const id = crypto.randomUUID();
    await this.ctx.db.query(
      `INSERT INTO tasks (id, org_id, owner_id, project_id, device_id, title, goal, status, lead_agent_slug, cwd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9)`,
      [id, input.orgId, input.ownerId, input.projectId, input.deviceId, input.title, input.goal, input.leadAgentSlug, input.cwd],
    );
    await this.mutate(id, (s) => s.event("task_drafted", "user", { title: input.title }));
    if (!input.draft) {
      try {
        await this.commit(id);
      } catch (err) {
        // A task that could not start leaves nothing behind.
        await this.ctx.db.query("DELETE FROM sessions WHERE id IN (SELECT session_id FROM task_runs WHERE task_id = $1)", [id]);
        await this.ctx.db.query("DELETE FROM tasks WHERE id = $1", [id]);
        throw err;
      }
    }
    return this.view(id);
  }

  /** draft → active: build the lead session and hand it the goal. */
  async commit(taskId: string): Promise<void> {
    const lead = await this.mutate(taskId, async (s) => {
      await s.setStatus("active", { committed_at: new Date() });
      const agent = await s.tx.one("SELECT * FROM agents WHERE org_id = $1 AND slug = $2", [s.task["org_id"], s.task["lead_agent_slug"]]);
      if (!agent) throw badRequest(`lead agent "${String(s.task["lead_agent_slug"])}" no longer exists`, "agent_unavailable");
      const session = await createSession(
        this.ctx,
        {
          orgId: s.task["org_id"] as string,
          ownerId: s.task["owner_id"] as string,
          agent,
          deviceId: s.task["device_id"] as string,
          projectId: s.task["project_id"] as string,
          cwd: s.task["cwd"] as string,
          title: `${String(s.task["title"])} · lead`,
          metadata: { valuz: { task: { task_id: taskId, role: "lead" } } },
        },
        s.tx,
      );
      await s.tx.query("UPDATE tasks SET lead_session_id = $2 WHERE id = $1", [taskId, session["id"]]);
      await s.tx.query("INSERT INTO task_runs (id, task_id, session_id, agent_slug, kind) VALUES ($1, $2, $3, $4, 'lead')", [
        crypto.randomUUID(), taskId, session["id"], s.task["lead_agent_slug"],
      ]);
      await s.event("task_started", "user", { lead_agent: s.task["lead_agent_slug"] }, session["id"] as string);
      return session;
    });
    const task = (await this.ctx.db.one("SELECT * FROM tasks WHERE id = $1", [taskId])) as Row;
    await dispatchTurn(
      this.ctx,
      lead,
      { text: kickoffText(task["title"] as string, task["goal"] as string), attachments: [], additional_context: "" },
      await this.ownerActor(task),
    );
  }

  async abandon(taskId: string): Promise<void> {
    await this.mutate(taskId, async (s) => {
      await s.setStatus("abandoned", { ended_at: new Date() });
      await s.event("task_abandoned", "user");
    });
  }

  /** Park every in-flight node and run, then interrupt the sessions. */
  private async park(s: Scope): Promise<void> {
    for (const key of s.plan.keysIn("in_progress")) s.plan.setStatus(key, "paused");
    const running = await s.tx.query<{ session_id: string }>(
      "UPDATE task_runs SET status = 'paused' WHERE task_id = $1 AND status = 'active' AND kind = 'subtask' RETURNING session_id",
      [s.task["id"]],
    );
    const sessions = [...running.map((r) => r.session_id), ...(s.task["lead_session_id"] ? [s.task["lead_session_id"] as string] : [])];
    s.after(() => this.interrupt(s.task, sessions));
  }

  async intervene(taskId: string, action: "pause" | "resume" | "stop", actorName: string): Promise<Row> {
    await this.mutate(taskId, async (s) => {
      if (action === "pause") {
        await s.setStatus("paused");
        await this.park(s);
        await s.event("task_paused", actorName);
      } else if (action === "stop") {
        await s.setStatus("stopped", { ended_at: new Date() });
        await this.park(s);
        await s.event("task_stopped", actorName, { by: "user" });
      } else {
        const from = s.task["status"] as string;
        await s.setStatus("active", { ended_at: null, idle_nudges: 0 });
        await s.tx.query("UPDATE task_runs SET status = 'active', ended_at = NULL WHERE task_id = $1 AND kind = 'lead'", [taskId]);
        await s.mailbox(
          s.task["lead_session_id"] as string,
          "task_resumed",
          `The user resumed this task (it was ${from}). Call get_plan to see where things stand, re-dispatch any paused or rework subtasks, and drive it to finish_task.`,
        );
        await s.event("task_resumed", actorName, { from });
        s.after(() => this.wakeLead(taskId));
      }
    });
    return this.view(taskId);
  }

  /** A person talks to a running task: the message reaches the lead at its next turn. */
  async inject(taskId: string, text: string, actorName: string): Promise<void> {
    await this.mutate(taskId, async (s) => {
      if (s.task["status"] !== "active") throw conflict(`this task is ${String(s.task["status"])}; resume it before sending a message`, "task_not_active");
      await s.tx.query("UPDATE tasks SET idle_nudges = 0 WHERE id = $1", [taskId]);
      await s.mailbox(s.task["lead_session_id"] as string, "user_inject", text);
      await s.event("user_inject", actorName, { text });
      s.after(() => this.wakeLead(taskId));
    });
  }

  async view(taskId: string): Promise<Row> {
    const task = await this.ctx.db.one("SELECT * FROM tasks WHERE id = $1", [taskId]);
    if (!task) throw notFound("task");
    const plan = TaskPlan.fromJson(task["plan"]);
    const runs = await this.ctx.db.query(
      `SELECT r.id, r.session_id, r.agent_slug, r.kind, r.subtask_key, r.status, r.created_at, r.ended_at, s.status AS session_status
         FROM task_runs r JOIN sessions s ON s.id = r.session_id WHERE r.task_id = $1 ORDER BY r.created_at`,
      [taskId],
    );
    return { ...task, plan: plan.toPanel(), ready: plan.readyKeys(), unresolved: plan.unresolvedKeys(), counts: plan.counts(), runs };
  }

  // ------------------------------------------------------------- device hook

  /** Called when a turn reaches its final state on a device. */
  async onTurnEnd(message: TurnEnd): Promise<void> {
    if (message.status === "running") return;
    const session = await this.ctx.db.one("SELECT * FROM sessions WHERE id = $1", [message.session_id]);
    const role = session ? taskRoleOf(session) : null;
    if (!session || !role) return;
    if (role.role === "member") await this.onMemberTurnEnd(role, session, message);
    else await this.onLeadTurnEnd(role, session, message);
  }

  private async onMemberTurnEnd(role: TaskRole, session: Row, message: TurnEnd): Promise<void> {
    const sessionId = session["id"] as string;
    const task = await this.ctx.db.one("SELECT * FROM tasks WHERE id = $1", [role.task_id]);
    if (!task) return;
    // The lead nudged this member mid-turn: let it answer before it reports.
    if (message.status === "completed" && task["status"] === "active" && (await this.wake(task, sessionId).catch(() => false))) return;

    await this.mutate(role.task_id, async (s) => {
      const node = role.subtask_key ? s.plan.get(role.subtask_key) : undefined;
      // Stale: the node was parked, stopped, or re-dispatched to another run.
      if (!node || node.status !== "in_progress" || node.latest_run_session_id !== sessionId) return;
      const agent = (session["agent_config"] as { metadata?: { slug?: string } }).metadata?.slug ?? "";
      const done = message.status === "completed";
      const status = done ? "completed" : message.status === "cancelled" ? "cancelled" : "error";
      const summary = done
        ? clip(message.assistant_message ?? "(the member finished without a final message)")
        : `The member run ${status === "cancelled" ? "was interrupted" : "failed"}: ${str((message.error_message as Row | null)?.["message"]) || "no details"}`;
      if (done) {
        s.plan.setStatus(node.key, "in_review");
      } else {
        // Not a deliverable: park it for re-dispatch rather than presenting a dead run for review.
        s.plan.setStatus(node.key, "rework", { review_feedback: summary });
        await s.tx.query("UPDATE task_runs SET status = $2, ended_at = now() WHERE session_id = $1", [sessionId, status === "cancelled" ? "rejected" : "archived"]);
      }
      await s.mailbox(s.task["lead_session_id"] as string, "member_done", summary, {
        subtask_key: node.key, session_id: sessionId, agent, status, review_criteria: node.review_criteria,
      });
      await s.event("subtask_reported", agent, { subtask_key: node.key, status }, sessionId);
      s.after(() => this.wakeLead(role.task_id));
    });
  }

  private async onLeadTurnEnd(role: TaskRole, _session: Row, message: TurnEnd): Promise<void> {
    const outcome = await this.mutate(role.task_id, async (s): Promise<"wake" | "nudge" | null> => {
      if (s.task["status"] !== "active") return null;
      if (message.status === "errored") {
        await this.markBlocked(s, `the lead's turn failed: ${str((message.error_message as Row | null)?.["message"])}`);
        return null;
      }
      // Interrupted by a person: leave it active; they will say what comes next.
      if (message.status === "cancelled") return null;
      const pending = await s.tx.one("SELECT 1 FROM task_mailbox WHERE session_id = $1 AND consumed_at IS NULL LIMIT 1", [s.task["lead_session_id"]]);
      if (pending) return "wake";
      // Members still working: the lead is woken when one reports.
      if (s.plan.keysIn("in_progress").length > 0) return null;

      // Nothing in flight and the lead walked away without finishing.
      if ((s.task["idle_nudges"] as number) >= MAX_IDLE_NUDGES) {
        await this.markBlocked(s, "the lead stopped working while the task was unfinished", { unresolved: s.plan.unresolvedKeys() });
        return null;
      }
      await s.tx.query("UPDATE tasks SET idle_nudges = idle_nudges + 1 WHERE id = $1", [role.task_id]);
      const unresolved = s.plan.unresolvedKeys();
      await s.mailbox(
        s.task["lead_session_id"] as string,
        "task_unfinished",
        unresolved.length === 0
          ? "Every subtask is resolved but the task is still open. Call finish_task(summary, artifacts) now."
          : `You ended your turn but the task is not finished and no member is running. Unresolved subtasks: ${unresolved.join(", ")}. ` +
            `Ready to dispatch: ${s.plan.readyKeys().join(", ") || "none"}. Awaiting your review: ${s.plan.keysIn("in_review").join(", ") || "none"}. ` +
            `Needs re-dispatch (rework): ${s.plan.keysIn("rework").join(", ") || "none"}. Continue, or call finish_task(status="stopped") if the goal cannot be reached.`,
      );
      return "nudge";
    });
    if (outcome) await this.wakeLead(role.task_id);
  }

  // ------------------------------------------------------------------ toolkit

  async callTool(caller: Caller, name: string, args: Record<string, unknown>): Promise<unknown> {
    const taskId = caller.role.task_id;
    try {
      switch (name) {
        case "list_members":
          return { members: await this.members(caller.session["project_id"] as string) };
        case "get_plan":
          return this.planView(taskId);
        case "plan_task":
          return await this.leadWrite(taskId, (s) => this.planTask(s, args));
        case "modify_plan":
          return await this.leadWrite(taskId, (s) => this.modifyPlan(s, args));
        case "dispatch":
          return await this.dispatch(taskId, args);
        case "await_members":
          return await this.awaitMembers(caller, args);
        case "review_subtask":
          return await this.leadWrite(taskId, (s) => this.review(s, args));
        case "stop_subtask":
          return await this.leadWrite(taskId, (s) => this.stopSubtask(s, args));
        case "send":
          return await this.leadWrite(taskId, (s) => this.send(s, args));
        case "finish_task":
          return await this.leadWrite(taskId, (s) => this.finish(s, args), true);
        case "update_deliverable":
          return await this.mutate(taskId, async (s) => {
            const result = { summary: str(args["summary"]), artifacts: Array.isArray(args["artifacts"]) ? args["artifacts"] : [] };
            await s.tx.query("UPDATE tasks SET result = $2, updated_at = now() WHERE id = $1", [taskId, json(result)]);
            await s.event("deliverable_updated", "lead", result);
            return { updated: true };
          });
        default:
          throw new ToolError(`unknown tool "${name}"`);
      }
    } catch (err) {
      // Domain failures are the lead's to read and correct, not crashes.
      if (err instanceof PlanError || err instanceof TaskStateError || err instanceof HttpError) throw new ToolError(err.message);
      throw err;
    }
  }

  /** A plan-changing lead call: the task must be active, and progress resets the idle counter. */
  private leadWrite<T>(taskId: string, fn: (s: Scope) => Promise<T>, allowAnyStatus = false): Promise<T> {
    return this.mutate(taskId, async (s) => {
      if (!allowAnyStatus && s.task["status"] !== "active") throw new ToolError(`the task is ${String(s.task["status"])}, not active`);
      await s.tx.query("UPDATE tasks SET idle_nudges = 0 WHERE id = $1", [taskId]);
      try {
        return await fn(s);
      } catch (err) {
        // Roll the transaction back, but hand the lead a readable reason.
        if (err instanceof PlanError || err instanceof TaskStateError) throw new ToolError(err.message);
        throw err;
      }
    });
  }

  private members(projectId: string, db: Queryable = this.ctx.db) {
    return db.query<{ slug: string; name: string; runtime: string; role_summary: string }>(
      `SELECT a.slug, a.name, a.runtime, a.description AS role_summary FROM project_members pm JOIN agents a ON a.id = pm.agent_id
        WHERE pm.project_id = $1 ORDER BY pm.created_at`,
      [projectId],
    );
  }

  private async planView(taskId: string) {
    const task = await this.ctx.db.one("SELECT plan, status FROM tasks WHERE id = $1", [taskId]);
    const plan = TaskPlan.fromJson(task?.["plan"]);
    return { task_status: task?.["status"], subtasks: plan.toPanel(), ready: plan.readyKeys(), unresolved: plan.unresolvedKeys(), counts: plan.counts() };
  }

  private async assertAgents(s: Scope, nodes: { agent?: unknown }[]): Promise<void> {
    const slugs = new Set((await this.members(s.task["project_id"] as string, s.tx)).map((m) => m.slug));
    for (const n of nodes) {
      if (n.agent && !slugs.has(String(n.agent))) {
        throw new ToolError(`agent "${String(n.agent)}" is not a member of this project (members: ${[...slugs].join(", ") || "none"})`);
      }
    }
  }

  private async planTask(s: Scope, args: Record<string, unknown>) {
    if (!s.plan.isEmpty) throw new ToolError("a plan already exists — use modify_plan to add or change subtasks");
    const subtasks = args["subtasks"];
    if (!Array.isArray(subtasks) || subtasks.length === 0) throw new ToolError("'subtasks' must be a non-empty list");
    await this.assertAgents(s, subtasks as { agent?: unknown }[]);
    s.plan.add(subtasks as Record<string, unknown>[]);
    await s.event("plan_created", "lead", { subtasks: s.plan.all.map((n) => ({ key: n.key, title: n.title, agent: n.agent, depends_on: n.depends_on })) });
    return { subtasks: s.plan.toPanel(), ready: s.plan.readyKeys() };
  }

  private async modifyPlan(s: Scope, args: Record<string, unknown>) {
    const add = Array.isArray(args["add"]) ? (args["add"] as Record<string, unknown>[]) : [];
    const update = Array.isArray(args["update"]) ? (args["update"] as Record<string, unknown>[]) : [];
    if (add.length + update.length === 0) throw new ToolError("pass 'add' and/or 'update'");
    await this.assertAgents(s, [...add, ...update] as { agent?: unknown }[]);
    for (const patch of update) {
      const node = s.plan.get(str(patch["key"]));
      if (!node) throw new ToolError(`no subtask with key "${str(patch["key"])}"`);
      if (node.status === "done") throw new ToolError(`subtask "${node.key}" is already approved; add a new subtask instead of changing it`);
      if (node.status === "in_progress") throw new ToolError(`subtask "${node.key}" is running; stop_subtask it before changing it`);
      s.plan.patch(node.key, patch);
    }
    if (add.length) s.plan.add(add);
    await s.event("plan_modified", "lead", { added: add.map((n) => n["key"]), updated: update.map((n) => n["key"]) });
    return { subtasks: s.plan.toPanel(), ready: s.plan.readyKeys() };
  }

  private findNode(s: Scope, args: Record<string, unknown>): Subtask {
    const key = str(args["subtask_key"]);
    const sessionId = str(args["session_id"]);
    const node = key ? s.plan.get(key) : s.plan.all.find((n) => n.latest_run_session_id === sessionId);
    if (!node) throw new ToolError(key ? `no subtask with key "${key}"` : "pass subtask_key or the member's session_id");
    return node;
  }

  /** Start (or restart) a member on a ready node. Non-blocking for the lead. */
  private async dispatch(taskId: string, args: Record<string, unknown>) {
    const started = await this.leadWrite(taskId, async (s) => {
      const node = this.findNode(s, args);
      if (!["planned", "rework", "paused"].includes(node.status)) {
        throw new ToolError(`subtask "${node.key}" is ${node.status}; only planned, rework or paused subtasks can be dispatched`);
      }
      if (!s.plan.depsDone(node.key)) {
        const waiting = node.depends_on.filter((d) => s.plan.get(d)?.status !== "done");
        throw new ToolError(`subtask "${node.key}" is blocked on unfinished dependencies: ${waiting.join(", ")}`);
      }
      const slug = str(args["agent"]) || node.agent;
      if (!slug) throw new ToolError(`subtask "${node.key}" has no agent; pass one (see list_members)`);
      await this.assertAgents(s, [{ agent: slug }]);
      const goal = str(args["goal"]) || node.goal;
      const refs = Array.isArray(args["refs"]) ? (args["refs"] as unknown[]).map(String) : [];

      // A retry goes back to the same member so it keeps its context.
      const prior = node.latest_run_session_id
        ? await s.tx.one(
            "SELECT s.* FROM sessions s JOIN task_runs r ON r.session_id = s.id WHERE s.id = $1 AND r.agent_slug = $2 AND s.status <> 'running'",
            [node.latest_run_session_id, slug],
          )
        : null;
      let session = prior;
      if (session) {
        await s.tx.query("UPDATE task_runs SET status = 'active', ended_at = NULL WHERE session_id = $1", [session["id"]]);
      } else {
        const agent = await s.tx.one("SELECT * FROM agents WHERE org_id = $1 AND slug = $2", [s.task["org_id"], slug]);
        session = await createSession(
          this.ctx,
          {
            orgId: s.task["org_id"] as string,
            ownerId: s.task["owner_id"] as string,
            agent: agent as Row,
            deviceId: s.task["device_id"] as string,
            projectId: s.task["project_id"] as string,
            cwd: s.task["cwd"] as string,
            title: `${String(s.task["title"])} · ${node.title}`,
            metadata: { valuz: { task: { task_id: taskId, role: "member", subtask_key: node.key } } },
          },
          s.tx,
        );
        await s.tx.query("INSERT INTO task_runs (id, task_id, session_id, agent_slug, kind, subtask_key) VALUES ($1, $2, $3, $4, 'subtask', $5)", [
          crypto.randomUUID(), taskId, session["id"], slug, node.key,
        ]);
      }
      const brief = memberBrief(node, goal, refs);
      s.plan.setStatus(node.key, "in_progress", { attempts: node.attempts + 1, latest_run_session_id: session["id"] as string });
      if (str(args["agent"])) s.plan.patch(node.key, { agent: slug });
      await s.event("subtask_dispatched", "lead", { subtask_key: node.key, agent: slug, attempt: node.attempts }, session["id"] as string);
      return { session: session as Row, key: node.key, slug, brief, task: s.task };
    });

    try {
      await dispatchTurn(this.ctx, started.session, { text: started.brief, attachments: [], additional_context: "" }, await this.ownerActor(started.task));
    } catch (err) {
      const reason = `could not start the member: ${(err as Error).message}`;
      await this.mutate(taskId, async (s) => {
        s.plan.setStatus(started.key, "rework", { review_feedback: reason });
        await s.tx.query("UPDATE task_runs SET status = 'archived', ended_at = now() WHERE session_id = $1", [started.session["id"]]);
        await s.event("subtask_dispatch_failed", "system", { subtask_key: started.key, reason });
      });
      throw new ToolError(`${reason}. The subtask is back in rework; dispatch it again once the device is reachable.`);
    }
    return { status: "dispatched", subtask_key: started.key, session_id: started.session["id"], agent: started.slug };
  }

  /** Block until dispatched members report (or the wait times out). Meant to be looped. */
  private async awaitMembers(caller: Caller, args: Record<string, unknown>) {
    const taskId = caller.role.task_id;
    const leadSession = caller.session["id"] as string;
    const keys = Array.isArray(args["keys"]) && args["keys"].length ? (args["keys"] as unknown[]).map(String) : null;
    const mode = args["mode"] === "all" ? "all" : "any";
    const timeoutS = Math.min(Math.max(Number(args["timeout_s"]) || 120, 1), 600);
    const deadline = Date.now() + timeoutS * 1000;
    const results: Record<string, unknown>[] = [];

    let notify: (() => void) | null = null;
    const unsubscribe = await this.ctx.pubsub.subscribe(wakeChannel(taskId), () => notify?.());
    try {
      for (;;) {
        const got = await this.ctx.db.query<{ text: string; payload: Record<string, unknown> }>(
          `UPDATE task_mailbox SET consumed_at = now()
            WHERE id IN (SELECT id FROM task_mailbox WHERE session_id = $1 AND consumed_at IS NULL AND kind = 'member_done'
                           AND ($2::text[] IS NULL OR payload->>'subtask_key' = ANY($2::text[])) ORDER BY id FOR UPDATE SKIP LOCKED)
            RETURNING text, payload`,
          [leadSession, keys],
        );
        for (const m of got) results.push({ ...m.payload, summary: m.text });

        const task = await this.ctx.db.one("SELECT plan, status FROM tasks WHERE id = $1", [taskId]);
        const plan = TaskPlan.fromJson(task?.["plan"]);
        const running = plan.keysIn("in_progress").filter((k) => !keys || keys.includes(k));
        if (results.length > 0 && (mode === "any" || running.length === 0)) return { results, pending: running };
        if (running.length === 0) {
          return {
            results,
            error: keys ? `none of ${keys.join(", ")} is running` : "no dispatched member is in flight — dispatch first",
            ready: plan.readyKeys(),
            awaiting_review: plan.keysIn("in_review"),
          };
        }
        // Someone talked to the task while we were parked: surface it instead of sleeping on.
        const mail = await this.ctx.db.one("SELECT 1 FROM task_mailbox WHERE session_id = $1 AND consumed_at IS NULL AND kind <> 'member_done' LIMIT 1", [leadSession]);
        if (task?.["status"] !== "active" || mail || Date.now() >= deadline) {
          return {
            results,
            pending: running,
            pending_status: Object.fromEntries(running.map((k) => [k, "running"])),
            note: mail ? "a new message is waiting for you — end this wait and read it" : task?.["status"] !== "active" ? `the task is ${String(task?.["status"])}` : "timed out; members are still running — call await_members again",
          };
        }
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

  private async review(s: Scope, args: Record<string, unknown>) {
    const node = this.findNode(s, args);
    const feedback = str(args["feedback"]);
    if (args["decision"] === "approve") {
      if (node.status === "done") return { subtask_key: node.key, already_done: true, ready: s.plan.readyKeys() };
      if (node.attempts === 0) throw new ToolError(`subtask "${node.key}" was never dispatched — dispatch it first`);
      if (node.status === "in_progress") throw new ToolError(`subtask "${node.key}" is still running — await_members before reviewing it`);
      s.plan.setStatus(node.key, "done", { review_feedback: feedback || null });
      await s.tx.query("UPDATE task_runs SET status = 'completed', ended_at = now() WHERE session_id = $1", [node.latest_run_session_id]);
      await s.event("subtask_approved", "lead", { subtask_key: node.key, feedback }, node.latest_run_session_id);
      return { subtask_key: node.key, status: "done", ready: s.plan.readyKeys(), unresolved: s.plan.unresolvedKeys() };
    }
    if (args["decision"] !== "rework") throw new ToolError("decision must be 'approve' or 'rework'");
    if (!feedback) throw new ToolError("rework needs 'feedback' telling the member what to change");
    if (node.status !== "in_review") throw new ToolError(`subtask "${node.key}" is ${node.status}; only a reported subtask (in_review) can be sent back`);
    const member = await s.tx.one("SELECT * FROM sessions WHERE id = $1", [node.latest_run_session_id]);
    s.plan.setStatus(node.key, "rework", { review_feedback: feedback });
    await s.event("subtask_rework", "lead", { subtask_key: node.key, feedback }, node.latest_run_session_id);
    if (!member) return { subtask_key: node.key, status: "rework", note: "the member's session is gone — dispatch the subtask again" };
    // Straight back to the same member, which still holds its working context.
    s.plan.setStatus(node.key, "in_progress", { attempts: node.attempts + 1 });
    await s.mailbox(member["id"] as string, "lead_message", `The lead reviewed your work and asks for changes:\n\n${feedback}\n\nRevise it, then report again.`);
    const task = s.task;
    s.after(async () => {
      const woke = await this.wake(task, member["id"] as string).catch(() => false);
      if (woke) return;
      await this.mutate(task["id"] as string, async (x) => {
        if (x.plan.get(node.key)?.status === "in_progress") x.plan.setStatus(node.key, "rework");
      });
    });
    return { subtask_key: node.key, status: "in_progress", session_id: member["id"], note: "feedback sent; await_members to collect the revision" };
  }

  private async stopSubtask(s: Scope, args: Record<string, unknown>) {
    const node = this.findNode(s, args);
    if (node.status !== "in_progress") throw new ToolError(`subtask "${node.key}" is ${node.status}, not running`);
    const sessionId = node.latest_run_session_id as string;
    const reason = str(args["reason"]) || "stopped by the lead";
    s.plan.setStatus(node.key, "rework", { review_feedback: reason });
    await s.tx.query("UPDATE task_runs SET status = 'rejected', ended_at = now() WHERE session_id = $1", [sessionId]);
    // A synthetic report, so an await on this key returns instead of hanging.
    await s.mailbox(s.task["lead_session_id"] as string, "member_done", `Stopped by the lead: ${reason}`, {
      subtask_key: node.key, session_id: sessionId, agent: node.agent ?? "", status: "cancelled",
    });
    await s.event("subtask_stopped", "lead", { subtask_key: node.key, reason }, sessionId);
    const task = s.task;
    s.after(() => this.interrupt(task, [sessionId]));
    return { subtask_key: node.key, status: "rework", note: "stopped; re-dispatch it (optionally after modify_plan) or leave it" };
  }

  private async send(s: Scope, args: Record<string, unknown>) {
    const sessionId = str(args["session_id"]);
    const text = str(args["text"]);
    if (!text) throw new ToolError("'text' is required");
    const run = await s.tx.one("SELECT 1 FROM task_runs WHERE task_id = $1 AND session_id = $2 AND kind = 'subtask'", [s.task["id"], sessionId]);
    if (!run) throw new ToolError("that session is not a member of this task");
    await s.mailbox(sessionId, "lead_message", text);
    const task = s.task;
    s.after(async () => void (await this.wake(task, sessionId).catch(() => false)));
    return { delivered: "queued — the member reads it at its next turn boundary" };
  }

  private async finish(s: Scope, args: Record<string, unknown>) {
    const status = args["status"] === "stopped" ? "stopped" : "completed";
    if (s.task["status"] !== "active") throw new ToolError(`the task is already ${String(s.task["status"])}`);
    const running = s.plan.keysIn("in_progress");
    if (status === "completed") {
      const unresolved = s.plan.unresolvedKeys();
      if (unresolved.length > 0) {
        throw new ToolError(`cannot complete: unresolved subtasks remain (${unresolved.join(", ")}). Finish and approve them, or finish with status="stopped".`);
      }
    } else if (running.length > 0 && args["force"] !== true) {
      throw new ToolError(`members are still running (${running.join(", ")}). A quiet member is usually mid-work, not dead — await it, stop_subtask it, or pass force=true to terminate anyway.`);
    }
    const result = { summary: str(args["summary"]), artifacts: Array.isArray(args["artifacts"]) ? (args["artifacts"] as unknown[]).map(String) : [] };
    if (!result.summary) throw new ToolError("'summary' is required");
    await s.setStatus(status, { result: json(result), ended_at: new Date() });
    await s.tx.query("UPDATE task_runs SET status = 'completed', ended_at = now() WHERE task_id = $1 AND kind = 'lead'", [s.task["id"]]);
    if (running.length > 0) {
      for (const key of running) s.plan.setStatus(key, "paused");
      const rows = await s.tx.query<{ session_id: string }>(
        "UPDATE task_runs SET status = 'paused' WHERE task_id = $1 AND status = 'active' AND kind = 'subtask' RETURNING session_id",
        [s.task["id"]],
      );
      const task = s.task;
      s.after(() => this.interrupt(task, rows.map((r) => r.session_id)));
    }
    await s.event(status === "completed" ? "task_completed" : "task_stopped", "lead", result);
    const task = s.task;
    s.after(() => this.ctx.notify(task["owner_id"] as string, task["org_id"] as string, {
      kind: `task_${status}`, title: `任务${status === "completed" ? "已完成" : "已停止"}：${String(task["title"])}`, body: result.summary.slice(0, 300), link: `/tasks/${String(task["id"])}`,
    }));
    return { status, note: "the task is closed — end your turn" };
  }
}
