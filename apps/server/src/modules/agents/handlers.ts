import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { conflict } from "../../infra/errors.ts";
import * as members from "./members.ts";
import { everythingFor } from "./available.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req), slug: (req.params as { slug?: string }).slug ?? "" };
};

export const listAgents: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  // "custom" is what members made; nothing here is "official" — the one built-in is the assistant.
  const { source } = req.query as { source?: string };
  const agents = source === "official" ? [] : await service.list(ctx, auth);
  return { agents: source ? agents.filter((agent) => agent.source === source) : agents };
};

export const createAgent: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.create(ctx, auth, req.body as Schema<"CreateAgentRequest">));
};

export const getAgent: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.get(ctx, auth, slug);
};

/**
 * What an "all available" agent — the built-in assistant — can reach right now.
 * Every other agent names its skills and connectors, so there is nothing to resolve.
 */
export const getAgentEffectiveResources: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  const agent = await service.get(ctx, auth, slug);
  if (agent.resource_policy !== "all_available")
    throw conflict("this agent uses the skills and connectors it names", "explicit_resources");
  const all = await everythingFor(ctx, auth);
  const skills = all.skills.map((skill) => ({
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    source: skill.source,
    status: "available",
  }));
  const connectors = all.connectors.map((connector) => ({
    id: connector.id,
    slug: connector.slug,
    name: connector.display_name,
    source: "custom",
    status: connector.status,
  }));
  const knowledge_bases = all.knowledgeBases.map((base) => ({
    id: base.id,
    slug: base.id,
    name: base.name,
    source: "org",
    status: "available",
  }));
  return {
    policy: "all_available",
    resolved_at: Date.now(),
    counts: { skills: skills.length, connectors: connectors.length, knowledge_bases: knowledge_bases.length },
    skills,
    connectors,
    knowledge_bases,
    warnings: [],
  };
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
