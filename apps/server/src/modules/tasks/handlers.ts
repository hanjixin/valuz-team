import type { Schema } from "@agent-base/contract";
import { managedCwd } from "@agent-base/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../../infra/auth.ts";
import type { Auth, Ctx, Handler } from "../../infra/context.ts";
import { badRequest, conflict, notFound } from "../../infra/errors.ts";
import * as projects from "../projects/service.ts";
import * as sessionDispatch from "../sessions/dispatch.ts";
import * as sessions from "../sessions/service.ts";
import * as sharing from "../sharing/service.ts";
import { TaskPlan } from "./plan.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const present = (task: service.TaskRow): Schema<"Task"> => ({
  id: task.id,
  project_id: task.project_id,
  title: task.title,
  goal: task.goal,
  status: task.status,
  created_by: task.owner_id,
  lead_agent_slug: task.lead_agent_slug,
  // Who has the task in hand right now: its lead's session, once it has one.
  current_holder: task.lead_session_id ?? "",
  file_path: "",
  created_at: task.created_at.getTime(),
  updated_at: task.updated_at.getTime(),
  trigger: { type: "user" },
});

const presentEvent = (event: service.TaskEventRow): Schema<"TaskEvent"> => ({
  id: String(event.seq),
  sequence: event.seq,
  type: event.type,
  actor: event.actor,
  session_id: event.session_id,
  payload: event.payload,
  created_at: event.created_at.getTime(),
});

/**
 * A task lives in a project: whoever may see the project sees its tasks, and
 * whoever may edit it — or started the task — may steer them.
 */
async function access(ctx: Ctx, auth: Auth, taskId: string, steer = false): Promise<service.TaskRow> {
  const task = UUID.test(taskId)
    ? await ctx.db
        .selectFrom("tasks")
        .selectAll()
        .where("id", "=", taskId)
        .where("org_id", "=", auth.orgId)
        .executeTakeFirst()
    : undefined;
  if (!task) throw notFound("task");
  const project = await projects.require(ctx, auth, task.project_id).catch(() => null);
  if (!project) throw notFound("task");
  if (steer && task.owner_id !== auth.userId) await projects.require(ctx, auth, task.project_id, "edit");
  return task;
}

const caller = async (req: Req, steer = false) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const { task_id } = req.params as { task_id?: string };
  return { ctx, auth, task: task_id === undefined ? null : await access(ctx, auth, task_id, steer) };
};
const steering = async (req: Req) => {
  const found = await caller(req, true);
  return { ...found, task: found.task as service.TaskRow };
};
const viewing = async (req: Req) => {
  const found = await caller(req);
  return { ...found, task: found.task as service.TaskRow };
};

const reload = async (ctx: Ctx, id: string): Promise<service.TaskRow> =>
  ctx.db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

// -- Starting --

async function open(req: Req, draft: boolean): Promise<service.TaskRow> {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const project = await projects.require(ctx, auth, (req.params as { project_id: string }).project_id, "use");
  const input = req.body as Schema<"KickoffTaskRequest">;
  const goal = input.goal.trim();
  if (!goal) throw badRequest("a task needs a goal");
  const deviceId = await sessions.deviceFor(ctx, auth, null, project.device_id);
  const firstLine = goal.split("\n")[0] ?? goal;
  const id = await service.create(req.server, {
    owner: auth,
    projectId: project.id,
    deviceId,
    cwd: project.root_path ?? managedCwd(`project-${project.id}`),
    title: input.title?.trim() || (firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine),
    goal,
    leadAgentSlug: input.lead_agent_slug,
    draft,
  });
  return reload(ctx, id);
}

export const kickoffTask: Handler = async (req, reply) => reply.code(201).send(present(await open(req, false)));

export const draftTask: Handler = async (req, reply) => {
  const task = await open(req, true);
  return reply.code(201).send({
    task_id: task.id,
    status: task.status,
    plan_version: task.plan_version,
    title: task.title,
    lead_agent_slug: task.lead_agent_slug,
  });
};

export const commitTask: Handler = async (req) => {
  const { ctx, auth, task } = await steering(req);
  const { lead_agent_slug } = req.body as Schema<"CommitTaskRequest">;
  if (task.status !== "draft") throw conflict(`this task is ${task.status}, not a draft`, "task_not_draft");
  const committed = await service.commit(ctx, task.id, auth.name, lead_agent_slug);
  return {
    task_id: committed.id,
    lead_session_id: committed.lead_session_id ?? "",
    status: committed.status,
    committed_at: committed.committed_at?.getTime() ?? Date.now(),
  };
};

export const abandonTask: Handler = async (req) => {
  const { ctx, auth, task } = await steering(req);
  await service.abandon(ctx, task.id, auth.name, (req.body as Schema<"AbandonTaskRequest">).reason);
  return { task_id: task.id, status: "abandoned" };
};

// -- Reading --

