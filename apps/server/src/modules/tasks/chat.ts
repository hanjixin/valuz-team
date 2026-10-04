/**
 * Handing work to the team from a conversation. An agent talking with a member
 * in a project can draft a task, lay out its plan, start it, and follow it —
 * the conversation-side counterpart of the lead's own toolkit. The task is the
 * member's, exactly as if they had opened it themselves.
 */
import { managedCwd } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { authFor } from "../../infra/auth.ts";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError } from "../../infra/errors.ts";
import { ToolError } from "../../infra/toolkit.ts";
import * as members from "../agents/members.ts";
import * as projects from "../projects/service.ts";
import * as sessions from "../sessions/service.ts";
import { PlanError, TaskStateError } from "./plan.ts";
import { roleOf } from "./prompts.ts";
import * as service from "./service.ts";

export const CHAT_TOOLKIT = { name: "team", path: "/v1/mcp/team" };

export const CHAT_INSTRUCTIONS = [
  "## Team tasks",
  "This project has a team of agents. For work that needs several of them — research plus writing, parallel",
  "pieces, a review step — hand it to the team as a task with the `team` tools instead of doing it all yourself:",
  "`draft_task`, then `plan_task` with the subtasks, then `commit_task` to start it. Start it yourself only when the",
  "user asked you to; otherwise show the plan and let them confirm. `get_task` follows progress, and",
  "`inject_into_task` passes a correction or new information to the task's lead.",
].join("\n");

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const S = { type: "string" };
const TASK_ID = { ...S, description: "The task's id, from draft_task or list_tasks." };
const SUBTASK = obj(
  {
    key: { ...S, description: "Stable, task-unique node key." },
    title: { ...S, description: "Short label for the subtask." },
    goal: { ...S, description: "The scoped, self-contained brief for the member." },
    agent: { ...S, description: "Slug of the project member that runs it (see list_members)." },
    review_criteria: { ...S, description: "The concrete, checkable items the lead will review it against." },
    depends_on: { type: "array", items: S, description: "Keys that must be done before this one can start." },
  },
  ["key", "title"],
);

export const CHAT_TOOLS = [
  {
    name: "list_members",
    description: "List the project's team: each member's slug, name, runtime and what it is for.",
    inputSchema: obj({}),
  },
  {
    name: "draft_task",
    description:
      "Open a draft task for the project's team: a goal a lead agent will drive to completion with the members. Nothing runs until it is committed. Returns the task_id.",
    inputSchema: obj(
      {
        goal: { ...S, description: "What the team should achieve, with enough context to act on." },
        title: { ...S, description: "Short title (defaults to the goal's first line)." },
        lead_agent: { ...S, description: "Slug of the member that leads (defaults to the project's lead)." },
      },
      ["goal"],
    ),
  },
  {
    name: "plan_task",
    description: "Lay down a draft task's plan as subtasks (a DAG). Returns the plan and which keys are ready first.",
    inputSchema: obj({ task_id: TASK_ID, subtasks: { type: "array", items: SUBTASK } }, ["task_id", "subtasks"]),
  },
  {
    name: "modify_plan",
    description: "Revise a task's plan: add subtasks, or update existing ones by key.",
    inputSchema: obj(
      {
        task_id: TASK_ID,
        add: { type: "array", items: SUBTASK },
        update: { type: "array", items: { ...SUBTASK, required: ["key"] } },
      },
      ["task_id"],
    ),
  },
  {
    name: "commit_task",
    description: "Start a draft task: its lead takes the goal and the plan and begins dispatching. Returns at once.",
    inputSchema: obj({ task_id: TASK_ID }, ["task_id"]),
  },
  {
    name: "abandon_task",
    description: "Give up a draft or running task. Irreversible.",
    inputSchema: obj({ task_id: TASK_ID, reason: S }, ["task_id"]),
  },
  {
    name: "inject_into_task",
    description:
      "Send a message to a running task's lead (a correction, new information, a request to stop). The lead reads it at its next turn.",
    inputSchema: obj({ task_id: TASK_ID, text: S }, ["task_id", "text"]),
  },
  {
    name: "list_tasks",
    description: "List this project's tasks with their status and progress.",
    inputSchema: obj({}),
  },
  {
    name: "get_task",
    description: "Read one task: status, plan with each subtask's state, and its result once finished.",
    inputSchema: obj({ task_id: TASK_ID }, ["task_id"]),
  },
];

/** A conversation that may hand work to a team: a member's own, in a real project. */
export interface ChatCaller {
  owner: Auth;
  sessionId: string;
  projectId: string;
  deviceId: string | null;
  /** What the agent is called in the task's timeline. */
  by: string;
}

export async function authorize(ctx: Ctx, sessionId: string): Promise<ChatCaller | null> {
  const session = await sessions.byId(ctx, sessionId);
  // A task's own lead and members coordinate through the task itself, not by opening more tasks.
  if (!session || session.origin === "task" || roleOf(session.metadata)) return null;
  const project = await projects.contextForSession(ctx, session.project_id);
  const owner = await authFor(ctx, session.org_id, session.owner_id);
  if (project?.kind !== "project" || !owner) return null;
  return {
    owner,
    sessionId: session.id,
    projectId: session.project_id,
    deviceId: session.device_id,
    by: session.agent_slug ?? "assistant",
  };
}

