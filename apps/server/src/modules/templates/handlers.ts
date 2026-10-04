import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

export const listAgentTemplates: Handler = async (req) => {
  const ctx = req.server.ctx;
  return { templates: await service.list(ctx, await requireAuth(ctx, req)) };
};

export const addAgentTemplate: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.add(ctx, await requireAuth(ctx, req), (req.params as { template_id: string }).template_id);
};

export const createAssistant: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.assistant(ctx, await requireAuth(ctx, req));
};

export const createExampleProject: Handler = async (req) => {
  const ctx = req.server.ctx;
  const { team_id } = req.body as Schema<"ExampleProjectRequest">;
  return service.exampleProject(ctx, await requireAuth(ctx, req), team_id);
};
