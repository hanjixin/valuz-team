import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { notFound } from "../../infra/errors.ts";
import * as audit from "../audit/service.ts";
import * as service from "./service.ts";

interface Params {
  resource_type: service.ShareableType;
  resource_id: string;
  share_id: string;
}

/** Managing shares needs `admin` on the resource: its owner, or an organization owner/admin. */
const admin = async (req: Parameters<Handler>[0]) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const { resource_type: type, resource_id: id, share_id: shareId } = req.params as Params;
  await service.requirePermission(ctx.db, auth, type, id, "admin");
  return { ctx, auth, type, id, shareId };
};

export const listShares: Handler = async (req) => {
  const { ctx, type, id } = await admin(req);
  return { shares: await service.listShares(ctx.db, type, id) };
};

export const putShare: Handler = async (req) => {
  const { ctx, auth, type, id } = await admin(req);
  const input = req.body as Schema<"ShareRequest">;
  const share = await service.putShare(ctx.db, auth, type, id, input);
  await audit.record(ctx.db, auth, "share.grant", { type, id }, { ...input, principal_id: share.principal_id });
  return share;
};

export const deleteShare: Handler = async (req, reply) => {
  const { ctx, auth, type, id, shareId } = await admin(req);
  if (!(await service.deleteShare(ctx.db, type, id, shareId))) throw notFound("share");
  await audit.record(ctx.db, auth, "share.revoke", { type, id }, { share_id: shareId });
  return reply.code(204).send();
};
