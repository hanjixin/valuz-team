/**
 * A project as one file to hand to someone else, or to set up again elsewhere:
 * what it is told (its instructions), who works in it (its team, with the
 * agents and the skills they carry), what it runs by the clock (its
 * automations), what it brings to every session (its connectors, by name) and
 * what it has learned (its project memory).
 *
 * Not its files: a project's folder lives on a device and stays there. And, as
 * with an agent pack, no model channel and no secret — a connector is named,
 * for whoever imports it to set up themselves.
 */
import type { Schema } from "@agent-base/contract";
import type { AutomationTrigger, SkillFile } from "@agent-base/db";
import { strToU8, zipSync } from "fflate";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, badRequest } from "../../infra/errors.ts";
import * as members from "../agents/members.ts";
import * as automations from "../automations/service.ts";
import * as connectors from "../connectors/service.ts";
import * as memory from "../memory/service.ts";
import * as projects from "../projects/service.ts";
import { MANIFEST, type Manifest, bundle, land, readPack } from "./pack.ts";
import { held } from "./service.ts";

interface ProjectManifest extends Pick<Manifest, "agents" | "skills" | "connectors"> {
  schema_version: 1;
  kind: "project-pack";
  project: {
    name: string;
    icon: string | null;
    instructions: string;
    default_lead_agent_slug: string | null;
    /** Connectors the project gives every session in it, by slug. */
    connectors: string[];
    /** What the project remembers, oldest first. */
    memory: string[];
  };
  /** The team: each member's handle in the project, and the library agent it is. */
  members: { agent_slug: string; source_agent_slug: string }[];
  automations: {
    name: string;
    /** Whether `agent_slug` is a member's handle in the project, or an agent of the library. */
    agent_kind: "project_member" | "library_agent" | null;
    agent_slug: string | null;
    prompt_template: string;
    trigger: AutomationTrigger;
    action_kind: "chat" | "task";
  }[];
}

interface Staged {
  manifest: ProjectManifest;
  skillFiles: Record<string, SkillFile[]>;
}

const STAGE_SECONDS = 15 * 60;
const stageKey = (auth: Auth, id: string): string => `project-pack:${auth.orgId}:${auth.userId}:${id}`;
const fileName = (name: string): string =>
  `${name.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60) || "project"}.valuzpack`;

export async function exportProject(
  ctx: Ctx,
  auth: Auth,
  projectId: string,
): Promise<{ bytes: Buffer; filename: string }> {
  const project = await projects.get(ctx, auth, projectId);
  if (project.kind === "chat") throw new HttpError(422, "not_exportable", "a quick chat is not a project to export");
  // The library agent each member is; a member whose agent is gone has nothing to carry.
  const team = (await members.list(ctx, auth, project.id)).flatMap((entry) =>
    entry.member.source_agent_slug
      ? [{ agent_slug: entry.member.agent_slug, source_agent_slug: entry.member.source_agent_slug }]
      : [],
  );
  const { files, ...carried } = await bundle(
    ctx,
    auth,
    team.map((entry) => entry.source_agent_slug),
  );
  const groups = await automations.list(ctx, auth, project.id);
  const scheduled = await Promise.all(
    groups.flatMap((group) => group.automations).map((item) => automations.get(ctx, auth, item.automation_id)),
  );
  const known = new Map((await connectors.list(ctx, auth)).map((connector) => [connector.slug, connector]));
  const own = (await projects.connectorsOf(ctx, auth, project.id)).slugs;
  const manifest: ProjectManifest = {
    schema_version: 1,
    kind: "project-pack",
    project: {
      name: project.name,
      icon: project.icon ?? null,
      instructions: project.instructions_md ?? "",
      default_lead_agent_slug: project.default_lead_agent_slug ?? null,
      connectors: own,
      memory: await memory.read(ctx, { orgId: auth.orgId, userId: auth.userId, projectId: project.id }, "project"),
    },
    members: team,
    ...carried,
    // The project's own connectors are named alongside its agents', once each.
    connectors: [
      ...carried.connectors,
      ...own
        .filter((slug) => !carried.connectors.some((connector) => connector.slug === slug))
        .map((slug) => ({ slug, display_name: known.get(slug)?.display_name ?? slug })),
    ],
    automations: scheduled.map((item) => ({
      name: item.name,
      agent_kind: item.agent_kind ?? null,
      agent_slug: item.agent_slug ?? null,
      prompt_template: item.prompt_template,
      trigger: item.trigger as AutomationTrigger,
      action_kind: item.action_kind,
    })),
  };
  files[MANIFEST] = strToU8(JSON.stringify(manifest, null, 2));
  return { bytes: Buffer.from(zipSync(files)), filename: fileName(project.name) };
}

