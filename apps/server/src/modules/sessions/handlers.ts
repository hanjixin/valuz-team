import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as files from "../files/service.ts";
import * as dispatch from "./dispatch.ts";
import * as events from "./events.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  const { session_id, queue_id } = req.params as { session_id?: string; queue_id?: string };
  return { ctx, auth: await requireAuth(ctx, req), id: session_id ?? "", queueId: queue_id ?? "" };
};

export const listSessions: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  const { project_id, q } = req.query as { project_id?: string; q?: string };
  return {
    sessions: await service.list(ctx, auth, { ...(project_id ? { projectId: project_id } : {}), ...(q ? { q } : {}) }),
  };
};

export const createSession: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.create(ctx, auth, req.body as Schema<"SessionCreateRequest">));
};

export const getSession: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.get(ctx, auth, id);
};

export const renameSession: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.rename(ctx, auth, id, (req.query as { name?: string }).name ?? "");
};

export const deleteSession: Handler = async (req, reply) => {
  const { ctx, auth, id } = await caller(req);
  await service.remove(ctx, auth, id);
  return reply.code(204).send();
};

export const sendMessage: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  const { prompt, attachment_ids } = req.body as Schema<"SessionMessageRequest">;
  return dispatch.send(ctx, auth, id, prompt, (session) => files.deliver(ctx, auth, session, attachment_ids ?? []));
};

export const interruptSession: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return dispatch.interrupt(ctx, auth, id);
};

// -- Events --

export const listSessionEvents: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  await service.access(ctx, auth, id);
  return events.listAfter(ctx, id, (req.query as { after_seq?: number }).after_seq ?? 0);
};

export const listSessionEventWindow: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  await service.access(ctx, auth, id);
  const { before_seq, turn_limit } = req.query as { before_seq?: number; turn_limit?: number };
  return events.window(ctx, id, before_seq, turn_limit ?? 20);
};

export const streamSessionEvents: Handler = async (req, reply) => {
  const { ctx, auth, id } = await caller(req);
  await service.access(ctx, auth, id);
  await events.stream(ctx, req, reply, id, (req.query as { after_seq?: number }).after_seq ?? 0);
  return reply;
};

export const streamUserEvents: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  await events.streamForUser(ctx, auth, req, reply, (req.query as { after_seq?: number }).after_seq ?? 0);
  return reply;
};

// -- Queue --

export const listSessionQueue: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return dispatch.listQueue(ctx, auth, id);
};

export const enqueueSessionInput: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return dispatch.enqueue(ctx, auth, id, (req.body as Schema<"QueuedInputCreate">).prompt);
};

export const editSessionQueuedInput: Handler = async (req) => {
  const { ctx, auth, id, queueId } = await caller(req);
  return dispatch.editQueued(ctx, auth, id, queueId, (req.body as Schema<"QueuedInputPatch">).prompt ?? "");
};

export const deleteSessionQueuedInput: Handler = async (req) => {
  const { ctx, auth, id, queueId } = await caller(req);
  return dispatch.deleteQueued(ctx, auth, id, queueId);
};

export const resumeSessionQueue: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return dispatch.resumeQueue(ctx, auth, id);
};

export const steerSessionQueuedInput: Handler = async (req) => {
  const { ctx, auth, id, queueId } = await caller(req);
  return dispatch.steer(ctx, auth, id, queueId);
};

// -- How the session runs --

export const submitSessionAction: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return dispatch.submitAction(ctx, auth, id, req.body as Schema<"SessionActionRequest">);
};

export const updateSessionPermissionMode: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  const { permission_mode } = req.body as Schema<"SessionPermissionModeRequest">;
  return service.setControls(ctx, auth, id, { permission_mode });
};

export const updateSessionMode: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.setControls(ctx, auth, id, { mode: (req.body as Schema<"SessionModeRequest">).mode });
};

export const updateSessionEffort: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.setControls(ctx, auth, id, { effort: (req.body as Schema<"SessionEffortRequest">).effort ?? null });
};

/** Cancelling a session stops what it is doing; it is the same act as interrupting it. */
export const cancelSession: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return dispatch.interrupt(ctx, auth, id);
};

/**
 * The runtime is started on the device by the first message, so there is
 * nothing to warm up from here; this reports whether the device is reachable.
 */
export const prepareSessionRuntime: Handler = async (req, reply) => {
  const { ctx, auth, id } = await caller(req);
  const { row } = await service.access(ctx, auth, id);
  const ready = row.device_id ? (await ctx.hub.online([row.device_id])).has(row.device_id) : false;
  return reply.code(202).send({ ready });
};
