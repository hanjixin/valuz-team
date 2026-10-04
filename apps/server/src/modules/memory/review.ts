/**
 * The background review: once a conversation has gone quiet, its own model — on
 * its own device, like every turn — reads
 * what was said since the last review and writes what is worth remembering —
 * through the same store, under the same limits and checks, as the `memory`
 * tool. Best effort by contract: it never blocks or breaks a turn.
 */
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../infra/context.ts";
import { type JobQueue, startJobs } from "../../infra/jobs.ts";
import { askOnDevice } from "../sessions/dispatch.ts";
import * as sessions from "../sessions/service.ts";
import * as tasks from "../tasks/service.ts";
import { reviewPrompt, taskReviewPrompt } from "./prompts.ts";
import * as memory from "./service.ts";

type ReviewJob =
  | {
      sessionId: string;
      /** The turn that armed this review; a later turn re-arms and this one stands down. */
      armedBy: string;
    }
  | { taskId: string };

export interface Op {
  action: "add" | "replace" | "remove";
  target: memory.Target;
  content?: string;
  old_text?: string;
}

const MIN_TRANSCRIPT_CHARS = 200;
const MAX_TRANSCRIPT_CHARS = 24_000;
const armedKey = (sessionId: string): string => `memory:armed:${sessionId}`;
const queues = new WeakMap<Ctx, JobQueue<ReviewJob>>();

