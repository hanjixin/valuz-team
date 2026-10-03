/**
 * The `project` toolkit — what an ordinary session can do for its project
 * beyond its own turn: keep the project's memory, and hand a goal to the team
 * as a task (the chat-side counterpart of the lead's task toolkit).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "./acl.ts";
import { withAuth } from "./auth.ts";
import type { Ctx } from "./context.ts";
import type { Row } from "./db.ts";
import { notFound, parse, uuidParam } from "./http.ts";
import { ToolError, type Toolkit, mountToolkit } from "./mcp.ts";
import { taskRoleOf } from "./tasks/prompts.ts";

export const PROJECT_MCP_PATH = "/v1/mcp/project";
const MEMORY_LIMIT = 2000;
const MEMORY_PROMPT_BUDGET = 6000;

interface Caller {
  session: Row;
  projectId: string;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const S = { type: "string" };

/** The memory block injected into every session of the project (newest entries win the budget). */
export async function memoryPrompt(ctx: Ctx, projectId: string): Promise<string> {
  const rows = await ctx.db.query<{ content: string }>("SELECT content FROM project_memories WHERE project_id = $1 ORDER BY created_at DESC LIMIT 200", [projectId]);
  const kept: string[] = [];
  let used = 0;
  for (const { content } of rows) {
    if (used + content.length > MEMORY_PROMPT_BUDGET) break;
    kept.unshift(`- ${content}`);
    used += content.length;
  }
  return kept.length ? `## Project memory\nFacts the team recorded in earlier sessions:\n${kept.join("\n")}` : "";
}

/** For a task's lead and members: they keep the memory but coordinate through the task itself. */
export const PROJECT_MEMORY_NOTE =
  "## Project tools\nUse `remember` to record a durable fact about this project (a decision, a preference, where something lives) so future sessions start with it.";

export const PROJECT_TOOLS_NOTE =
  "## Project tools\nUse `remember` to record a durable fact about this project (a decision, a preference, where something lives) so future sessions start with it — not for things only this conversation needs. For work that needs several agents, use `create_task` to hand the goal to the project's team instead of doing it all yourself.";