export const listTasks: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const project = await projects.require(ctx, auth, (req.params as { project_id: string }).project_id);
  const rows = await ctx.db
    .selectFrom("tasks")
    .selectAll()
    .where("project_id", "=", project.id)
    .orderBy("created_at", "desc")
    .execute();
  return { tasks: rows.map(present) };
};

export const listAllTasks: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const visible = (await projects.list(ctx, auth)).map((project) => project.id);
  if (visible.length === 0) return { tasks: [] };
  const rows = await ctx.db
    .selectFrom("tasks")
    .selectAll()
    .where("project_id", "in", visible)
    .orderBy("updated_at", "desc")
    .limit((req.query as { limit?: number }).limit ?? 50)
    .execute();
  return { tasks: rows.map(present) };
};

const eventsOf = (ctx: Ctx, taskId: string, afterSeq = 0) =>
  ctx.db
    .selectFrom("task_events")
    .selectAll()
    .where("task_id", "=", taskId)
    .where("seq", ">", afterSeq)
    .orderBy("seq")
    .execute();

export const getTask: Handler = async (req): Promise<Schema<"TaskDetail">> => {
  const { ctx, task } = await viewing(req);
  const plan = TaskPlan.fromJson(task.plan);
  const runs = await ctx.db
    .selectFrom("task_runs")
    .selectAll()
    .where("task_id", "=", task.id)
    .orderBy("sequence")
    .execute();
  return {
    task: present(task),
    runs: runs.map((run, index) => {
      const node = run.subtask_key ? plan.get(run.subtask_key) : undefined;
      return {
        id: run.id,
        session_id: run.session_id,
        agent_slug: run.agent_slug,
        sequence: index + 1,
        kind: run.kind,
        status: run.status,
        label: node?.title ?? (run.kind === "lead" ? "lead" : run.subtask_key),
        goal: node?.goal ?? null,
        dispatched_by: run.kind === "lead" ? null : "lead",
        // Every run of a task works in the task's one workspace.
        project_mode: "shared",
        run_dir: null,
        result_manifest: null,
      };
    }),
    events: (await eventsOf(ctx, task.id)).map(presentEvent),
  };
};

export const listTaskEvents: Handler = async (req) => {
  const { ctx, task } = await viewing(req);
  return { events: (await eventsOf(ctx, task.id)).map(presentEvent) };
};

/** The task's timeline as server-sent events: what is stored after `after_seq`, then what happens. */
export const streamTaskEvents: Handler = async (req: FastifyRequest, reply: FastifyReply) => {
  const { ctx, task } = await viewing(req);
  let cursor = (req.query as { after_seq?: number }).after_seq ?? 0;
  const deliver = (event: service.TaskEventRow): void => {
    if (event.seq <= cursor) return;
    cursor = event.seq;
    reply.sse({ id: String(event.seq), event: event.type, data: JSON.stringify(presentEvent(event)) });
  };
  let held: service.TaskEventRow[] | null = [];
  const unsubscribe = await ctx.pubsub.subscribe(service.taskChannel(task.id), (payload) => {
    // Dates do not survive the trip through Redis.
    const event = payload as service.TaskEventRow;
    const revived = { ...event, created_at: new Date(event.created_at) };
    if (held) held.push(revived);
    else deliver(revived);
  });
  const heartbeat = setInterval(() => reply.sse({ event: "heartbeat", data: JSON.stringify({ seq: cursor }) }), 15_000);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  (await eventsOf(ctx, task.id, cursor)).forEach(deliver);
  held.forEach(deliver);
  held = null;
  reply.sse({ event: "heartbeat", data: JSON.stringify({ seq: cursor }) });
  return reply;
};

export const getTaskPlan: Handler = async (req) => {
  const { ctx, task } = await viewing(req);
  return service.planView(ctx, task.id);
};

export const getTaskUsage: Handler = async (req): Promise<Schema<"TaskTokenUsage">> => {
  const { ctx, task } = await viewing(req);
  const rows = await ctx.db
    .selectFrom("task_runs as r")
    .leftJoin("messages as m", "m.session_id", "r.session_id")
    .select(["r.session_id", "r.agent_slug", "r.kind", "r.subtask_key", "r.sequence"])
    .select((eb) => [
      eb.fn.coalesce(eb.fn.sum<number>("m.input_tokens"), eb.lit(0)).as("input_tokens"),
      eb.fn.coalesce(eb.fn.sum<number>("m.output_tokens"), eb.lit(0)).as("output_tokens"),
      eb.fn.coalesce(eb.fn.sum<number>("m.cache_read_tokens"), eb.lit(0)).as("cache_read_tokens"),
      eb.fn.coalesce(eb.fn.sum<number>("m.cache_write_tokens"), eb.lit(0)).as("cache_write_tokens"),
    ])
    .where("r.task_id", "=", task.id)
    .groupBy(["r.session_id", "r.agent_slug", "r.kind", "r.subtask_key", "r.sequence"])
    .orderBy("r.sequence")
    .execute();
  const runs = rows.map((row, index) => {
    const counts = {
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
      cache_read_tokens: Number(row.cache_read_tokens),
      cache_write_tokens: Number(row.cache_write_tokens),
    };
    return {
      session_id: row.session_id,
      agent_slug: row.agent_slug,
      kind: row.kind,
      sequence: index + 1,
      label: row.subtask_key,
      ...counts,
      total_tokens: Object.values(counts).reduce((a, b) => a + b, 0),
    };
  });
  const sum = (key: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "total_tokens") =>
    runs.reduce((total, run) => total + run[key], 0);
  return {
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    cache_read_tokens: sum("cache_read_tokens"),
    cache_write_tokens: sum("cache_write_tokens"),
    total_tokens: sum("total_tokens"),
    runs,
  };
};

