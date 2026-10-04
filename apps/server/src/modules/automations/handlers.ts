import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { notFound } from "../../infra/errors.ts";
import * as settings from "../settings/service.ts";
import { checkCron, checkInterval } from "./schedule.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  const { automation_id, run_id } = req.params as { automation_id?: string; run_id?: string };
  return { ctx, auth: await requireAuth(ctx, req), id: automation_id ?? "", runId: run_id ?? "" };
};

export const listAutomations: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return { groups: await service.list(ctx, auth, (req.query as { project_id?: string }).project_id) };
};

export const createAutomation: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.create(ctx, auth, req.body as Schema<"AutomationCreateRequest">));
};

export const listAutomationProjectTargets: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return { targets: await service.targets(ctx, auth) };
};

/** Nothing but the clock triggers an automation here. */
export const listAutomationEventSources: Handler = async (req) => {
  await caller(req);
  return { sources: [] };
};

export const listAutomationEventRefs: Handler = async (req) => {
  await caller(req);
  throw notFound("event source");
};

export const validateAutomationCron: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  const { expr, timezone } = req.body as Schema<"AutomationCronValidateRequest">;
  const fallback = async () =>
    (await settings.getPreferences(ctx.db, { orgId: auth.orgId, userId: auth.userId })).default_timezone;
  return checkCron(expr, timezone || (await fallback()));
};

export const validateAutomationInterval: Handler = async (req) => {
  const { ctx } = await caller(req);
  const { seconds } = req.body as Schema<"AutomationIntervalValidateRequest">;
  return checkInterval(seconds, ctx.config.AUTOMATION_MIN_INTERVAL_SECONDS);
};

export const getAutomation: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.get(ctx, auth, id);
};

export const updateAutomation: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.update(ctx, auth, id, req.body as Schema<"AutomationUpdateRequest">);
};

export const deleteAutomation: Handler = async (req, reply) => {
  const { ctx, auth, id } = await caller(req);
  await service.remove(ctx, auth, id);
  return reply.code(204).send();
};

export const pauseAutomation: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.setStatus(ctx, auth, id, "paused");
};

export const resumeAutomation: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.setStatus(ctx, auth, id, "enabled");
};

export const runAutomationNow: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  const { input, wait_seconds } = (req.body ?? {}) as Schema<"AutomationRunNowRequest">;
  return service.runNow(ctx, auth, id, { input, ...(wait_seconds ? { waitSeconds: wait_seconds } : {}) });
};

export const listAutomationRuns: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  const { limit, cursor } = req.query as { limit?: number; cursor?: string };
  return { runs: await service.listRuns(ctx, auth, id, limit ?? 20, cursor) };
};

export const getAutomationRun: Handler = async (req) => {
  const { ctx, auth, id, runId } = await caller(req);
  return service.getRun(ctx, auth, id, runId);
};

export const cancelAutomationRun: Handler = async (req) => {
  const { ctx, auth, id, runId } = await caller(req);
  return service.cancelRun(ctx, auth, id, runId);
};
