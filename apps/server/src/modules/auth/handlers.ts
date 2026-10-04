import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { notFound } from "../../infra/errors.ts";
import * as repo from "./repo.ts";
import * as service from "./service.ts";

export const registerAccount: Handler = async (req, reply) =>
  reply.code(201).send(await service.register(req.server, req.body as Schema<"RegisterRequest">));

export const login: Handler = (req) => service.login(req.server, req.body as Schema<"LoginRequest">);

export const refreshTokens: Handler = (req) =>
  service.refresh(req.server, (req.body as Schema<"RefreshRequest">).refresh_token);

export const logout: Handler = async (req, reply) => {
  await service.logout(req.server.ctx, (req.body as Schema<"RefreshRequest">).refresh_token);
  return reply.code(204).send();
};

export const getMe: Handler = async (req): Promise<Schema<"Me">> => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const user = await repo.findUserById(ctx.db, auth.userId);
  if (!user) throw notFound("user");
  return { user, orgs: await repo.listMemberships(ctx.db, auth.userId), current_org_id: auth.orgId, role: auth.role };
};
