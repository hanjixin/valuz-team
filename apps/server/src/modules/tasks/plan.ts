/**
 * TaskPlan — the subtask DAG a lead lays down before dispatching. Pure: no IO.
 * Port of valuz-agent `modules/tasks/plan.py`; this module is the only place
 * that knows the shape of the `tasks.plan` JSON document.
 */

export const SUBTASK_STATUSES = ["planned", "in_progress", "in_review", "rework", "done", "failed", "paused"] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

/**
 * Legal node transitions. `done` is terminal (un-approving is a plan revision,
 * not a status flip). Nothing may ever write `failed`: a failed-stamped node
 * is not "unresolved", so it would let planned work be skipped by relabeling
 * it — every failure path parks the node in `rework` instead.
 */
const NODE_TRANSITIONS: Record<SubtaskStatus, readonly SubtaskStatus[]> = {
  planned: ["in_progress"],
  in_progress: ["in_review", "rework", "paused", "done"],
  in_review: ["done", "rework", "in_progress"],
  rework: ["in_progress", "in_review", "done"],
  paused: ["in_progress", "in_review", "rework"],
  done: [],
  failed: ["planned"],
};

/** The ONE definition of "is there work left?". `paused` is load-bearing. */
const UNRESOLVED: readonly SubtaskStatus[] = ["planned", "in_progress", "in_review", "rework", "paused"];

export type PanelStatus = "pending" | "active" | "completed" | "failed" | "paused";
const PANEL: Record<SubtaskStatus, PanelStatus> = {
  planned: "pending",
  in_progress: "active",
  in_review: "active",
  rework: "active",
  done: "completed",
  failed: "failed",
  paused: "paused",
};

export class PlanError extends Error {}

export interface Subtask {
  key: string;
  title: string;
  goal: string;
  agent: string | null;
  depends_on: string[];
  parallel_group: string | null;
  /** The acceptance bar the lead sets at plan time and reviews against. */
  review_criteria: string;
  status: SubtaskStatus;
  attempts: number;
  latest_run_session_id: string | null;
  review_feedback: string | null;
}

const optStr = (v: unknown): string | null => (v ? String(v) : null);

function subtaskFrom(d: Record<string, unknown>): Subtask {
  const key = String(d["key"] ?? "").trim();
  if (!key) throw new PlanError("subtask is missing a non-empty 'key'");
  const status = (d["status"] ?? "planned") as SubtaskStatus;
  if (!SUBTASK_STATUSES.includes(status)) throw new PlanError(`subtask "${key}": invalid status "${String(status)}"`);
  const deps = d["depends_on"] ?? [];
  if (!Array.isArray(deps) || !deps.every((x) => typeof x === "string")) {
    throw new PlanError(`subtask "${key}": 'depends_on' must be a list of keys`);
  }
  return {
    key,
    title: String(d["title"] || key),
    goal: String(d["goal"] ?? ""),
    agent: optStr(d["agent"]),
    depends_on: [...(deps as string[])],
    parallel_group: optStr(d["parallel_group"]),
    review_criteria: String(d["review_criteria"] ?? ""),
    status,
    attempts: Number(d["attempts"] ?? 0) || 0,
    latest_run_session_id: optStr(d["latest_run_session_id"]),
    review_feedback: optStr(d["review_feedback"]),
  };
}

/** Fields a lead may patch through modify_plan. Status and bookkeeping are not among them. */
const PATCHABLE = ["title", "goal", "agent", "depends_on", "parallel_group", "review_criteria"] as const;

export class TaskPlan {
  private nodes: Subtask[];

  constructor(nodes: Subtask[] = []) {
    this.nodes = nodes;
    this.validate();
  }

  static fromJson(data: unknown): TaskPlan {
    const raw = (data as { subtasks?: unknown } | null)?.subtasks ?? [];
    if (!Array.isArray(raw)) throw new PlanError("plan 'subtasks' must be a list");
    return new TaskPlan(raw.map((x) => subtaskFrom(x as Record<string, unknown>)));
  }

  toJson(): { subtasks: Subtask[] } {
    return { subtasks: this.nodes.map((n) => ({ ...n, depends_on: [...n.depends_on] })) };
  }

  /** The snapshot the UI plan panel and the lead's get_plan both read. */
  toPanel() {
    return this.nodes.map((n) => ({
      key: n.key,
      label: n.title,
      agent: n.agent ?? "",
      status: PANEL[n.status],
      internal_status: n.status,
      depends_on: [...n.depends_on],
      parallel_group: n.parallel_group,
      goal: n.goal,
      attempts: n.attempts,
      review_criteria: n.review_criteria,
      review_feedback: n.review_feedback,
      latest_run_session_id: n.latest_run_session_id,
    }));
  }

  get isEmpty(): boolean {
    return this.nodes.length === 0;
  }

  get all(): readonly Subtask[] {
    return this.nodes;
  }

  get(key: string): Subtask | undefined {
    return this.nodes.find((n) => n.key === key);
  }

