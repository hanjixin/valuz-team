/** Model-facing text for tasks: role protocols, briefs, and inbox rendering. */
import type { McpServerConfig } from "@agent-base/protocol";
import { SignJWT, jwtVerify } from "jose";
import type { Ctx } from "../context.ts";
import type { Row } from "../db.ts";
import type { Subtask } from "./plan.ts";

export const TASK_MCP_PATH = "/v1/mcp/tasks";
export const TASK_MCP_NAME = "task";

export interface TaskRole {
  task_id: string;
  role: "lead" | "member";
  subtask_key?: string;
}

export const taskRoleOf = (row: Row): TaskRole | null => {
  const role = (row["metadata"] as { valuz?: { task?: TaskRole } } | null)?.valuz?.task;
  return role?.task_id ? role : null;
};

const key = (ctx: Ctx) => new TextEncoder().encode(ctx.config.APP_SECRET);

/** A token that lets exactly one session call the task toolkit as itself. */
export const signToolToken = (ctx: Ctx, sessionId: string): Promise<string> =>
  new SignJWT({ typ: "task-tool" }).setProtectedHeader({ alg: "HS256" }).setSubject(sessionId).setIssuedAt().setExpirationTime("7d").sign(key(ctx));

export async function verifyToolToken(ctx: Ctx, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(ctx), { algorithms: ["HS256"] });
    return payload["typ"] === "task-tool" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

const LEAD_PROTOCOL = `## You are the LEAD of a multi-agent task
You own the goal below and drive it to completion with the \`${TASK_MCP_NAME}\` tools. You coordinate; members do the work.

1. PLAN — call list_members, then plan_task once with the whole job as subtasks (key, title, goal, agent, review_criteria, depends_on). You cannot dispatch before a plan exists. Revise later with modify_plan.
2. DISPATCH — call dispatch(subtask_key) for every ready subtask. It returns immediately; members run in parallel.
3. AWAIT — call await_members to collect results. It returns as members finish; call it again to keep waiting.
4. REVIEW — for each result call review_subtask: approve (unlocks dependents) or rework with concrete feedback. Review against the criteria you set.
5. Repeat 2–4 until get_plan shows nothing unresolved, then call finish_task(summary, artifacts) exactly once.

Rules: give each member a self-contained goal — it sees only its own brief. Do not do a member's subtask yourself. If the user asks to stop, call finish_task(status="stopped"). Ending your turn without finish_task leaves the task unfinished.`;

const MEMBER_PROTOCOL = `## You are a MEMBER working on one subtask of a larger task
Complete exactly the subtask in your brief, in the shared workspace. Other members handle the rest — do not start their work.
Your FINAL message is your report to the lead: state what you did, the result, and the paths of any files you produced. If you could not finish, say exactly what is missing.`;

/** Role protocol + toolkit connection for a session that works for a task. */
export async function taskDispatchExtras(ctx: Ctx, row: Row): Promise<{ instructions: string; mcpServer: McpServerConfig | null } | null> {
  const role = taskRoleOf(row);
  if (!role) return null;
  const task = await ctx.db.one<{ title: string; goal: string }>("SELECT title, goal FROM tasks WHERE id = $1", [role.task_id]);
  if (!task) return null;
  const mcpServer: McpServerConfig = {
    name: TASK_MCP_NAME,
    transport: "http",
    url: `${ctx.config.PUBLIC_URL}${TASK_MCP_PATH}`,
    headers: { authorization: `Bearer ${await signToolToken(ctx, row["id"] as string)}` },
    // await_members parks for minutes; never let a client's shorter default abort it.
    tool_timeout_sec: 660,
    server_instructions_trusted: true,
  };
  // Members report with their final message; only the lead holds the toolkit.
  if (role.role === "member") return { instructions: `${MEMBER_PROTOCOL}\n\n(Parent task: ${task.title})`, mcpServer: null };
  return { instructions: `${LEAD_PROTOCOL}\n\n### Task: ${task.title}\n${task.goal}`, mcpServer };
}

export const kickoffText = (title: string, goal: string): string =>
  `Start the task "${title}".\n\nGoal:\n${goal}\n\nBegin by listing the members and laying down the plan.`;

export function memberBrief(node: Subtask, goal: string, refs: string[]): string {
  return [
    `# Subtask: ${node.title} (key: ${node.key})`,
    goal || node.title,
    node.review_criteria ? `## Acceptance criteria\n${node.review_criteria}` : "",
    refs.length ? `## References\n${refs.map((r) => `- ${r}`).join("\n")}` : "",
    node.review_feedback && node.attempts > 0 ? `## Feedback on the previous attempt\n${node.review_feedback}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type MailboxItem = {
  kind: string;
  text: string;
  payload: Record<string, unknown>;
};

/** Render pending mailbox items as the user turn that wakes an idle actor. */
export function renderInbox(items: MailboxItem[]): string {
  const blocks = items.map((m) => {
    switch (m.kind) {
      case "member_done":
        return `<member_done subtask_key="${String(m.payload["subtask_key"])}" session_id="${String(m.payload["session_id"])}" agent="${String(m.payload["agent"])}" status="${String(m.payload["status"])}">\n${m.text}\n</member_done>`;
      case "user_inject":
        return `<user_message>\n${m.text}\n</user_message>`;
      case "lead_message":
        return `<lead_message>\n${m.text}\n</lead_message>`;
      default:
        return `<system_notice kind="${m.kind}">\n${m.text}\n</system_notice>`;
    }
  });
  return blocks.join("\n\n");
}
