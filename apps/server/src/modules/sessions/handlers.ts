import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
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
  return dispatch.send(ctx, auth, id, (req.body as Schema<"SessionMessageRequest">).prompt);
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
