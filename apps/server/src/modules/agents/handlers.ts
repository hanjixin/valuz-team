import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as members from "./members.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req), slug: (req.params as { slug?: string }).slug ?? "" };
};

export const listAgents: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  // Every agent here is member-made; there are no built-in ("official") ones yet.
  const { source } = req.query as { source?: string };
  return { agents: source === "official" ? [] : await service.list(ctx, auth) };
};

export const createAgent: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.create(ctx, auth, req.body as Schema<"CreateAgentRequest">));
};

export const getAgent: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.get(ctx, auth, slug);
};

export const updateAgent: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.update(ctx, auth, slug, req.body as Schema<"UpdateAgentRequest">);
};

export const deleteAgent: Handler = async (req, reply) => {
  const { ctx, auth, slug } = await caller(req);
  await members.removeAgent(ctx, auth, slug, (req.query as { cascade?: boolean }).cascade === true);
  return reply.code(204).send();
};

export const copyAgent: Handler = async (req, reply) => {
  const { ctx, auth, slug } = await caller(req);
  return reply.code(201).send(await service.copy(ctx, auth, slug, (req.body ?? {}) as Schema<"CopyAgentRequest">));
};

export const listAgentDeployments: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return members.deployments(ctx, auth, slug);
};

// -- A project's team --

const inProject = async (req: Req) => {
  const { ctx, auth } = await caller(req);
  const { project_id, agent_slug } = req.params as { project_id: string; agent_slug?: string };
  return { ctx, auth, projectId: project_id, agentSlug: agent_slug ?? "" };
};

export const listProjectAgents: Handler = async (req) => {
  const { ctx, auth, projectId } = await inProject(req);
  return { agents: await members.list(ctx, auth, projectId) };
};

export const deployAgent: Handler = async (req, reply) => {
  const { ctx, auth, projectId } = await inProject(req);
  return reply.code(201).send(await members.deploy(ctx, auth, projectId, req.body as Schema<"DeployAgentRequest">));
};

export const createBlankAgent: Handler = async (req, reply) => {
  const { ctx, auth, projectId } = await inProject(req);
  return reply
    .code(201)
    .send(await members.createBlank(ctx, auth, projectId, req.body as Schema<"CreateBlankAgentRequest">));
};

export const deleteProjectAgent: Handler = async (req, reply) => {
  const { ctx, auth, projectId, agentSlug } = await inProject(req);
  await members.undeploy(ctx, auth, projectId, agentSlug);
  return reply.code(204).send();
};

export const setProjectDefaultLead: Handler = async (req) => {
  const { ctx, auth, projectId } = await inProject(req);
  return members.setDefaultLead(ctx, auth, projectId, (req.query as { agent_slug?: string }).agent_slug || null);
};
