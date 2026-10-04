/**
 * Automations: work an agent does on a schedule, or when asked. One belongs to
 * the member who made it and runs as them; it lives in a project, so whoever
 * can see the project sees it, and whoever can edit the project can change it.
 */
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest, conflict, forbidden, notFound } from "../../infra/errors.ts";
import * as members from "../agents/members.ts";
import * as audit from "../audit/service.ts";
import * as projects from "../projects/service.ts";
import { interrupt } from "../sessions/dispatch.ts";
import * as sessions from "../sessions/service.ts";
import * as settings from "../settings/service.ts";
import * as sharing from "../sharing/service.ts";
import * as repo from "./repo.ts";
import * as runner from "./runner.ts";
import { describe, normalize } from "./schedule.ts";

type Item = Schema<"AutomationItem">;
type Detail = Schema<"AutomationDetail">;
type Run = Schema<"AutomationRunDetail">;
type Project = Awaited<ReturnType<typeof projects.require>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_TARGET = "chat-default";

// ------------------------------------------------------------------ presenting

const mayEdit = (auth: Auth, row: { owner_id: string }, project: Project): boolean =>
  row.owner_id === auth.userId || sharing.permissionAtLeast(project.permission ?? "view", "edit");

async function present(ctx: Ctx, auth: Auth, row: repo.AutomationRow, project: Project): Promise<Detail> {
  const agent = row.agent_slug
    ? await members.resolveForSession(ctx, auth, row.project_id, row.agent_slug).catch(() => null)
    : null;
  return {
    automation_id: row.id,
    project_id: row.project_id,
    project_name: project.name,
    project_kind: project.kind === "chat" ? "chat" : "project",
    name: row.name,
    agent_kind: (row.agent_kind as Item["agent_kind"]) ?? null,
    agent_slug: row.agent_slug,
    agent_name: agent?.name ?? row.agent_slug,
    action_kind: row.action_kind,
    execution: { kind: "agent", mode: row.action_kind },
    input: { kind: "text" },
    result: { kind: "conversation" },
    worktree: false,
    playbook_definition_id: null,
    playbook_version: null,
    event_source: null,
    event_refs: null,
    trigger: row.trigger,
    trigger_human_readable: describe(row.trigger),
    status: row.status,
    next_run_at: row.status === "enabled" ? await runner.nextRun(ctx, row.id) : null,
    last_run_at: row.last_run_at?.getTime() ?? null,
    last_run_status: row.last_run_status ?? null,
    owner_id: row.owner_id,
    editable: mayEdit(auth, row, project),
    prompt_template: row.prompt_template,
    total_runs: Number(row.total_runs ?? 0),
    recent_failures: Number(row.recent_failures ?? 0),
    created_at: row.created_at.getTime(),
    updated_at: row.updated_at.getTime(),
  };
}

const TASK_STATES: Record<string, NonNullable<Run["task_status"]>> = {
  completed: "completed",
  failed: "failed",
  abandoned: "failed",
  stopped: "failed",
  paused: "paused",
};

const presentRun = (row: repo.RunRow): Run => ({
  run_id: row.id,
  automation_id: row.automation_id,
  project_id: row.project_id,
  trigger_type: row.trigger_type as Run["trigger_type"],
  status: row.status as Run["status"],
  triggered_at: row.triggered_at.getTime(),
  started_at: row.started_at?.getTime() ?? null,
  completed_at: row.completed_at?.getTime() ?? null,
  duration_ms: row.started_at && row.completed_at ? row.completed_at.getTime() - row.started_at.getTime() : null,
  result_summary: row.result_summary,
  error_code: row.error_code,
  error_message_key: null,
  error_message: row.error_message,
  session_id: row.session_id,
  created_files: [],
  playbook_run_id: null,
  executor_ref: null,
  invoked_by_ref: null,
  has_artifact: false,
  has_input: row.input !== null,
  task_id: row.task_id,
  task_title: row.task_title,
  task_status: row.task_id ? (TASK_STATES[row.task_state ?? ""] ?? "active") : null,
  input: row.input ?? null,
  artifact: null,
  files: [],
  log_tail: null,
  cancel_requested_at: row.cancel_requested_at?.getTime() ?? null,
});

// ------------------------------------------------------------------ reading

/** The automation and its project, as the caller may see them. `change` also requires that they may edit it. */
async function access(ctx: Ctx, auth: Auth, id: string, change = false) {
  const row = UUID.test(id) ? await repo.find(ctx.db, auth.orgId, id) : undefined;
  if (!row) throw notFound("automation");
  // Invisible project, invisible automation.
  const project = await projects.require(ctx, auth, row.project_id).catch(() => {
    throw notFound("automation");
  });
  if (change && !mayEdit(auth, row, project))
    throw forbidden("only the automation's owner, or someone who can edit its project, can change it");
  return { row, project };
}

