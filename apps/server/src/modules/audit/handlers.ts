import { requireAuth, requireOrgAdmin } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

export const listAuditLogs: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  requireOrgAdmin(auth);
  const { limit = 50, before } = req.query as { limit?: number; before?: number };
  return { logs: await service.list(ctx.db, auth.orgId, { limit, ...(before === undefined ? {} : { before }) }) };
};
