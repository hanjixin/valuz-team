/**
 * Skills that write themselves. After work that took real effort — a turn with
 * many tool calls, or a finished task — the session's own model (on its device,
 * like everything a model does here) is asked whether a procedure worth keeping
 * came out of it, or whether a skill it used needs correcting. What it answers
 * goes through the same doors as the `skill_manage` tool: the member's own
 * skills only, the same checks, a new version each time, and a notice to the
 * member. Best effort by contract: it never blocks or breaks a turn.
 */
import type { FastifyInstance } from "fastify";
import { authFor } from "../../infra/auth.ts";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError } from "../../infra/errors.ts";
import { type JobQueue, startJobs } from "../../infra/jobs.ts";
import { redactSecrets } from "../../infra/safety.ts";
import * as agents from "../agents/service.ts";
import * as notifications from "../notifications/service.ts";
import { askOnDevice } from "../sessions/dispatch.ts";
import * as sessions from "../sessions/service.ts";
import * as tasks from "../tasks/service.ts";
import { type Digest, learnPrompt } from "./prompts.ts";
import * as skills from "./service.ts";

type LearnJob = { sessionId: string } | { taskId: string };

const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_TOOL_LINES = 80;
const MAX_USED_CHARS = 6000;
const reviewedKey = (sessionId: string): string => `skills:reviewed:${sessionId}`;
const queues = new WeakMap<Ctx, JobQueue<LearnJob>>();

export type Op =
  | { action: "create"; name: string; description: string; instructions: string }
  | { action: "patch"; skill: string; old_text: string; new_text: string };

/** The well-formed operations in a reviewer's reply; anything malformed is dropped, not fatal. */
export function parseOps(raw: string): Op[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let ops: unknown;
  try {
    ops = (JSON.parse(raw.slice(start, end + 1)) as { ops?: unknown }).ops;
  } catch {
    return [];
  }
  if (!Array.isArray(ops)) return [];
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const parsed = ops.flatMap((op: Record<string, unknown> | null): Op[] => {
    if (!op || typeof op !== "object") return [];
    if (op["action"] === "create" && text(op["name"]) && text(op["description"]) && text(op["instructions"]))
      return [
        {
          action: "create",
          name: text(op["name"]),
          description: text(op["description"]),
          instructions: text(op["instructions"]),
        },
      ];
    if (op["action"] === "patch" && text(op["skill"]) && text(op["old_text"]) && typeof op["new_text"] === "string")
      return [
        { action: "patch", skill: text(op["skill"]), old_text: String(op["old_text"]), new_text: op["new_text"] },
      ];
    return [];
  });
  // A review may add one skill: more than that is a model emptying its notes, not a lesson.
  const firstNew = parsed.findIndex((op) => op.action === "create");
  return parsed.filter((op, index) => op.action === "patch" || index === firstNew);
}

/** Tell the member what an agent of theirs just wrote, and give its agent the new skill. */
export async function announce(
  ctx: Ctx,
  by: { auth: Auth; sessionId: string; agentId: string | null },
  change: { kind: "created" | "amended"; slug: string; name: string },
): Promise<void> {
  if (change.kind === "created" && by.agentId) await agents.equip(ctx, by.auth, by.agentId, change.slug);
  await notifications.notify(
    ctx,
    { orgId: by.auth.orgId, userId: by.auth.userId },
    {
      kind: change.kind === "created" ? "skill_learned" : "skill_amended",
      title: change.kind === "created" ? `学到了新技能：${change.name}` : `更新了技能：${change.name}`,
      body:
        change.kind === "created"
          ? "智能体把刚才摸索出的做法整理成了技能，之后的会话可以直接用。可以在技能库里查看、修改或删除。"
          : "智能体修正了这个技能的内容。可以在技能的版本历史里查看改动或恢复。",
      route: `/plugins?skill=${change.slug}`,
      sessionId: by.sessionId,
      payload: { skill: change.slug },
    },
  );
}