export async function get(ctx: Ctx, auth: Auth, id: string): Promise<Detail> {
  const { row, project } = await access(ctx, auth, id);
  return present(ctx, auth, row, project);
}

export async function list(ctx: Ctx, auth: Auth, projectId?: string): Promise<Schema<"AutomationGroup">[]> {
  const visible = (await projects.list(ctx, auth)).filter((project) => !projectId || project.id === projectId);
  const rows = await repo.listInProjects(
    ctx.db,
    auth.orgId,
    visible.map((project) => project.id),
  );
  const groups: Schema<"AutomationGroup">[] = [];
  for (const project of visible) {
    const mine = rows.filter((row) => row.project_id === project.id);
    if (mine.length === 0) continue;
    const full = await projects.require(ctx, auth, project.id);
    groups.push({
      project_id: project.id,
      project_name: project.name,
      project_kind: project.kind === "chat" ? "chat" : "project",
      automations: await Promise.all(mine.map((row) => present(ctx, auth, row, full))),
    });
  }
  return groups;
}

/** Where a new automation may live: a conversation of its own, or one of the caller's projects. */
export async function targets(ctx: Ctx, auth: Auth): Promise<Schema<"AutomationProjectTarget">[]> {
  const mine = (await projects.list(ctx, auth)).filter(
    (project) => project.kind !== "chat" && sharing.permissionAtLeast(project.permission ?? "view", "edit"),
  );
  return [
    { id: CHAT_TARGET, name: "Chat", kind: "chat", project_id: null },
    ...mine.map((project) => ({
      id: project.id,
      name: project.name,
      kind: "project" as const,
      project_id: project.id,
    })),
  ];
}

// ------------------------------------------------------------------ writing

/** What this server cannot run is refused when it is asked for, not when the clock strikes. */
function refuseUnsupported(input: {
  execution?: { kind: string } | null;
  playbook_definition_id?: string | null;
  worktree?: boolean | null;
  event_source?: string | null;
}): void {
  if (input.execution && input.execution.kind !== "agent")
    throw badRequest("only agent automations are supported; code execution is not", "unsupported_execution");
  if (input.playbook_definition_id)
    throw badRequest("playbooks are not available on this server", "unsupported_playbook");
  if (input.worktree) throw badRequest("worktrees are not available on this server", "unsupported_worktree");
  if (input.event_source) throw badRequest("no event sources are available on this server", "unsupported_trigger");
}

/** What a trigger is checked against: the member's timezone when it names none, and the server's shortest interval. */
const limits = async (ctx: Ctx, auth: Auth) => ({
  defaultTimezone: (await settings.getPreferences(ctx.db, { orgId: auth.orgId, userId: auth.userId })).default_timezone,
  minIntervalSeconds: ctx.config.AUTOMATION_MIN_INTERVAL_SECONDS,
});

/** The agent must exist where the automation will look for it; a task needs one to lead it. */
async function checkAgent(ctx: Ctx, auth: Auth, projectId: string, action: "chat" | "task", slug: string | null) {
  if (!slug) {
    if (action === "task") throw badRequest("a task automation needs an agent to lead it", "agent_required");
    return;
  }
  await members.resolveForSession(ctx, auth, projectId, slug).catch(() => {
    throw badRequest(`agent "${slug}" is not available to this automation`, "agent_unavailable");
  });
}

export async function create(ctx: Ctx, auth: Auth, input: Schema<"AutomationCreateRequest">): Promise<Detail> {
  refuseUnsupported(input);
  const name = input.name.trim();
  if (!name) throw badRequest("an automation needs a name");
  const action = input.action_kind ?? "chat";
  const trigger = normalize(input.trigger, await limits(ctx, auth));

  let projectId: string;
  if (input.project_kind === "project") {
    if (!input.project_id) throw badRequest("choose the project this automation runs in");
    projectId = (await projects.require(ctx, auth, input.project_id, "edit")).id;
  } else {
    if (action === "task") throw badRequest("a task needs a project with a team; choose a project", "project_required");
    // A conversation-only automation gets a home of its own, named after it.
    const chat = await projects.createChat(ctx, auth, await sessions.deviceFor(ctx, auth, null, null));
    await projects.rename(ctx, auth, chat.id, name);
    projectId = chat.id;
  }
  await checkAgent(ctx, auth, projectId, action, input.agent_slug ?? null);

  const id = crypto.randomUUID();
  await repo.insert(ctx.db, {
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    project_id: projectId,
    name,
    agent_kind: input.agent_slug ? (input.agent_kind ?? "library_agent") : null,
    agent_slug: input.agent_slug ?? null,
    action_kind: action,
    prompt_template: input.prompt_template,
    trigger,
  });
  await runner.sync(ctx, { id, status: "enabled", trigger });
  await audit.record(ctx.db, auth, "automation.create", { type: "automation", id }, { name, project_id: projectId });
  return get(ctx, auth, id);
}