  /** Dispatchable now: planned or paused, and every dependency is done. */
  readyKeys(): string[] {
    const done = new Set(this.nodes.filter((n) => n.status === "done").map((n) => n.key));
    return this.nodes
      .filter((n) => (n.status === "planned" || n.status === "paused") && n.depends_on.every((d) => done.has(d)))
      .map((n) => n.key);
  }

  depsDone(key: string): boolean {
    const node = this.get(key);
    return !!node && node.depends_on.every((d) => this.get(d)?.status === "done");
  }

  /** Keys with work outstanding. An empty plan has none (an inline-satisfied goal may finish). */
  unresolvedKeys(): string[] {
    return this.nodes.filter((n) => UNRESOLVED.includes(n.status)).map((n) => n.key);
  }

  keysIn(...statuses: SubtaskStatus[]): string[] {
    return this.nodes.filter((n) => statuses.includes(n.status)).map((n) => n.key);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of this.nodes) out[n.status] = (out[n.status] ?? 0) + 1;
    return out;
  }

  add(nodes: Record<string, unknown>[]): void {
    const next = [...this.nodes, ...nodes.map((d) => subtaskFrom({ ...d, status: "planned", attempts: 0 }))];
    const prior = this.nodes;
    this.nodes = next;
    try {
      this.validate();
    } catch (err) {
      this.nodes = prior;
      throw err;
    }
  }

  /** Apply a lead-supplied patch to one node's definition (never its status). */
  patch(key: string, fields: Record<string, unknown>): void {
    const node = this.get(key);
    if (!node) throw new PlanError(`no subtask with key "${key}"`);
    const before = { ...node, depends_on: [...node.depends_on] };
    for (const [name, value] of Object.entries(fields)) {
      if (name === "key") continue;
      if (!(PATCHABLE as readonly string[]).includes(name))
        throw new PlanError(`subtask field "${name}" cannot be modified`);
      if (name === "depends_on") {
        if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
          throw new PlanError(`subtask "${key}": 'depends_on' must be a list of keys`);
        }
        node.depends_on = [...(value as string[])];
      } else if (name === "agent" || name === "parallel_group") {
        node[name] = optStr(value);
      } else {
        node[name as "title" | "goal" | "review_criteria"] = String(value ?? "");
      }
    }
    try {
      this.validate();
    } catch (err) {
      Object.assign(node, before);
      throw err;
    }
  }

  /** The one choke point for status writes; enforces the transition table. */
  setStatus(
    key: string,
    status: SubtaskStatus,
    extra: Partial<Pick<Subtask, "attempts" | "latest_run_session_id" | "review_feedback">> = {},
  ): Subtask {
    const node = this.get(key);
    if (!node) throw new PlanError(`no subtask with key "${key}"`);
    if (status !== node.status && !NODE_TRANSITIONS[node.status].includes(status)) {
      throw new PlanError(`illegal subtask transition "${node.status}" → "${status}" for "${key}"`);
    }
    node.status = status;
    Object.assign(node, extra);
    return node;
  }

  /** Throws on duplicate keys, dangling or self dependencies, or a cycle. */
  validate(): void {
    const keys = new Set<string>();
    for (const n of this.nodes) {
      if (keys.has(n.key)) throw new PlanError(`duplicate subtask key "${n.key}"`);
      keys.add(n.key);
    }
    for (const n of this.nodes) {
      for (const dep of n.depends_on) {
        if (dep === n.key) throw new PlanError(`subtask "${n.key}" depends on itself`);
        if (!keys.has(dep)) throw new PlanError(`subtask "${n.key}" depends on unknown key "${dep}"`);
      }
    }
    const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
    const visit = (key: string): void => {
      if (state.get(key) === 2) return;
      if (state.get(key) === 1) throw new PlanError(`dependency cycle detected at subtask "${key}"`);
      state.set(key, 1);
      for (const dep of this.get(key)?.depends_on ?? []) visit(dep);
      state.set(key, 2);
    };
    for (const n of this.nodes) visit(n.key);
  }
}

// -- Task status state machine (port of task_state.py) --

export const TASK_STATUSES = ["draft", "active", "paused", "stopped", "completed", "blocked", "abandoned"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * `stopped` and `completed` are soft-terminal: the lead is torn down but the
 * plan and history survive, so the task can be resumed or reopened. Only
 * `abandoned` (a discarded draft) is hard-terminal.
 */
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["active", "abandoned"],
  active: ["paused", "stopped", "completed", "blocked"],
  paused: ["active", "stopped"],
  blocked: ["active", "stopped"],
  stopped: ["active"],
  completed: ["active"],
  abandoned: [],
};

export class TaskStateError extends Error {}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].includes(to)) {
    const allowed = TASK_TRANSITIONS[from].join(", ") || "none — terminal";
    throw new TaskStateError(`a ${from} task cannot become ${to} (allowed: ${allowed})`);
  }
}
