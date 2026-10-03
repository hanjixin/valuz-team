/**
 * Tasks — goal-driven multi-agent work inside a project. A task is reachable
 * through its project: `edit` on the project lets a teammate steer it,
 * `view`/`use` lets them watch.
 */
import { type Permission, maxPermission, permissionAtLeast } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aclParams, audit, getPermission, permissionSql, requirePermission } from "../acl.ts";
import { withAuth } from "../auth.ts";
import { type Auth, type Ctx, isOrgAdmin } from "../context.ts";
import type { Row } from "../db.ts";
import { HttpError, badRequest, forbidden, isUuid, notFound, parse, uuidParam } from "../http.ts";
import { TaskStateError } from "../tasks/plan.ts";
import { taskChannel } from "../tasks/service.ts";
import { streamEvents } from "./sessions.ts";

const CreateTask = z.object({
  goal: z.string().min(1).max(100_000),
  title: z.string().max(256).optional(),
  lead_agent_slug: z.string().optional(),
  device_id: z.string().uuid().optional(),
  cwd: z.string().max(4096).optional(),
  /** Create without starting; launch later with `:commit`. */
  draft: z.boolean().default(false),
});

type Params = Record<string, string>;

export function taskRoutes(app: FastifyInstance, ctx: Ctx): void {
  const access = async (auth: Auth, id: string): Promise<{ task: Row; permission: Permission }> => {
    const task = await ctx.db.one("SELECT * FROM tasks WHERE id = $1 AND org_id = $2", [uuidParam(id, "task"), auth.orgId]);
    if (!task) throw notFound("task");
    let permission: Permission | null = task["owner_id"] === auth.userId || isOrgAdmin(auth) ? "admin" : null;
    if (!permission) {
      const p = await getPermission(ctx.db, auth, "project", task["project_id"] as string);
      permission = maxPermission(null, p ? (permissionAtLeast(p, "edit") ? "control" : "view") : null);
    }
    if (!permission) throw notFound("task");
    return { task, permission };
  };

  const steer = async (auth: Auth, id: string): Promise<Row> => {
    const { task, permission } = await access(auth, id);
    if (!permissionAtLeast(permission, "control")) throw forbidden('steering this task needs "edit" permission on its project');
    return task;
  };

  /** Illegal status moves are the caller's mistake, not a server fault. */
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TaskStateError) throw new HttpError(409, "invalid_transition", err.message);
      throw err;
    }
  };

  const eventsAfter = (taskId: string, afterSeq: number, limit: number) =>
    ctx.db.query<Row & { seq: number }>(
      "SELECT seq, task_id, type, actor, session_id, payload, created_at FROM task_events WHERE task_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
      [taskId, afterSeq, limit],
    );

  const LIST = `SELECT t.id, t.project_id, t.owner_id, t.title, t.goal, t.status, t.lead_agent_slug, t.lead_session_id, t.result,
                       t.created_at, t.updated_at, t.ended_at, u.name AS owner_name,
                       (SELECT count(*)::int FROM jsonb_array_elements(t.plan->'subtasks')) AS subtask_count,
                       (SELECT count(*)::int FROM jsonb_array_elements(t.plan->'subtasks') n WHERE n->>'status' = 'done') AS done_count
                  FROM tasks t JOIN users u ON u.id = t.owner_id`;

  withAuth(app, ctx, (r) => {
    r.post("/v1/projects/:id/tasks", async (req, reply) => {
      const projectId = uuidParam((req.params as Params)["id"], "project");
      await requirePermission(ctx.db, req.auth, "project", projectId, "use");
      const body = parse(CreateTask, req.body);
      const project = (await ctx.db.one("SELECT * FROM projects WHERE id = $1", [projectId])) as Row;

      const team = await ctx.db.query<{ slug: string }>(
        "SELECT a.slug FROM project_members pm JOIN agents a ON a.id = pm.agent_id WHERE pm.project_id = $1 ORDER BY pm.created_at",
        [projectId],
      );
      if (team.length === 0) throw badRequest("deploy at least one agent to the project before starting a task", "no_members");
      const lead = body.lead_agent_slug ?? (project["default_lead_agent_slug"] as string | null) ?? team[0]?.slug ?? "";
      if (!team.some((m) => m.slug === lead)) throw badRequest(`agent "${lead}" is not deployed to this project`, "agent_unavailable");

      const deviceId = body.device_id ?? (project["device_id"] as string | null);
      if (!deviceId) throw badRequest("device_id is required (the project has no device bound)", "device_required");
      await requirePermission(ctx.db, req.auth, "device", deviceId, "use");
      const cwd = body.cwd ?? (project["root_path"] as string | null);
      if (!cwd) throw badRequest("cwd is required (the project has no folder bound)", "cwd_required");

      const task = await ctx.tasks.create({
        orgId: req.auth.orgId,
        ownerId: req.auth.userId,
        projectId,
        title: body.title || body.goal.split("\n")[0]?.slice(0, 80) || "Task",
        goal: body.goal,
        leadAgentSlug: lead,
        deviceId,
        cwd,
        draft: body.draft,
      });
      await audit(ctx.db, req.auth, "task.create", { type: "task", id: task["id"] as string }, { project_id: projectId, lead });
      return reply.code(201).send({ ...task, permission: "admin" });
    });

    r.get("/v1/projects/:id/tasks", async (req) => {
      const projectId = uuidParam((req.params as Params)["id"], "project");
      await requirePermission(ctx.db, req.auth, "project", projectId, "view");
      return { data: await ctx.db.query(`${LIST} WHERE t.project_id = $1 ORDER BY t.created_at DESC LIMIT 200`, [projectId]) };
    });

    r.get("/v1/tasks", async (req) => ({
      data: await ctx.db.query(
        `SELECT * FROM (${LIST} JOIN projects r ON r.id = t.project_id
                         WHERE t.org_id = $2::uuid AND (t.owner_id = $1::uuid OR (${permissionSql("project")}) IS NOT NULL)) x
          ORDER BY updated_at DESC LIMIT 200`,
        aclParams(req.auth),
      ),
    }));

    r.get("/v1/tasks/:id", async (req) => {
      const { task, permission } = await access(req.auth, (req.params as Params)["id"] ?? "");
      return { ...(await ctx.tasks.view(task["id"] as string)), permission };
    });

    r.get("/v1/tasks/:id/plan", async (req) => {
      const { task } = await access(req.auth, (req.params as Params)["id"] ?? "");
      const view = await ctx.tasks.view(task["id"] as string);
      return { subtasks: view["plan"], ready: view["ready"], unresolved: view["unresolved"], counts: view["counts"], plan_version: view["plan_version"] };
    });

    r.get("/v1/tasks/:id/events", async (req) => {
      const { task } = await access(req.auth, (req.params as Params)["id"] ?? "");
      const q = parse(z.object({ after_seq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(200) }), req.query);
      const data = await eventsAfter(task["id"] as string, q.after_seq, q.limit);
      return { data, next_seq: data.at(-1)?.seq ?? q.after_seq };
    });

    r.get("/v1/tasks/:id/events/stream", async (req, reply) => {
      const { task } = await access(req.auth, (req.params as Params)["id"] ?? "");
      const id = task["id"] as string;
      await streamEvents(ctx, req, reply, taskChannel(id), (after) => eventsAfter(id, after, 500) as never);
    });

    // Custom verbs: POST /v1/tasks/{id}:intervene | :inject | :commit | :abandon
    r.post("/v1/tasks/:target", async (req) => {
      const [id = "", verb = ""] = ((req.params as Params)["target"] ?? "").split(":");
      if (!isUuid(id) || !verb) throw notFound("route");
      const task = await steer(req.auth, id);
      const taskId = task["id"] as string;
      switch (verb) {
        case "intervene": {
          const { action } = parse(z.object({ action: z.enum(["pause", "resume", "stop"]) }), req.body);
          await audit(ctx.db, req.auth, `task.${action}`, { type: "task", id: taskId });
          return guarded(() => ctx.tasks.intervene(taskId, action, req.auth.name));
        }
        case "inject": {
          const { text } = parse(z.object({ text: z.string().min(1).max(100_000) }), req.body);
          await ctx.tasks.inject(taskId, text, req.auth.name);
          return { delivered: true };
        }
        case "commit":
          await guarded(() => ctx.tasks.commit(taskId));
          return ctx.tasks.view(taskId);
        case "abandon":
          await guarded(() => ctx.tasks.abandon(taskId));
          return ctx.tasks.view(taskId);
        default:
          throw notFound("route");
      }
    });
  });
}