/** The JSON object in a model's reply, whatever it wrapped it in. */
function jsonIn(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The well-formed operations in a reviewer's reply; anything malformed is dropped, not fatal. */
export function parseOps(raw: string): Op[] {
  const ops = (jsonIn(raw) as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) return [];
  return ops.flatMap((op: Partial<Op> | null): Op[] => {
    if (!op || typeof op !== "object") return [];
    const { action, target, content, old_text } = op;
    if (!target || !memory.TARGETS.includes(target)) return [];
    const text = typeof content === "string" && content.trim() ? content : undefined;
    const old = typeof old_text === "string" && old_text ? old_text : undefined;
    if (action === "add" && text) return [{ action, target, content: text }];
    if (action === "replace" && text && old) return [{ action, target, content: text, old_text: old }];
    if (action === "remove" && old) return [{ action, target, old_text: old }];
    return [];
  });
}

/** Apply what the reviewer decided. An operation the store refuses is skipped; the rest still apply. */
export async function applyOps(ctx: Ctx, owner: memory.Owner, ops: Op[]): Promise<number> {
  let applied = 0;
  for (const op of ops) {
    try {
      if (op.action === "add") await memory.add(ctx, owner, op.target, op.content ?? "", "auto");
      else if (op.action === "replace")
        await memory.replace(ctx, owner, op.target, op.old_text ?? "", op.content ?? "", "auto");
      else await memory.remove(ctx, owner, op.target, op.old_text ?? "");
      applied++;
    } catch (err) {
      if (!(err instanceof memory.MemoryError)) throw err;
    }
  }
  return applied;
}

/** A task finished: review what the team did for what is worth carrying into the project's later work. */
async function reviewTask(ctx: Ctx, taskId: string): Promise<void> {
  const task = await tasks.find(ctx, taskId);
  const lead = task?.lead_session_id ? await sessions.byId(ctx, task.lead_session_id) : undefined;
  if (!task || !lead) return;
  const owner = await memory.ownerOfSession(ctx, lead);
  const settings = await memory.getSettings(ctx, owner);
  if (!settings.enabled || !settings.auto_extract) return;

  const plan = await tasks.planView(ctx, task.id);
  const digest = [
    `Title: ${task.title}`,
    `Goal: ${task.goal}`,
    "Subtasks:",
    ...plan.subtasks.map((node) => `- [${node.status}] ${node.key}: ${node.label} (${node.agent || "unassigned"})`),
    `Result: ${JSON.stringify(task.result ?? {})}`,
  ].join("\n");
  const turns = await sessions.transcriptSince(ctx, lead.id, 0);
  const transcript = memory
    .redactSecrets(turns.map((turn) => `LEAD WAS TOLD: ${turn.user}\n\nLEAD: ${turn.assistant}`).join("\n\n---\n\n"))
    .slice(-MAX_TRANSCRIPT_CHARS);
  const current = await memory.all(ctx, owner);
  const usage = Object.fromEntries(
    Object.entries(current).map(([target, entries]) => [target, memory.usage(entries, target as memory.Target)]),
  );
  const reply = await askOnDevice(
    ctx,
    lead.id,
    taskReviewPrompt({
      digest: memory.redactSecrets(digest),
      transcript,
      current,
      usage,
      project: owner.project,
      customInstructions: settings.custom_instructions,
    }),
  );
  if (reply !== null) await applyOps(ctx, owner, parseOps(reply));
}

async function review(ctx: Ctx, job: ReviewJob): Promise<void> {
  if ("taskId" in job) return reviewTask(ctx, job.taskId);
  if ((await ctx.redis.get(armedKey(job.sessionId))) !== job.armedBy) return; // the conversation went on
  const session = await sessions.byId(ctx, job.sessionId);
  // Conversations with a person only; a task's sessions talk to each other.
  if (!session || session.origin !== "user") return;
  const owner = await memory.ownerOfSession(ctx, session);
  const settings = await memory.getSettings(ctx, owner);
  if (!settings.enabled || !settings.auto_extract) return;

  const turns = await sessions.transcriptSince(ctx, session.id, await memory.reviewedUntil(ctx, session.id));
  const last = turns.at(-1);
  if (!last) return;
  const transcript = memory
    .redactSecrets(turns.map((turn) => `USER: ${turn.user}\n\nASSISTANT: ${turn.assistant}`).join("\n\n---\n\n"))
    .slice(-MAX_TRANSCRIPT_CHARS);
  // Too little was said to hold anything durable; wait for more before spending a model call.
  if (transcript.length < MIN_TRANSCRIPT_CHARS) return;

  const current = await memory.all(ctx, owner);
  const usage = Object.fromEntries(
    Object.entries(current).map(([target, entries]) => [target, memory.usage(entries, target as memory.Target)]),
  );
  const reply = await askOnDevice(
    ctx,
    session.id,
    reviewPrompt({
      transcript,
      current,
      usage,
      project: owner.project,
      customInstructions: settings.custom_instructions,
    }),
  );
  if (reply === null) return;
  await applyOps(ctx, owner, parseOps(reply));
  await memory.markReviewed(ctx, session.id, last.endedAt);
}

export function start(app: FastifyInstance): void {
  const ctx = app.ctx;
  queues.set(
    ctx,
    startJobs<ReviewJob>(app, "memory-review", (job) => review(ctx, job), { concurrency: 1 }),
  );
}

/** A turn finished: review the session once it has been quiet for a while. A later turn starts the wait again. */
export async function arm(ctx: Ctx, turn: { id: string; session_id: string; status: string }): Promise<void> {
  const delayMs = ctx.config.MEMORY_REVIEW_IDLE_SECONDS * 1000;
  if (turn.status !== "completed" || delayMs <= 0) return;
  await ctx.redis.set(armedKey(turn.session_id), turn.id, "EX", ctx.config.MEMORY_REVIEW_IDLE_SECONDS + 3600);
  await queues.get(ctx)?.add([{ sessionId: turn.session_id, armedBy: turn.id }], { delayMs });
}

/** A task completed: queue its review. Off when the background review is off altogether. */
export async function taskFinished(ctx: Ctx, taskId: string): Promise<void> {
  if (ctx.config.MEMORY_REVIEW_IDLE_SECONDS <= 0) return;
  await queues.get(ctx)?.add([{ taskId }]);
}
