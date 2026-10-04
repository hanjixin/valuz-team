import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

export const getPreferences: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.getPreferences(ctx.db, await requireAuth(ctx, req));
};

export const patchPreferences: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.patchPreferences(ctx.db, await requireAuth(ctx, req), req.body as Schema<"PreferencesPatch">);
};
