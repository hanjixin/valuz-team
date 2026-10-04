/** Model-facing text for tasks: role protocols, briefs, and how an inbox is read out. */
import type { Subtask } from "./plan.ts";

export const TASK_TOOLKIT = { name: "task", path: "/v1/mcp/tasks" } as const;

/** What a session is to a task. Kept on the session, so every turn knows its part. */
export interface TaskRole {
  task_id: string;
  role: "lead" | "member";
  subtask_key?: string;
}

export const roleMetadata = (role: TaskRole): Record<string, unknown> => ({ valuz: { task: role } });

export const roleOf = (metadata: unknown): TaskRole | null => {
  const role = (metadata as { valuz?: { task?: TaskRole } } | null)?.valuz?.task;
  return role?.task_id ? role : null;
};

export const LEAD_PROTOCOL = `## You are the LEAD of a multi-agent task
You own the goal below and drive it to completion with the \`${TASK_TOOLKIT.name}\` tools. You coordinate; members do the work.

1. PLAN — call list_members, then plan_task once with the whole job as subtasks (key, title, goal, agent, review_criteria, depends_on). You cannot dispatch before a plan exists. Revise later with modify_plan.
2. DISPATCH — call dispatch(subtask_key) for every ready subtask. It returns immediately; members run in parallel.
3. AWAIT — call await_members to collect results. It returns as members finish; call it again to keep waiting.
4. REVIEW — for each result call review_subtask: approve (unlocks dependents) or rework with concrete feedback. Review against the criteria you set.
5. Repeat 2–4 until get_plan shows nothing unresolved, then call finish_task(summary, artifacts) exactly once.

Rules: give each member a self-contained goal — it sees only its own brief. Do not do a member's subtask yourself. If the user asks to stop, call finish_task(status="stopped"). Ending your turn without finish_task leaves the task unfinished.`;

export const MEMBER_PROTOCOL = `## You are a MEMBER working on one subtask of a larger task
Complete exactly the subtask in your brief, in the shared workspace. Other members handle the rest — do not start their work.
Your FINAL message is your report to the lead: state what you did, the result, and the paths of any files you produced. If you could not finish, say exactly what is missing.`;

export const kickoffText = (title: string, goal: string): string =>
  `Start the task "${title}".\n\nGoal:\n${goal}\n\nBegin by listing the members and laying down the plan.`;

export function memberBrief(node: Subtask, goal: string, refs: string[]): string {
  return [
    `# Subtask: ${node.title} (key: ${node.key})`,
    goal || node.title,
    node.review_criteria ? `## Acceptance criteria\n${node.review_criteria}` : "",
    refs.length ? `## References\n${refs.map((ref) => `- ${ref}`).join("\n")}` : "",
    node.review_feedback && node.attempts > 0 ? `## Feedback on the previous attempt\n${node.review_feedback}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface MailboxItem {
  kind: string;
  text: string;
  payload: Record<string, unknown>;
}

/** Pending mailbox items, written as the user turn that wakes an idle actor. */
export function renderInbox(items: MailboxItem[]): string {
  return items
    .map((m) => {
      const p = m.payload;
      switch (m.kind) {
        case "member_done":
          return `<member_done subtask_key="${String(p["subtask_key"])}" session_id="${String(p["session_id"])}" agent="${String(p["agent"])}" status="${String(p["status"])}">\n${m.text}\n</member_done>`;
        case "user_inject":
          return `<user_message>\n${m.text}\n</user_message>`;
        case "lead_message":
          return `<lead_message>\n${m.text}\n</lead_message>`;
        default:
          return `<system_notice kind="${m.kind}">\n${m.text}\n</system_notice>`;
      }
    })
    .join("\n\n");
}
