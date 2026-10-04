/**
 * Running an automation. The clock is BullMQ's (`infra/jobs.ts`): with several
 * replicas each firing reaches exactly one. This decides what a firing does —
 * start a conversation with an agent, or hand a goal to a project's team — as
 * the automation's owner, on the device their sessions run on.
 */
import { managedCwd } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { authFor } from "../../infra/auth.ts";
import type { Ctx } from "../../infra/context.ts";
import { HttpError } from "../../infra/errors.ts";
import { type JobQueue, startJobs } from "../../infra/jobs.ts";
import * as notifications from "../notifications/service.ts";
import * as projects from "../projects/service.ts";
import { type TurnEnd, dispatchTurn } from "../sessions/dispatch.ts";
import * as sessions from "../sessions/service.ts";
import * as tasks from "../tasks/service.ts";
import * as repo from "./repo.ts";
import { repeatOf } from "./schedule.ts";

interface Firing {
  automationId: string;
  /** Set when a person asked for this run: it was recorded before it was queued. */
  runId?: string;
}

const queues = new WeakMap<Ctx, JobQueue<Firing>>();
const queueOf = (ctx: Ctx): JobQueue<Firing> => {
  const queue = queues.get(ctx);
  if (!queue) throw new Error("automations were not started");
  return queue;
};

/** Make the clock match the automation: scheduled while enabled and repeating, otherwise not. */
export async function sync(ctx: Ctx, automation: Pick<repo.AutomationRow, "id" | "status" | "trigger">): Promise<void> {
  const repeat = automation.status === "enabled" ? repeatOf(automation.trigger) : null;
  if (repeat) await queueOf(ctx).schedule(automation.id, repeat, { automationId: automation.id });
  else await queueOf(ctx).unschedule(automation.id);
}

export const unschedule = (ctx: Ctx, id: string): Promise<void> => queueOf(ctx).unschedule(id);
export const nextRun = (ctx: Ctx, id: string): Promise<number | null> => queueOf(ctx).nextRun(id);

/** Record a run a person asked for and start it. */
export async function runNow(ctx: Ctx, automationId: string, input: unknown): Promise<string> {
  const runId = crypto.randomUUID();
  await repo.insertRun(ctx.db, {
    id: runId,
    automation_id: automationId,
    trigger_type: "manual",
    status: "running",
    input,
  });
  await queueOf(ctx).add([{ automationId, runId }]);
  return runId;
}

const text = (input: unknown): string =>
  input === null || input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input, null, 2);

async function fire(app: FastifyInstance, firing: Firing): Promise<void> {
  const ctx = app.ctx;
  const automation = await repo.byId(ctx.db, firing.automationId);
  if (!automation) return; // deleted since this was queued
  let runId = firing.runId;
  let input: unknown;
  if (runId) {
    const run = await repo.findRun(ctx.db, automation.id, runId);
    if (run?.status !== "running") return; // cancelled before it began
    input = run.input;
  } else {
    if (automation.status !== "enabled") return; // paused since this was queued
    runId = crypto.randomUUID();
    const run = { id: runId, automation_id: automation.id, trigger_type: automation.trigger.kind };
    // One at a time: a firing that finds the last one still working is noted and dropped.
    if (await repo.hasActiveRun(ctx.db, automation.id))
      return void (await repo.insertRun(ctx.db, {
        ...run,
        status: "skipped",
        error_code: "previous_run_active",
        error_message: "the previous run was still going",
      }));
    await repo.insertRun(ctx.db, { ...run, status: "running" });
  }

  try {
    const owner = await authFor(ctx, automation.org_id, automation.owner_id);
    if (!owner) throw new HttpError(409, "owner_left", "the automation's owner is no longer in this organization");
    const prompt = [automation.prompt_template, text(input)].filter(Boolean).join("\n\n");
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

    if (automation.action_kind === "task") {
      const project = await projects.require(ctx, owner, automation.project_id, "use");
      const taskId = await tasks.create(app, {
        owner,
        projectId: project.id,
        deviceId: await sessions.deviceFor(ctx, owner, null, project.device_id),
        cwd: project.root_path ?? managedCwd(`project-${project.id}`),
        title: `${automation.name} · ${stamp}`,
        goal: prompt,
        leadAgentSlug: automation.agent_slug ?? project.default_lead_agent_slug ?? "",
        draft: false,
      });
      await repo.linkRun(ctx.db, runId, { task_id: taskId });
      // The run's job was to hand the goal over; how the task goes is the task's own story.
      await repo.settleRun(ctx.db, { id: runId }, { status: "success", result_summary: "任务已交给团队" });
      return;
    }

    const session = await sessions.create(
      ctx,
      owner,
      {
        project_id: automation.project_id,
        title: `${automation.name} · ${stamp}`,
        ...(automation.agent_slug ? { agent_slug: automation.agent_slug } : {}),
      },
      { origin: "automation", metadata: { valuz: { automation: { automation_id: automation.id, run_id: runId } } } },
    );
    await repo.linkRun(ctx.db, runId, { session_id: session.id });
    await dispatchTurn(ctx, session.id, prompt, { user_id: owner.userId, name: owner.name });
  } catch (err) {
    // A run that could not start is recorded, not retried: the next firing is the retry.
    const known = err instanceof HttpError;
    if (!known) ctx.log(err, `automation ${automation.id}: run ${runId} crashed`);
    const settled = await repo.settleRun(
      ctx.db,
      { id: runId },
      {
        status: "failed",
        error_code: known ? err.code : "internal_error",
        error_message: known ? err.message : "the run could not be started",
      },
    );
    if (settled) await tell(ctx, automation, "failed", known ? err.message : "the run could not be started", null);
  }
}

async function tell(
  ctx: Ctx,
  automation: NonNullable<Awaited<ReturnType<typeof repo.byId>>>,
  outcome: "success" | "failed",
  body: string,
  sessionId: string | null,
): Promise<void> {
  await notifications.notify(
    ctx,
    { orgId: automation.org_id, userId: automation.owner_id },
    {
      kind: outcome === "failed" ? "automation_failed" : "automation_completed",
      title: `${outcome === "failed" ? "自动化运行失败" : "自动化已完成"}：${automation.name}`,
      body: body.slice(0, 300),
      route: sessionId ? `/conversation/${sessionId}` : `/automations/${automation.id}`,
      projectId: automation.project_id,
      ...(sessionId ? { sessionId } : {}),
    },
  );
}

/** A turn ended on a device: if a run was waiting on it, that is the run's result. */
export async function handleTurnEnd(ctx: Ctx, turn: TurnEnd): Promise<void> {
  if (turn.status === "running") return;
  const failed = turn.status !== "completed";
  const reason = String((turn.error_message as { message?: unknown } | null)?.message ?? turn.status);
  const settled = await repo.settleRun(
    ctx.db,
    { sessionId: turn.session_id },
    failed
      ? {
          status: turn.status === "cancelled" ? "cancelled" : "failed",
          error_code: "run_failed",
          error_message: reason,
        }
      : { status: "success", result_summary: turn.assistant_message?.slice(0, 4000) ?? null },
  );
  if (settled?.automation && turn.status !== "cancelled")
    await tell(
      ctx,
      settled.automation,
      failed ? "failed" : "success",
      failed ? reason : (turn.assistant_message ?? ""),
      turn.session_id,
    );
}

export function start(app: FastifyInstance): void {
  queues.set(
    app.ctx,
    startJobs<Firing>(app, "automations", (firing) => fire(app, firing), { concurrency: 4 }),
  );
}