function toolkit(ctx: Ctx): Toolkit<Caller> {
  const ownTask = async (caller: Caller, taskId: unknown): Promise<string> => {
    const task = await ctx.db.one("SELECT id FROM tasks WHERE id::text = $1 AND project_id = $2", [String(taskId ?? ""), caller.projectId]);
    if (!task) throw new ToolError(`no task "${String(taskId)}" in this project — use list_tasks`);
    return task["id"] as string;
  };
  return {
    path: PROJECT_MCP_PATH,
    name: "project",
    authorize: (session) => (session["project_id"] ? { session, projectId: session["project_id"] as string } : null),
    tools: [
      { name: "remember", description: "Record one durable fact about this project so every future session starts with it. One fact per call, stated so it makes sense on its own.", inputSchema: obj({ content: { ...S, description: "The fact, in one or two sentences." } }, ["content"]) },
      { name: "list_memory", description: "List everything recorded in this project's memory.", inputSchema: obj({}) },
      { name: "create_task", description: "Hand a goal to the project's agent team as a multi-agent task. A lead agent plans it, dispatches subtasks to members, reviews them and finishes. Returns immediately with the task id; the work continues in the background.", inputSchema: obj({ goal: { ...S, description: "What the team should achieve, with enough context to act on." }, title: S, lead_agent: { ...S, description: "Slug of the project member that leads (optional)." } }, ["goal"]) },
      { name: "list_tasks", description: "List this project's tasks with their status and progress.", inputSchema: obj({}) },
      { name: "get_task", description: "Read one task: status, plan with each subtask's state, and its result once finished.", inputSchema: obj({ task_id: S }, ["task_id"]) },
      { name: "inject_into_task", description: "Send a message to a running task's lead (a correction, new information, or a request to stop). The lead reads it at its next turn.", inputSchema: obj({ task_id: S, text: S }, ["task_id", "text"]) },
    ],
    call: async (caller, tool, args) => {
      const { session, projectId } = caller;
      switch (tool) {
        case "remember": {
          const content = String(args["content"] ?? "").trim();
          if (!content) throw new ToolError("'content' is required");
          if (content.length > MEMORY_LIMIT) throw new ToolError(`a memory is one fact — keep it under ${MEMORY_LIMIT} characters`);
          const dup = await ctx.db.one("SELECT 1 FROM project_memories WHERE project_id = $1 AND content = $2", [projectId, content]);
          if (dup) return { remembered: false, note: "this is already in the project's memory" };
          await ctx.db.query("INSERT INTO project_memories (id, org_id, project_id, content, source, author_id, session_id) VALUES ($1, $2, $3, $4, 'agent', $5, $6)", [
            crypto.randomUUID(), session["org_id"], projectId, content, session["owner_id"], session["id"],
          ]);
          return { remembered: true };
        }
        case "list_memory":
          return { memories: await ctx.db.query("SELECT id, content, source, created_at FROM project_memories WHERE project_id = $1 ORDER BY created_at", [projectId]) };
        case "create_task": {
          // A task's own lead and members coordinate through the task toolkit, not by spawning more tasks.
          if (taskRoleOf(session)) throw new ToolError("a session working for a task cannot start another task");
          const goal = String(args["goal"] ?? "").trim();
          if (!goal) throw new ToolError("'goal' is required");
          const team = await ctx.db.query<{ slug: string }>("SELECT a.slug FROM project_members pm JOIN agents a ON a.id = pm.agent_id WHERE pm.project_id = $1 ORDER BY pm.created_at", [projectId]);
          const project = await ctx.db.one("SELECT default_lead_agent_slug FROM projects WHERE id = $1", [projectId]);
          const lead = String(args["lead_agent"] || project?.["default_lead_agent_slug"] || team[0]?.slug || "");
          if (!team.some((m) => m.slug === lead)) throw new ToolError(`"${lead}" is not a member of this project (members: ${team.map((m) => m.slug).join(", ") || "none"})`);
          const task = await ctx.tasks.create({
            orgId: session["org_id"] as string, ownerId: session["owner_id"] as string, projectId,
            title: String(args["title"] || goal.split("\n")[0]?.slice(0, 80) || "Task"), goal, leadAgentSlug: lead,
            deviceId: session["device_id"] as string, cwd: session["cwd"] as string, draft: false,
          }).catch((err: Error) => {
            throw new ToolError(`could not start the task: ${err.message}`);
          });
          return { task_id: task["id"], status: task["status"], lead_agent: lead, note: "the team is working on it; use get_task to follow progress" };
        }
        case "list_tasks":
          return {
            tasks: await ctx.db.query(
              `SELECT id AS task_id, title, status, lead_agent_slug,
                      (SELECT count(*)::int FROM jsonb_array_elements(plan->'subtasks')) AS subtasks,
                      (SELECT count(*)::int FROM jsonb_array_elements(plan->'subtasks') n WHERE n->>'status' = 'done') AS done
                 FROM tasks WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
              [projectId],
            ),
          };
        case "get_task": {
          const view = await ctx.tasks.view(await ownTask(caller, args["task_id"]));
          return { task_id: view["id"], title: view["title"], status: view["status"], goal: view["goal"], plan: view["plan"], unresolved: view["unresolved"], result: view["result"] };
        }
        case "inject_into_task": {
          const text = String(args["text"] ?? "").trim();
          if (!text) throw new ToolError("'text' is required");
          await ctx.tasks.inject(await ownTask(caller, args["task_id"]), text, "agent").catch((err: Error) => {
            throw new ToolError(err.message);
          });
          return { delivered: true };
        }
        default:
          throw new ToolError(`unknown tool "${tool}"`);
      }
    },
  };
}

export function projectToolRoutes(app: FastifyInstance, ctx: Ctx): void {
  mountToolkit(app, ctx, toolkit(ctx));
  type Params = Record<string, string>;

  withAuth(app, ctx, (r) => {
    r.get("/v1/projects/:id/memory", async (req) => {
      const projectId = uuidParam((req.params as Params)["id"], "project");
      await requirePermission(ctx.db, req.auth, "project", projectId, "view");
      return {
        data: await ctx.db.query(
          "SELECT m.id, m.content, m.source, m.session_id, m.created_at, u.name AS author_name FROM project_memories m LEFT JOIN users u ON u.id = m.author_id WHERE m.project_id = $1 ORDER BY m.created_at",
          [projectId],
        ),
      };
    });

    r.post("/v1/projects/:id/memory", async (req, reply) => {
      const projectId = uuidParam((req.params as Params)["id"], "project");
      await requirePermission(ctx.db, req.auth, "project", projectId, "edit");
      const { content } = parse(z.object({ content: z.string().trim().min(1).max(MEMORY_LIMIT) }), req.body);
      const row = await ctx.db.one(
        "INSERT INTO project_memories (id, org_id, project_id, content, source, author_id) VALUES ($1, $2, $3, $4, 'user', $5) RETURNING id, content, source, created_at",
        [crypto.randomUUID(), req.auth.orgId, projectId, content, req.auth.userId],
      );
      return reply.code(201).send(row);
    });

    r.delete("/v1/projects/:id/memory/:memoryId", async (req, reply) => {
      const projectId = uuidParam((req.params as Params)["id"], "project");
      await requirePermission(ctx.db, req.auth, "project", projectId, "edit");
      const gone = await ctx.db.one("DELETE FROM project_memories WHERE id = $1 AND project_id = $2 RETURNING id", [uuidParam((req.params as Params)["memoryId"], "memory"), projectId]);
      if (!gone) throw notFound("memory");
      return reply.code(204).send();
    });
  });
}
