import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req), id: (req.params as { project_id?: string }).project_id ?? "" };
};

export const listProjects: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return { projects: await service.list(ctx, auth) };
};

export const createProject: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.create(ctx, auth, req.body as Schema<"ProjectCreateRequest">));
};

export const getProject: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.get(ctx, auth, id);
};

export const renameProject: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.rename(ctx, auth, id, (req.query as { name: string }).name);
};

export const updateProjectInstructions: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  await service.setInstructions(ctx, auth, id, (req.query as { instructions_md: string }).instructions_md);
  return { ok: true };
};

export const getProjectDeletePreview: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.deletePreview(ctx, auth, id);
};

export const deleteProject: Handler = async (req, reply) => {
  const { ctx, auth, id } = await caller(req);
  await service.remove(ctx, auth, id);
  return reply.code(204).send();
};

/** Nothing has run in a project until sessions are ported. */
export const getProjectLastSessionPick: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  await service.require(ctx, auth, id);
  return { runtime_provider: null, provider_id: null, model_id: null, agent_slug: null, task_agent_slug: null };
};
