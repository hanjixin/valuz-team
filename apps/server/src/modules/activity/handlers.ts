import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

export const listActivity: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const { project_id, tab, limit, cursor } = req.query as {
    project_id?: string;
    tab?: "all" | "chat" | "task" | "automation";
    limit?: number;
    cursor?: string;
  };
  return service.page(ctx, auth, {
    ...(project_id ? { projectId: project_id } : {}),
    ...(cursor ? { cursor } : {}),
    tab: tab ?? "all",
    limit: limit ?? 20,
  });
};
