import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

export const getMemory: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.view(ctx, await requireAuth(ctx, req), (req.query as { project_id?: string }).project_id);
};

export const patchMemorySettings: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.patchSettings(ctx, await requireAuth(ctx, req), req.body as Schema<"MemorySettingsPatch">);
};

export const deleteMemoryEntry: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.deleteEntry(ctx, await requireAuth(ctx, req), req.body as Schema<"MemoryEntryDelete">);
};

export const clearMemoryScope: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.clearScope(ctx, await requireAuth(ctx, req), req.body as Schema<"MemoryClear">);
};
