import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];
const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, inbox: await requireAuth(ctx, req), id: (req.params as { notification_id?: string }).notification_id };
};

export const listNotifications: Handler = async (req) => {
  const { ctx, inbox } = await caller(req);
  return service.listOpen(ctx, inbox);
};

export const listNotificationHistory: Handler = async (req) => {
  const { ctx, inbox } = await caller(req);
  const { limit = 50, before } = req.query as { limit?: number; before?: number };
  return service.history(ctx, inbox, { limit, ...(before === undefined ? {} : { before }) });
};

export const streamNotifications: Handler = async (req, reply) => {
  const { ctx, inbox } = await caller(req);
  await service.stream(ctx, inbox, req, reply);
  return reply;
};

export const markNotificationRead: Handler = async (req) => {
  const { ctx, inbox, id } = await caller(req);
  await service.markRead(ctx, inbox, id ?? "");
  return { ok: true };
};

export const markAllNotificationsRead: Handler = async (req) => {
  const { ctx, inbox } = await caller(req);
  await service.markRead(ctx, inbox);
  return { ok: true };
};

export const dismissNotification: Handler = async (req) => {
  const { ctx, inbox, id } = await caller(req);
  await service.dismiss(ctx, inbox, id ?? "");
  return { ok: true };
};

export const dismissAllNotifications: Handler = async (req) => {
  const { ctx, inbox } = await caller(req);
  await service.dismiss(ctx, inbox);
  return { ok: true };
};