const read = (bytes: Buffer): Staged =>
  readPack<ProjectManifest>(
    bytes,
    "a project pack",
    (manifest) =>
      manifest.kind === "project-pack" && typeof manifest.project?.name === "string" && Array.isArray(manifest.members),
  );

const nameTaken = async (ctx: Ctx, auth: Auth, name: string): Promise<boolean> =>
  (await projects.list(ctx, auth)).some((project) => project.kind !== "chat" && project.name === name);

/** Read an uploaded pack and say what importing it would do. Nothing is changed yet. */
export async function preview(ctx: Ctx, auth: Auth, bytes: Buffer): Promise<Schema<"ImportProjectPreviewResponse">> {
  const staged = read(bytes);
  const { manifest } = staged;
  const id = crypto.randomUUID();
  await ctx.redis.set(stageKey(auth, id), JSON.stringify(staged), "EX", STAGE_SECONDS);
  const present = new Set((await connectors.list(ctx, auth)).map((connector) => connector.slug));
  const agentOf = new Map((manifest.agents ?? []).map((agent) => [agent.slug, agent]));
  return {
    preview_id: id,
    project: {
      name: manifest.project.name,
      kind: "project",
      icon: manifest.project.icon ?? null,
      instructions_md: manifest.project.instructions ?? "",
    },
    name_conflict: await nameTaken(ctx, auth, manifest.project.name),
    members: await Promise.all(
      manifest.members.map(async (entry) => ({
        agent_slug: entry.agent_slug,
        source_agent_slug: entry.source_agent_slug,
        name: agentOf.get(entry.source_agent_slug)?.name ?? entry.source_agent_slug,
        description: agentOf.get(entry.source_agent_slug)?.description ?? "",
        in_library: (await held(ctx, auth, entry.source_agent_slug)) !== null,
      })),
    ),
    automations: (manifest.automations ?? []).map((item) => ({
      name: item.name,
      agent_slug: item.agent_slug ?? "",
      trigger_kind: item.trigger.kind,
      cron_expr: item.trigger.cron_expr ?? null,
      interval_seconds: item.trigger.seconds ?? null,
      // An imported automation waits to be switched on: nothing starts running because a file was opened.
      status: "paused",
    })),
    project_skills: [],
    project_connectors: manifest.project.connectors ?? [],
    skills: (manifest.skills ?? []).map((skill) => ({ slug: skill.slug, source: "embedded" as const })),
    connectors: (manifest.connectors ?? []).map((connector) => ({
      slug: connector.slug,
      display_name: connector.display_name,
      requires_credentials: !present.has(connector.slug),
      requires_setup: !present.has(connector.slug),
      already_present: present.has(connector.slug),
    })),
    has_memory: (manifest.project.memory ?? []).length > 0,
  };
}