/** Apply what the reviewer decided. An operation the library refuses is skipped; the rest still apply. */
export async function applyOps(
  ctx: Ctx,
  by: { auth: Auth; sessionId: string; agentId: string | null },
  ops: Op[],
  patchable: Set<string>,
): Promise<number> {
  let applied = 0;
  for (const op of ops) {
    try {
      if (op.action === "create") {
        const created = await skills.learn(ctx, by.auth, op);
        await announce(ctx, by, { kind: "created", slug: created.slug, name: created.name });
      } else {
        // Only a skill the work actually used, and that was shown to the reviewer in full.
        if (!patchable.has(op.skill)) continue;
        const amended = await skills.amend(ctx, by.auth, op.skill, op.old_text, op.new_text);
        await announce(ctx, by, { kind: "amended", slug: amended.slug, name: amended.name });
      }
      applied++;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
  }
  return applied;
}

const clip = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** The skills a set of tool calls reached for: named to a skill tool, or read from a skill's folder. */
function skillsTouched(calls: sessions.ToolCall[]): Set<string> {
  const slugs = new Set<string>();
  for (const call of calls) {
    const input = JSON.stringify(call.input);
    for (const match of input.matchAll(/skills\/([a-z0-9][a-z0-9-]*)\//g)) slugs.add(match[1] as string);
    if (/^skill$/i.test(call.name))
      for (const value of Object.values(call.input)) if (typeof value === "string") slugs.add(value);
  }
  return slugs;
}

/**
 * What the work looked like from outside: each tool call and what came back.
 * The start of a result is shown either way — plenty of tools report a failure
 * in words rather than as an error.
 */
const toolLines = (calls: sessions.ToolCall[]): string =>
  calls
    .slice(-MAX_TOOL_LINES)
    .map((call, index) => {
      const came = clip(call.result.replace(/\s+/g, " "), 160);
      return `${index + 1}. ${call.name}(${clip(call.input, 240)}) → ${call.failed ? "FAILED" : "ok"}${came ? `: ${came}` : ""}`;
    })
    .join("\n") || "(no tools)";

async function digestOf(
  ctx: Ctx,
  auth: Auth,
  sessionIds: string[],
  since: number,
): Promise<(Digest & { calls: number; until: number }) | null> {
  const turns = (await Promise.all(sessionIds.map((id) => sessions.transcriptSince(ctx, id, since)))).flat();
  const calls = (await Promise.all(sessionIds.map((id) => sessions.toolCallsSince(ctx, id, since)))).flat();
  const last = turns.at(-1);
  if (!last) return null;
  const library = (await skills.list(ctx, auth)).map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description.slice(0, 200),
    editable: !skill.readonly,
  }));
  const editable = new Set(library.filter((skill) => skill.editable).map((skill) => skill.slug));
  const used = await Promise.all(
    [...skillsTouched(calls)]
      .filter((slug) => editable.has(slug))
      .map(async (slug) => ({
        slug,
        instructions: (await skills.instructionsFor(ctx, auth, slug)).instructions.slice(0, MAX_USED_CHARS),
      })),
  );
  return {
    transcript: redactSecrets(
      turns.map((turn) => `USER: ${turn.user}\n\nAGENT: ${turn.assistant}`).join("\n\n---\n\n"),
    ).slice(-MAX_TRANSCRIPT_CHARS),
    tools: redactSecrets(toolLines(calls)),
    library,
    used,
    calls: calls.length,
    until: Math.max(...turns.map((turn) => turn.endedAt)),
  };
}

async function reviewSession(ctx: Ctx, sessionId: string): Promise<void> {
  const session = await sessions.byId(ctx, sessionId);
  // Conversations with a person; a task's sessions are reviewed together when the task finishes.
  if (!session || session.origin !== "user") return;
  const auth = await authFor(ctx, session.org_id, session.owner_id);
  if (!auth || !(await skills.learningSettings(ctx, auth)).auto_learn) return;
  const since = Number((await ctx.redis.get(reviewedKey(sessionId))) ?? 0);
  const digest = await digestOf(ctx, auth, [sessionId], since);
  if (!digest || digest.calls < ctx.config.SKILL_LEARN_MIN_TOOL_CALLS) return;
  const reply = await askOnDevice(ctx, sessionId, learnPrompt({ ...digest, what: "conversation" }));
  if (reply === null) return;
  await applyOps(
    ctx,
    { auth, sessionId, agentId: session.agent_id },
    parseOps(reply),
    new Set(digest.used.map((skill) => skill.slug)),
  );
  await ctx.redis.set(reviewedKey(sessionId), String(digest.until), "EX", 30 * 86_400);
}

/** A task finished: the lead and its members worked it out together, so they are read together. */
async function reviewTask(ctx: Ctx, taskId: string): Promise<void> {
  const task = await tasks.find(ctx, taskId);
  const lead = task?.lead_session_id ? await sessions.byId(ctx, task.lead_session_id) : undefined;
  if (!task || !lead) return;
  const auth = await authFor(ctx, lead.org_id, lead.owner_id);
  if (!auth || !(await skills.learningSettings(ctx, auth)).auto_learn) return;
  const members = (await tasks.planView(ctx, task.id)).subtasks.flatMap((node) =>
    node.latest_run_session_id ? [node.latest_run_session_id] : [],
  );
  const digest = await digestOf(ctx, auth, [lead.id, ...members], 0);
  if (!digest || digest.calls === 0) return;
  const reply = await askOnDevice(
    ctx,
    lead.id,
    learnPrompt({ ...digest, transcript: `GOAL: ${task.goal}\n\n${digest.transcript}`, what: "task" }),
  );
  if (reply === null) return;
  // A team's lesson goes to the library; no single member's agent is given it unasked.
  await applyOps(
    ctx,
    { auth, sessionId: lead.id, agentId: null },
    parseOps(reply),
    new Set(digest.used.map((skill) => skill.slug)),
  );
}

export function start(app: FastifyInstance): void {
  const ctx = app.ctx;
  queues.set(
    ctx,
    startJobs<LearnJob>(
      app,
      "skill-learning",
      (job) => ("taskId" in job ? reviewTask(ctx, job.taskId) : reviewSession(ctx, job.sessionId)),
      { concurrency: 1 },
    ),
  );
}

/** A turn finished: if it took real work, look at it for something worth keeping. */
export async function turnEnded(ctx: Ctx, turn: { id: string; session_id: string; status: string }): Promise<void> {
  if (turn.status !== "completed" || ctx.config.SKILL_LEARN_MIN_TOOL_CALLS <= 0) return;
  await queues.get(ctx)?.add([{ sessionId: turn.session_id }]);
}

export async function taskFinished(ctx: Ctx, taskId: string): Promise<void> {
  if (ctx.config.SKILL_LEARN_MIN_TOOL_CALLS <= 0) return;
  await queues.get(ctx)?.add([{ taskId }]);
}