/** Whether a session should be offered the toolkit at all: only where there is a team to hand work to. */
export async function available(ctx: Ctx, session: { id: string }): Promise<boolean> {
  const caller = await authorize(ctx, session.id);
  return caller !== null && (await members.teamFor(ctx.db, caller.projectId)).length > 0;
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
type Fields = Record<string, unknown>;
const records = (value: unknown): Fields[] | undefined => (Array.isArray(value) ? (value as Fields[]) : undefined);

async function ownTask(ctx: Ctx, caller: ChatCaller, id: unknown): Promise<service.TaskRow> {
  const task = /^[0-9a-f-]{36}$/i.test(str(id)) ? await service.find(ctx, str(id)) : undefined;
  if (!task || task.project_id !== caller.projectId)
    throw new ToolError(`no task "${str(id)}" in this project — use list_tasks`);
  return task;
}

export async function callTool(app: FastifyInstance, caller: ChatCaller, name: string, args: Fields): Promise<unknown> {
  const ctx = app.ctx;
  try {
    switch (name) {
      case "list_members":
        return {
          members: (await members.teamFor(ctx.db, caller.projectId)).map(({ slug, agent }) => ({
            slug,
            name: agent.name,
            runtime: agent.runtime,
            role_summary: agent.description,
          })),
        };
      case "draft_task": {
        const goal = str(args["goal"]);
        if (!goal) throw new ToolError("'goal' is required");
        const project = await projects.require(ctx, caller.owner, caller.projectId, "use");
        const team = (await members.teamFor(ctx.db, caller.projectId)).map((member) => member.slug);
        const lead = str(args["lead_agent"]) || project.default_lead_agent_slug || team[0] || "";
        if (!team.includes(lead))
          throw new ToolError(`"${lead}" is not a member of this project (members: ${team.join(", ") || "none"})`);
        const firstLine = goal.split("\n")[0] ?? goal;
        const title = str(args["title"]) || (firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine);
        const taskId = await service.create(app, {
          owner: caller.owner,
          projectId: project.id,
          deviceId: await sessions.deviceFor(ctx, caller.owner, caller.deviceId, project.device_id),
          cwd: project.root_path ?? managedCwd(`project-${project.id}`),
          title,
          goal,
          leadAgentSlug: lead,
          draft: true,
        });
        return { task_id: taskId, title, status: "draft", lead_agent: lead };
      }
      case "plan_task":
      case "modify_plan": {
        const task = await ownTask(ctx, caller, args["task_id"]);
        const plan = await service.writePlan(
          ctx,
          task.id,
          caller.by,
          name === "plan_task"
            ? { subtasks: records(args["subtasks"]) ?? [] }
            : { add: records(args["add"]) ?? null, update: records(args["update"]) ?? null },
        );
        return { task_id: task.id, ...plan };
      }
      case "commit_task": {
        const task = await ownTask(ctx, caller, args["task_id"]);
        if (task.status !== "draft") throw new ToolError(`this task is ${task.status}, not a draft`);
        const committed = await service.commit(ctx, task.id, caller.by);
        return {
          task_id: task.id,
          title: task.title,
          status: committed.status,
          note: "the team is working on it; use get_task to follow progress",
        };
      }
      case "abandon_task": {
        const task = await ownTask(ctx, caller, args["task_id"]);
        await service.abandon(ctx, task.id, caller.by, str(args["reason"]) || null);
        return { task_id: task.id, title: task.title, status: "abandoned" };
      }
      case "inject_into_task": {
        const task = await ownTask(ctx, caller, args["task_id"]);
        const text = str(args["text"]);
        if (!text) throw new ToolError("'text' is required");
        // A message to a task that is not running is not lost silently: say why it was not delivered.
        if (task.status !== "active")
          return { task_id: task.id, delivered: false, reason: `TASK_${task.status.toUpperCase()}` };
        await service.inject(ctx, task.id, text, caller.by);
        return { task_id: task.id, delivered: true };
      }
      case "list_tasks":
        return {
          tasks: (await service.recent(ctx, [caller.projectId], { limit: 50 })).map((task) => ({
            task_id: task.id,
            title: task.title,
            status: task.status,
          })),
        };
      case "get_task": {
        const task = await ownTask(ctx, caller, args["task_id"]);
        return {
          task_id: task.id,
          title: task.title,
          goal: task.goal,
          status: task.status,
          lead_agent: task.lead_agent_slug,
          plan: await service.planView(ctx, task.id),
          result: task.result,
        };
      }
      default:
        throw new ToolError(`unknown tool "${name}"`);
    }
  } catch (err) {
    // What the task refuses is the agent's to read and correct, not a crash.
    if (err instanceof HttpError || err instanceof PlanError || err instanceof TaskStateError)
      throw new ToolError(err.message);
    throw err;
  }
}