export async function update(
  ctx: Ctx,
  auth: Auth,
  id: string,
  input: Schema<"AutomationUpdateRequest">,
): Promise<Detail> {
  const { row } = await access(ctx, auth, id, true);
  refuseUnsupported(input);
  const action = input.action_kind ?? row.action_kind;
  const slug = input.agent_slug === undefined ? row.agent_slug : input.agent_slug;
  if (input.action_kind || input.agent_slug !== undefined) await checkAgent(ctx, auth, row.project_id, action, slug);
  if (input.name !== undefined && input.name !== null && !input.name.trim())
    throw badRequest("an automation needs a name");
  const trigger = input.trigger ? normalize(input.trigger, await limits(ctx, auth)) : undefined;
  await repo.update(ctx.db, id, {
    ...(input.name ? { name: input.name.trim() } : {}),
    ...(input.prompt_template ? { prompt_template: input.prompt_template } : {}),
    ...(input.action_kind ? { action_kind: input.action_kind } : {}),
    ...(input.agent_slug !== undefined
      ? { agent_slug: slug, agent_kind: slug ? (row.agent_kind ?? "library_agent") : null }
      : {}),
    ...(trigger ? { trigger } : {}),
  });
  if (trigger) await runner.sync(ctx, { id, status: row.status, trigger });
  return get(ctx, auth, id);
}

export async function setStatus(ctx: Ctx, auth: Auth, id: string, status: "enabled" | "paused"): Promise<Detail> {
  const { row } = await access(ctx, auth, id, true);
  await repo.update(ctx.db, id, { status });
  await runner.sync(ctx, { id, status, trigger: row.trigger });
  return get(ctx, auth, id);
}

export async function remove(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  const { row } = await access(ctx, auth, id, true);
  await runner.unschedule(ctx, id);
  await repo.remove(ctx.db, id);
  await audit.record(ctx.db, auth, "automation.delete", { type: "automation", id }, { name: row.name });
}

// ------------------------------------------------------------------ runs

async function run(ctx: Ctx, automationId: string, runId: string): Promise<Run> {
  const row = UUID.test(runId) ? await repo.findRun(ctx.db, automationId, runId) : undefined;
  if (!row) throw notFound("run");
  return presentRun(row);
}

export async function runNow(
  ctx: Ctx,
  auth: Auth,
  id: string,
  options: { input?: unknown; waitSeconds?: number },
): Promise<Schema<"AutomationRunAccepted">> {
  await access(ctx, auth, id, true);
  const runId = await runner.runNow(ctx, id, options.input ?? null);
  // A caller that would rather wait a little than poll may say so.
  const deadline = Date.now() + (options.waitSeconds ?? 0) * 1000;
  let current = await run(ctx, id, runId);
  while (current.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = await run(ctx, id, runId);
  }
  return { run_id: runId, automation_id: id, status: "running", run: current };
}

export async function listRuns(ctx: Ctx, auth: Auth, id: string, limit: number, cursor?: string): Promise<Run[]> {
  await access(ctx, auth, id);
  // The cursor is the last run already shown.
  const after = cursor && UUID.test(cursor) ? await repo.findRun(ctx.db, id, cursor) : undefined;
  return (await repo.listRuns(ctx.db, id, limit, after?.triggered_at)).map(presentRun);
}

export async function getRun(ctx: Ctx, auth: Auth, id: string, runId: string): Promise<Run> {
  await access(ctx, auth, id);
  return run(ctx, id, runId);
}

export async function cancelRun(ctx: Ctx, auth: Auth, id: string, runId: string): Promise<Run> {
  await access(ctx, auth, id, true);
  const current = await run(ctx, id, runId);
  if (current.status !== "running") throw conflict("this run has already ended", "run_ended");
  await repo.requestCancel(ctx.db, runId);
  await repo.settleRun(ctx.db, { id: runId }, { status: "cancelled" });
  // Stop what it started; the turn's own ending finds the run already closed.
  if (current.session_id) await interrupt(ctx, auth, current.session_id).catch(() => undefined);
  return run(ctx, id, runId);
}