/** Carry out a previewed import: the agents and their skills, then the project, its team, its automations. */
export async function confirm(
  ctx: Ctx,
  auth: Auth,
  previewId: string,
): Promise<Schema<"ImportProjectConfirmResponse">> {
  // Taken, not read: a preview is confirmed once.
  const raw = await ctx.redis.getdel(stageKey(auth, previewId));
  if (!raw)
    throw badRequest("this import preview has expired or was already used; upload the pack again", "preview_expired");
  const { manifest, skillFiles } = JSON.parse(raw) as Staged;
  const nothing = {
    project: null,
    project_id: null,
    project_name: null,
    members_created: 0,
    members_reused: 0,
    agents_created: 0,
    agents_skipped: 0,
    automations_created: 0,
    automation_errors: [],
    members: [],
    automations: [],
    connectors_to_configure: [],
  };
  // A project of that name is already here: say so rather than make a second one beside it.
  if (await nameTaken(ctx, auth, manifest.project.name)) return { status: "skipped_name_conflict", ...nothing };

  const landed = await land(ctx, auth, manifest, skillFiles);
  // The slug each packed agent has in this library (its own, or one of the importer's when the slug was taken).
  const here = new Map(
    manifest.agents.map((agent, index) => [agent.slug, landed.results[index]?.agent.slug ?? agent.slug]),
  );
  const project = await projects.create(ctx, auth, {
    name: manifest.project.name,
    icon: manifest.project.icon,
  } as Schema<"ProjectCreateRequest">);
  if (manifest.project.instructions)
    await projects.setInstructions(ctx, auth, project.id, manifest.project.instructions);

  const team: { agent_slug: string; source_agent_slug: string }[] = [];
  for (const entry of manifest.members) {
    const source = here.get(entry.source_agent_slug) ?? entry.source_agent_slug;
    const deployed = await members
      .deploy(ctx, auth, project.id, { source_agent_slug: source, agent_slug: entry.agent_slug })
      .catch(() => members.deploy(ctx, auth, project.id, { source_agent_slug: source }).catch(() => null));
    if (deployed) team.push({ agent_slug: deployed.member.agent_slug, source_agent_slug: source });
  }
  const lead = manifest.project.default_lead_agent_slug;
  if (lead && team.some((entry) => entry.agent_slug === lead))
    await projects.setDefaultLead(ctx, auth, project.id, lead).catch(() => undefined);
  if (manifest.project.connectors?.length)
    await projects.setConnectors(ctx, auth, project.id, manifest.project.connectors);
  for (const entry of manifest.project.memory ?? [])
    await memory
      .add(ctx, { orgId: auth.orgId, userId: auth.userId, projectId: project.id }, "project", entry, "imported")
      .catch(() => undefined); // an entry the store would not take today is left behind, not fatal

  const made: { automation_id: string; name: string }[] = [];
  const errors: { name: string; error: string }[] = [];
  for (const item of manifest.automations ?? []) {
    try {
      const created = await automations.create(ctx, auth, {
        name: item.name,
        project_kind: "project",
        project_id: project.id,
        // A library agent is named by the slug it has here, which is the importer's when the pack's was taken.
        agent_kind: item.agent_kind,
        agent_slug:
          item.agent_kind === "library_agent" && item.agent_slug
            ? (here.get(item.agent_slug) ?? item.agent_slug)
            : item.agent_slug,
        prompt_template: item.prompt_template,
        trigger: item.trigger,
        action_kind: item.action_kind,
      } as Schema<"AutomationCreateRequest">);
      await automations.setStatus(ctx, auth, created.automation_id, "paused");
      made.push({ automation_id: created.automation_id, name: created.name });
    } catch (err) {
      errors.push({ name: item.name, error: (err as Error).message });
    }
  }

  const agentsCreated = landed.results.filter((result) => result.created).length;
  return {
    status: "created",
    project: {
      id: project.id,
      name: project.name,
      kind: project.kind,
      root_path: project.root_path ?? null,
      icon: project.icon ?? null,
      cwd: null,
    },
    project_id: project.id,
    project_name: project.name,
    members_created: team.length,
    members_reused: 0,
    agents_created: agentsCreated,
    agents_skipped: landed.results.length - agentsCreated,
    automations_created: made.length,
    automation_errors: errors,
    members: team,
    automations: made,
    connectors_to_configure: landed.connectorsToConfigure,
  };
}
