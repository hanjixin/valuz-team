/** The task toolkit: what a lead can do, as the model is told it. */
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const S = { type: "string" };
const strings = { type: "array", items: S };

const SUBTASK = obj(
  {
    key: { ...S, description: "Stable, task-unique node key." },
    title: { ...S, description: "Short label for the subtask." },
    goal: { ...S, description: "The scoped, self-contained brief for the member." },
    agent: { ...S, description: "Slug of the project member that runs it (see list_members)." },
    review_criteria: {
      ...S,
      description: "Acceptance bar — the concrete, checkable items you will review it against. Shown to the member.",
    },
    depends_on: { ...strings, description: "Keys that must be done before this one is dispatchable." },
    parallel_group: { ...S, description: "Optional parallel-batch label." },
  },
  ["key", "title"],
);

const NODE_REF = {
  subtask_key: { ...S, description: "Plan node key." },
  session_id: { ...S, description: "Member run session id (alternative to subtask_key)." },
};

export const LEAD_TOOLS = [
  {
    name: "list_members",
    description:
      "List the project members available for dispatch: slug, name, runtime, and role_summary. Use role_summary to route each subtask to the best-fit member.",
    inputSchema: obj({}),
  },
  {
    name: "plan_task",
    description:
      "Lay down the whole task as a structured subtask plan (DAG) BEFORE dispatching anything. You MUST plan before you can dispatch. Returns the plan and which keys are ready now.",
    inputSchema: obj({ subtasks: { type: "array", items: SUBTASK } }, ["subtasks"]),
  },
  {
    name: "get_plan",
    description:
      "Read the current plan: every subtask's status, which keys are ready to dispatch now, what is unresolved, and overall counts.",
    inputSchema: obj({}),
  },
  {
    name: "modify_plan",
    description:
      "Revise the plan after it exists: add new subtasks, or update existing ones by key (title, goal, agent, depends_on, review_criteria). There is no removal — to retire a subtask, re-scope its goal. Validates the DAG.",
    inputSchema: obj({
      add: { type: "array", items: SUBTASK },
      update: { type: "array", items: { ...SUBTASK, required: ["key"] } },
    }),
  },
  {
    name: "dispatch",
    description:
      "Dispatch a PLANNED subtask to its member agent. NON-BLOCKING: returns immediately with the member's session_id; the member runs concurrently. Dispatch every independent ready subtask, THEN call await_members. Dispatchable when its dependencies are done and its status is planned, rework or paused.",
    inputSchema: obj(
      {
        subtask_key: { ...S, description: "Key of the subtask to dispatch." },
        agent: { ...S, description: "Optional override of the subtask's planned agent slug." },
        goal: { ...S, description: "Optional override of the subtask's planned brief." },
        refs: { ...strings, description: "Optional file paths or references relevant to the subtask." },
      },
      ["subtask_key"],
    ),
  },
  {
    name: "await_members",
    description:
      "Wait for dispatched members to finish and collect their results (subtask_key, session_id, agent, status, summary). Call ONLY after dispatch. mode='any' (default) returns as soon as one finishes — loop it; mode='all' waits for the whole batch. On timeout it returns what finished plus 'pending': those members are ALIVE and still working, so call await_members again rather than treating them as dead.",
    inputSchema: obj({
      keys: { ...strings, description: "Subtask keys to wait for. Omit to wait for all running subtasks." },
      mode: { ...S, enum: ["any", "all"] },
      timeout_s: { type: "number", maximum: 600, description: "Max seconds to wait (default 120, capped at 600)." },
    }),
  },
  {
    name: "review_subtask",
    description:
      "Review a reported subtask: approve (mark done, unlocking dependents) or rework (send it back to the same member with feedback). Re-approving an approved subtask is a no-op.",
    inputSchema: obj(
      {
        ...NODE_REF,
        decision: { ...S, enum: ["approve", "rework"] },
        feedback: { ...S, description: "Required for rework: what to change. Optional for approve: why it passed." },
      },
      ["decision"],
    ),
  },
  {
    name: "stop_subtask",
    description:
      "HARD-stop a running subtask whose member is misdirected, stuck, or no longer needed. Interrupts it and parks the node in rework so you can re-dispatch it (optionally after modify_plan). Use review_subtask rework instead when the member's work is still useful.",
    inputSchema: obj({ ...NODE_REF, reason: { ...S, description: "Short reason, recorded on the timeline." } }),
  },
  {
    name: "send",
    description: "Send a message to a member without stopping it. It is delivered at the member's next turn boundary.",
    inputSchema: obj({ session_id: S, text: S }, ["session_id", "text"]),
  },
  {
    name: "finish_task",
    description:
      "Close the task with a summary and optional artifact list. Call exactly once. status='completed' (default) when the goal is achieved and every subtask is approved; status='stopped' when the user asked to stop or the goal is unreachable.",
    inputSchema: obj(
      {
        summary: { ...S, description: "Final summary of the task result." },
        artifacts: { ...strings, description: "Deliverable file paths, relative to the workspace." },
        status: { ...S, enum: ["completed", "stopped"] },
        force: {
          type: "boolean",
          description: "Only with status='stopped': terminate even though members are still running.",
        },
      },
      ["summary"],
    ),
  },
  {
    name: "update_deliverable",
    description:
      "Refresh the deliverable shown on the task card. 'artifacts' REPLACES the previous list — pass every current deliverable file.",
    inputSchema: obj({ summary: S, artifacts: strings }, ["summary"]),
  },
];
