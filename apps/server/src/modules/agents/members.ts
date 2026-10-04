/**
 * A project's team. Deploying an agent to a project is a live reference, not a
 * copy: improve the agent in the library and every project it is deployed to
 * gets the improvement.
 */
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest, conflict, notFound } from "../../infra/errors.ts";
import * as audit from "../audit/service.ts";
import * as projects from "../projects/service.ts";
import * as repo from "./members-repo.ts";
import * as agents from "./service.ts";
import { deriveSlug, ensureUniqueSlug, isValidSlug } from "./slug.ts";

type Member = Schema<"MemberWithAgent">;

const present = (row: repo.MemberRow): Member => ({
  member: {
    id: row.id,
    project_id: row.project_id,
    agent_slug: row.agent_slug,
    source_agent_slug: row.source_agent_slug,
  },
  agent: {
    id: row.agent_id,
    name: row.name,
    model: row.model,
    runtime_provider: row.runtime,
    instructions: row.instructions,
    skills: row.skills,
    connectors: row.connector_types,
    provider_id: row.provider_id,
    effort: row.effort as Schema<"AgentSummary">["effort"],
    resource_policy: "explicit",
  },
});

export async function list(ctx: Ctx, auth: Auth, projectId: string): Promise<Member[]> {
  await projects.require(ctx, auth, projectId);
  return (await repo.listForProject(ctx.db, projectId)).map(present);
}

/** Put a library agent on the project's team. Needs `edit` on the project and `use` on the agent. */
export async function deploy(
  ctx: Ctx,
  auth: Auth,
  projectId: string,
  input: Schema<"DeployAgentRequest">,
): Promise<Member> {
  await projects.require(ctx, auth, projectId, "edit");
  const agent = await agents.require(ctx, auth, input.source_agent_slug, "use");
  const team = await repo.listForProject(ctx.db, projectId);
  if (team.some((member) => member.agent_id === agent.id))
    throw conflict(`agent '${agent.slug}' is already on this project's team`, "already_deployed");
  const taken = new Set(team.map((member) => member.agent_slug));
  const wanted = input.agent_slug?.trim();
  if (wanted && !isValidSlug(wanted)) throw badRequest("that handle is not a valid slug", "invalid_slug");
  if (wanted && taken.has(wanted)) throw conflict(`'${wanted}' is already a member of this project`, "slug_taken");
  const member = {
    id: crypto.randomUUID(),
    project_id: projectId,
    agent_id: agent.id,
    // By default a member keeps its library handle; a clash gets the next free one.
    agent_slug: wanted || ensureUniqueSlug(agent.slug || deriveSlug(agent.name), taken),
  };
  await repo.insert(ctx.db, member);
  await audit.record(
    ctx.db,
    auth,
    "project.deploy_agent",
    { type: "project", id: projectId },
    { agent: agent.slug, as: member.agent_slug },
  );
  return present((await repo.findInProject(ctx.db, projectId, member.agent_slug)) as repo.MemberRow);
}

/** Create a new library agent and put it straight on the project's team. */
export async function createBlank(
  ctx: Ctx,
  auth: Auth,
  projectId: string,
  input: Schema<"CreateBlankAgentRequest">,
): Promise<Member> {
  await projects.require(ctx, auth, projectId, "edit");
  const agent = await agents.create(ctx, auth, {
    name: input.name,
    slug: input.agent_slug ?? null,
    description: "",
    inherit_global_instructions: true,
    permission_mode: "full_access",
    instructions: input.instructions ?? "",
    runtime: input.runtime ?? "claude_agent",
    model: input.model ?? "claude-sonnet-4-6",
    provider_id: input.provider_id ?? null,
    effort: input.effort ?? null,
    skills: input.skills ?? [],
    connector_types: (input.connector_bindings ?? []).map((binding) => binding.type),
  });
  return deploy(ctx, auth, projectId, { source_agent_slug: agent.slug });
}

/** Take a member off the team. The library agent is untouched. */
export async function undeploy(ctx: Ctx, auth: Auth, projectId: string, agentSlug: string): Promise<void> {
  const project = await projects.require(ctx, auth, projectId, "edit");
  const member = await repo.findInProject(ctx.db, projectId, agentSlug);
  if (!member) throw notFound("project member");
  await repo.remove(ctx.db, member.id);
  // A lead who left the team no longer leads it.
  if (project.default_lead_agent_slug === agentSlug) await projects.setDefaultLead(ctx, auth, projectId, null);
  await audit.record(ctx.db, auth, "project.undeploy_agent", { type: "project", id: projectId }, { as: agentSlug });
}

/** The default task lead must be on the team. */
export async function setDefaultLead(ctx: Ctx, auth: Auth, projectId: string, agentSlug: string | null) {
  await projects.require(ctx, auth, projectId, "edit");
  if (agentSlug && !(await repo.findInProject(ctx.db, projectId, agentSlug)))
    throw badRequest(`'${agentSlug}' is not a member of this project`, "not_a_member");
  return projects.setDefaultLead(ctx, auth, projectId, agentSlug);
}

/** Where an agent is deployed, among the projects the caller can see. */
export async function deployments(ctx: Ctx, auth: Auth, slug: string) {
  const agent = await agents.require(ctx, auth, slug);
  const visible = new Set((await projects.list(ctx, auth)).map((project) => project.id));
  const rows = (await repo.listForAgent(ctx.db, agent.id)).filter((row) => visible.has(row.project_id));
  return { deployments: rows, count: rows.length };
}

/**
 * Delete a library agent. One that is still on a team is refused unless
 * `cascade` — then it leaves every team it is on.
 */
export async function removeAgent(ctx: Ctx, auth: Auth, slug: string, cascade: boolean): Promise<void> {
  const agent = await agents.require(ctx, auth, slug, "admin");
  const deployed = await repo.listForAgent(ctx.db, agent.id);
  if (deployed.length > 0 && !cascade)
    throw conflict(
      `this agent is deployed to ${deployed.length} project(s); remove it from them first, or delete with cascade`,
      "agent_deployed",
    );
  await agents.remove(ctx, auth, slug);
}
