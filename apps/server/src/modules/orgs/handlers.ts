import type { Schema } from "@agent-base/contract";
import { requireAuth, requireOrgAdmin } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { notFound } from "../../infra/errors.ts";
import * as users from "../auth/service.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const signedIn = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req) };
};

const asAdmin = async (req: Req) => {
  const caller = await signedIn(req);
  requireOrgAdmin(caller.auth);
  return caller;
};

const userId = (req: Req): string => (req.params as { user_id: string }).user_id;

export const createOrg: Handler = async (req, reply) => {
  // Deliberately not `requireAuth`: someone who has left every organization can still start a new one.
  const ctx = req.server.ctx;
  const org = await ctx.db
    .transaction()
    .execute((tx) => service.create(tx, req.userId as string, (req.body as Schema<"OrgNameRequest">).name));
  return reply.code(201).send({ ...org, role: "owner" });
};

export const getOrg: Handler = async (req) => {
  const { ctx, auth } = await signedIn(req);
  return service.get(ctx.db, auth);
};

export const updateOrg: Handler = async (req) => {
  const { ctx, auth } = await asAdmin(req);
  return service.rename(ctx.db, auth, (req.body as Schema<"OrgNameRequest">).name);
};

export const listOrgMembers: Handler = async (req) => {
  const { ctx, auth } = await signedIn(req);
  return { members: await service.listMembers(ctx.db, auth.orgId) };
};

export const updateOrgMember: Handler = async (req) => {
  const { ctx, auth } = await asAdmin(req);
  return service.changeRole(ctx.db, auth, userId(req), (req.body as Schema<"OrgMemberRoleRequest">).role);
};

export const removeOrgMember: Handler = async (req, reply) => {
  const { ctx, auth } = await signedIn(req);
  if (userId(req) !== auth.userId) requireOrgAdmin(auth); // anyone may leave
  await service.removeMember(ctx.db, auth, userId(req));
  return reply.code(204).send();
};

export const createOrgInvite: Handler = async (req, reply) => {
  const { ctx, auth } = await asAdmin(req);
  return reply.code(201).send(await service.invite(ctx.db, auth, req.body as Schema<"OrgInviteRequest">));
};

export const listOrgInvites: Handler = async (req) => {
  const { ctx, auth } = await asAdmin(req);
  return { invites: await service.listInvites(ctx.db, auth.orgId) };
};

export const revokeOrgInvite: Handler = async (req, reply) => {
  const { ctx, auth } = await asAdmin(req);
  await service.revokeInvite(ctx.db, auth, (req.params as { invite_id: string }).invite_id);
  return reply.code(204).send();
};

export const acceptOrgInvite: Handler = async (req) => {
  const ctx = req.server.ctx;
  const user = await users.findUser(ctx.db, req.userId as string);
  if (!user) throw notFound("user");
  const { token } = req.body as Schema<"AcceptInviteRequest">;
  return { org_id: await ctx.db.transaction().execute((tx) => service.acceptInvite(tx, user, token)) };
};