// -- Steering --

export const interveneTask: Handler = async (req) => {
  const { ctx, auth, task } = await steering(req);
  const { action, text, goal } = req.body as Schema<"InterveneRequest">;
  if (action === "note") {
    if (!text?.trim()) throw badRequest("a note needs text");
    await service.inject(ctx, task.id, text, auth.name);
  } else if (action === "revise_goal") {
    if (!goal?.trim()) throw badRequest("say what the goal is now");
    await service.reviseGoal(ctx, task.id, goal.trim(), auth.name);
  } else {
    await service.intervene(ctx, task.id, action, auth.name);
  }
  return present(await reload(ctx, task.id));
};

export const injectIntoTask: Handler = async (req): Promise<Schema<"InjectTaskResult">> => {
  const { ctx, auth, task } = await steering(req);
  const { text } = req.body as Schema<"InjectTaskRequest">;
  if (!text.trim()) throw badRequest("there is nothing to send");
  // A message to a task that is not running does not vanish: the caller is told why it was not delivered.
  if (task.status !== "active")
    return { delivered: false, lead_session_id: task.lead_session_id, reason: `TASK_${task.status.toUpperCase()}` };
  return { delivered: true, lead_session_id: await service.inject(ctx, task.id, text, auth.name), reason: null };
};

const writePlan: Handler = async (req) => {
  const { ctx, auth, task } = await steering(req);
  return service.writePlan(ctx, task.id, auth.name, req.body as Schema<"PlanWriteRequest">);
};
export const planTask = writePlan;
export const modifyTaskPlan = writePlan;

/** Deleting a task stops whatever it still has running and takes its runs' conversations with it. */
export const deleteTask: Handler = async (req, reply) => {
  const { ctx, auth, task } = await steering(req);
  if (["active", "paused", "blocked"].includes(task.status)) await service.intervene(ctx, task.id, "stop", auth.name);
  await ctx.db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("sessions")
      .where("id", "in", (qb) => qb.selectFrom("task_runs").select("session_id").where("task_id", "=", task.id))
      .execute();
    await tx.deleteFrom("tasks").where("id", "=", task.id).execute();
  });
  return reply.code(204).send();
};

// -- Runs: everything in flight, chats and tasks alike --

export const listRuns: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const {
    status = "running",
    project_id,
    limit = 50,
  } = req.query as { status?: string; project_id?: string; limit?: number };
  const [all, visible] = await Promise.all([
    sessions.list(ctx, auth, project_id ? { projectId: project_id } : {}),
    projects.list(ctx, auth),
  ]);
  const projectsById = new Map(visible.map((project) => [project.id, project]));
  const wanted = all.filter((session) => (session.status === "running") === (status === "running")).slice(0, limit);
  return {
    runs: wanted.map((session): Schema<"RunSummary"> => {
      const project = projectsById.get(session.project_id);
      return {
        session_id: session.id,
        source_kind: session.task_id ? "task" : project?.kind === "chat" ? "assistant" : "project_chat",
        origin: session.task_id ? "task" : "user",
        project_id: session.project_id,
        project_name: project?.name ?? null,
        task_id: session.task_id ?? null,
        title: session.name ?? session.last_user_message_text ?? "",
        status: session.status,
        current_todo: null,
        last_message: session.last_user_message_text ?? null,
        last_output: null,
        last_event: null,
        model: session.locked_model_id ?? null,
        runtime: session.runtime_provider ?? null,
        updated_at: session.updated_at,
        background: false,
      };
    }),
  };
};

/** Stop one member of a task. Its subtask goes back to the lead as interrupted. */
export const stopMember: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const sessionId = (req.params as { session_id: string }).session_id;
  const { row, permission } = await sessions.access(ctx, auth, sessionId);
  if (!sharing.permissionAtLeast(permission, "control")) throw notFound("session");
  if (row.status !== "running") return { stopped: false };
  await sessionDispatch.interrupt(ctx, auth, sessionId);
  return { stopped: true };
};
