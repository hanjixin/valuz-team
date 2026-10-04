/**
 * Ready-made teams. Each template is a set of roles — an agent each, with its
 * instructions written — that a member copies into their library in one go.
 * The first-run tour uses them too: it ends by putting a team into an example
 * project, or by giving the member a general assistant.
 *
 * The templates are bundled data carried over from valuz-agent (`./packs`).
 */
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, notFound } from "../../infra/errors.ts";
import * as members from "../agents/members.ts";
import * as agents from "../agents/service.ts";
import * as projects from "../projects/service.ts";
import * as providers from "../providers/service.ts";
import * as settings from "../settings/service.ts";
import { type Localized, PACKS, type Pack } from "./packs/index.ts";

type Template = Schema<"AgentTemplate">;
type Agent = Schema<"Agent">;
type Role = Pack["roles"][number];

const ASSISTANT = {
  slug: "valurion",
  name: "Valurion",
  description: "Your built-in assistant with access to all resources currently available to you.",
  avatar: "bot",
};
const EXAMPLE_PROJECT: Localized = { "zh-CN": "示例项目", "en-US": "Example project" };

async function localeOf(ctx: Ctx, auth: Auth): Promise<keyof Localized> {
  const { default_locale } = await settings.getPreferences(ctx.db, { orgId: auth.orgId, userId: auth.userId });
  return default_locale === "en-US" ? "en-US" : "zh-CN";
}

/**
 * The slugs under which a member may hold a role. A slug is unique in the
 * organization, so when a colleague already took the role's own slug the member's
 * copy gets one of their own — the same one every time, which keeps adding idempotent.
 */
const slugsFor = (auth: Auth, slug: string): [string, string] => [slug, `${slug}-${auth.userId.slice(0, 6)}`];

/** The member's copy of a role, if they have one (their own, or one shared with them). */
export async function held(ctx: Ctx, auth: Auth, slug: string): Promise<Agent | null> {
  for (const candidate of slugsFor(auth, slug)) {
    const agent = await agents.get(ctx, auth, candidate).catch(() => null);
    if (agent) return agent;
  }
  return null;
}

/** What a new agent runs on: the member's default channel, model and runtime. 422 when they have none. */
export async function modelDefaults(ctx: Ctx, auth: Auth) {
  const defaults = await providers.getDefaults(ctx, auth);
  if (!defaults.default_provider_id)
    throw new HttpError(422, "no_model_channel", "add a model channel in Settings → Models first");
  return defaults;
}

export async function ensure(
  ctx: Ctx,
  auth: Auth,
  role: ReturnType<typeof localize> & { skills?: string[] },
): Promise<{ agent: Agent; created: boolean }> {
  const existing = await held(ctx, auth, role.slug);
  if (existing) return { agent: existing, created: false };
  const defaults = await modelDefaults(ctx, auth);
  const [own, fallback] = slugsFor(auth, role.slug);
  const input = {
    name: role.name,
    description: role.description,
    instructions: role.instructions,
    avatar: role.avatar,
    effort: role.effort,
    provider_id: defaults.default_provider_id,
    runtime: defaults.default_runtime,
    model: defaults.default_model ?? "",
    skills: role.skills ?? [],
  };
  const taken = await agents.slugTaken(ctx, auth, own);
  const agent = await agents.create(ctx, auth, {
    ...input,
    slug: taken ? fallback : own,
  } as Schema<"CreateAgentRequest">);
  return { agent, created: true };
}

const localize = (role: Role, locale: keyof Localized) => ({
  slug: role.slug,
  name: role.name[locale],
  description: role.description[locale],
  instructions: role.instructions[locale],
  avatar: role.avatar,
  effort: role.effort,
});

// ------------------------------------------------------------------ templates

export async function list(ctx: Ctx, auth: Auth): Promise<Template[]> {
  const locale = await localeOf(ctx, auth);
  const runtime = (await providers.getDefaults(ctx, auth)).default_runtime;
  return Promise.all(
    PACKS.map(async (pack): Promise<Template> => {
      const roles = await Promise.all(
        pack.roles.map(async (role) => ({
          ...localize(role, locale),
          skills: [],
          connector_types: [],
          runtime,
          in_library: (await held(ctx, auth, role.slug)) !== null,
        })),
      );
      return {
        id: pack.id,
        scenario: pack.scenario[locale],
        name: pack.name[locale],
        description: pack.description[locale],
        icon: pack.icon,
        added: roles.every((role) => role.in_library),
        roles,
      };
    }),
  );
}

/** Copy a template's roles into the member's library; roles already there are left alone. */
export async function add(ctx: Ctx, auth: Auth, templateId: string): Promise<Schema<"AddAgentTemplateResponse">> {
  const pack = PACKS.find((candidate) => candidate.id === templateId);
  if (!pack) throw notFound("template");
  await modelDefaults(ctx, auth);
  const locale = await localeOf(ctx, auth);
  const results = [];
  for (const role of pack.roles) results.push(await ensure(ctx, auth, localize(role, locale)));
  const created = results.filter((result) => result.created).length;
  return {
    template_id: pack.id,
    created,
    skipped: results.length - created,
    roles: results.map((result) => result.agent),
  };
}

// ------------------------------------------------------------------ the first-run tour

/** The general assistant every member can start with. Made once; found again afterwards. */
export async function assistant(ctx: Ctx, auth: Auth): Promise<{ agent_slug: string }> {
  const { agent } = await ensure(ctx, auth, { ...ASSISTANT, effort: "high", instructions: "" });
  return { agent_slug: agent.slug };
}

/** An example project with one of the templates as its team. Calling again finds the same project. */
export async function exampleProject(ctx: Ctx, auth: Auth, teamId: string): Promise<Schema<"ExampleProjectResponse">> {
  const { roles } = await add(ctx, auth, teamId);
  const name = EXAMPLE_PROJECT[await localeOf(ctx, auth)];
  const mine = (await projects.list(ctx, auth)).find(
    (project) => project.kind !== "chat" && project.owner_id === auth.userId && project.name === name,
  );
  const project = mine ?? (await projects.create(ctx, auth, { name } as Schema<"ProjectCreateRequest">));
  const team = new Set((await members.teamFor(ctx.db, project.id)).map((member) => member.agent.id));
  for (const role of roles)
    if (!team.has(role.id)) await members.deploy(ctx, auth, project.id, { source_agent_slug: role.slug });
  if (!mine && roles[0]) await projects.setDefaultLead(ctx, auth, project.id, roles[0].slug);
  return { project_id: project.id, project_name: project.name };
}
