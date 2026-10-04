/**
 * Agent packs: a few library agents as one file to hand to someone else —
 * their definitions and the skills they carry. No model channel travels with
 * them (an imported agent runs on the importer's defaults), and no secret: a
 * connector an agent uses is named, for the importer to set up themselves.
 */
import type { Schema } from "@agent-base/contract";
import type { SkillFile } from "@agent-base/db";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest } from "../../infra/errors.ts";
import * as agents from "../agents/service.ts";
import * as connectors from "../connectors/service.ts";
import * as skills from "../skills/service.ts";
import { ensure, held, modelDefaults } from "./service.ts";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface Manifest {
  schema_version: 1;
  kind: "agent-pack";
  collection?: { id: string; name: string; description: string; scenario: string; icon: string } | null;
  agents: {
    slug: string;
    name: string;
    description: string;
    instructions: string;
    avatar: string | null;
    runtime: string;
    model_hint: string | null;
    effort: Effort | null;
    skills: string[];
    connectors: string[];
  }[];
  skills: { slug: string; source: "embedded"; name: string; description: string }[];
  connectors: { slug: string; display_name: string }[];
}

/** A pack as it waits between preview and confirm. */
interface Staged {
  manifest: Manifest;
  skillFiles: Record<string, SkillFile[]>;
}

const MANIFEST = "manifest.json";
const STAGE_SECONDS = 15 * 60;
const stageKey = (auth: Auth, id: string): string => `agent-pack:${auth.orgId}:${auth.userId}:${id}`;

export async function exportPack(
  ctx: Ctx,
  auth: Auth,
  input: Schema<"ExportPackRequest">,
): Promise<{ bytes: Buffer; filename: string }> {
  if (input.agent_slugs.length === 0) throw badRequest("choose at least one agent to export");
  const chosen = await Promise.all([...new Set(input.agent_slugs)].map((slug) => agents.get(ctx, auth, slug)));
  const known = new Map((await connectors.list(ctx, auth)).map((connector) => [connector.slug, connector]));
  const files: Record<string, Uint8Array> = {};
  const packed = new Map<string, Manifest["skills"][number]>();
  for (const slug of new Set(chosen.flatMap((agent) => agent.skills))) {
    // A skill the exporter can no longer see is simply not carried.
    const skill = await skills.packageOf(ctx, auth, slug).catch(() => null);
    if (!skill) continue;
    packed.set(slug, { slug, source: "embedded", name: skill.name, description: skill.description });
    for (const file of skill.files) files[`skills/${slug}/${file.path}`] = strToU8(file.content);
  }
  const collection = input.collection?.name
    ? {
        id: chosen[0]?.slug ?? "pack",
        name: input.collection.name,
        description: input.collection.description ?? "",
        scenario: input.collection.scenario ?? "",
        icon: input.collection.icon ?? "bot",
      }
    : null;
  const manifest: Manifest = {
    schema_version: 1,
    kind: "agent-pack",
    collection,
    agents: chosen.map((agent) => ({
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      avatar: agent.avatar ?? null,
      runtime: agent.runtime,
      // Which model it was built for is a hint; the channel itself stays behind.
      model_hint: agent.model || null,
      effort: (agent.effort as Effort | null | undefined) ?? null,
      skills: agent.skills.filter((slug) => packed.has(slug)),
      connectors: agent.connector_types,
    })),
    skills: [...packed.values()],
    connectors: [...new Set(chosen.flatMap((agent) => agent.connector_types))].map((slug) => ({
      slug,
      display_name: known.get(slug)?.display_name ?? slug,
    })),
  };
  files[MANIFEST] = strToU8(JSON.stringify(manifest, null, 2));
  return { bytes: Buffer.from(zipSync(files)), filename: `${collection?.id ?? chosen[0]?.slug ?? "agents"}.valuzpack` };
}

function read(bytes: Buffer): Staged {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch {
    throw badRequest("that file is not an agent pack (it is not a zip archive)", "invalid_pack");
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(entries[MANIFEST] ?? new Uint8Array())) as Manifest;
  } catch {
    throw badRequest("that file is not an agent pack (no readable manifest)", "invalid_pack");
  }
  if (manifest.kind !== "agent-pack" || !Array.isArray(manifest.agents) || manifest.agents.length === 0)
    throw badRequest("that file is not an agent pack", "invalid_pack");
  const skillFiles: Record<string, SkillFile[]> = {};
  for (const skill of manifest.skills ?? []) {
    const prefix = `skills/${skill.slug}/`;
    skillFiles[skill.slug] = Object.entries(entries)
      .filter(([name, data]) => name.startsWith(prefix) && !name.endsWith("/") && data.length > 0)
      .map(([name, data]) => ({ path: name.slice(prefix.length), content: strFromU8(data) }));
  }
  return { manifest, skillFiles };
}

/** Read an uploaded pack and say what importing it would do. Nothing is changed yet. */
export async function preview(ctx: Ctx, auth: Auth, bytes: Buffer): Promise<Schema<"ImportPackPreviewResponse">> {
  const staged = read(bytes);
  const id = crypto.randomUUID();
  await ctx.redis.set(stageKey(auth, id), JSON.stringify(staged), "EX", STAGE_SECONDS);
  const present = new Set((await connectors.list(ctx, auth)).map((connector) => connector.slug));
  return {
    preview_id: id,
    collection: staged.manifest.collection ?? null,
    agents: await Promise.all(
      staged.manifest.agents.map(async (agent) => ({
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        in_library: (await held(ctx, auth, agent.slug)) !== null,
      })),
    ),
    skills: (staged.manifest.skills ?? []).map((skill) => ({ slug: skill.slug, source: "embedded" as const })),
    connectors: (staged.manifest.connectors ?? []).map((connector) => ({
      slug: connector.slug,
      display_name: connector.display_name,
      requires_credentials: !present.has(connector.slug),
      requires_setup: !present.has(connector.slug),
      already_present: present.has(connector.slug),
    })),
  };
}

/** Carry out a previewed import: the skills first, then the agents that carry them. */
export async function confirm(ctx: Ctx, auth: Auth, previewId: string): Promise<Schema<"ImportPackConfirmResponse">> {
  // Taken, not read: a preview is confirmed once.
  const raw = await ctx.redis.getdel(stageKey(auth, previewId));
  if (!raw)
    throw badRequest("this import preview has expired or was already used; upload the pack again", "preview_expired");
  const { manifest, skillFiles } = JSON.parse(raw) as Staged;
  await modelDefaults(ctx, auth);

  // An agent already in the library keeps what it has; only new agents bring their skills in.
  const incoming: string[] = [];
  for (const agent of manifest.agents) if (!(await held(ctx, auth, agent.slug))) incoming.push(agent.slug);
  const needed = new Set(manifest.agents.filter((agent) => incoming.includes(agent.slug)).flatMap((a) => a.skills));
  const renamed = new Map<string, string>();
  for (const skill of manifest.skills ?? []) {
    if (!needed.has(skill.slug)) continue;
    const created = await skills.createFromPackage(ctx, auth, {
      name: skill.name,
      description: skill.description,
      files: skillFiles[skill.slug] ?? [],
    });
    renamed.set(skill.slug, created.slug);
  }

  const results = [];
  for (const agent of manifest.agents)
    results.push(
      await ensure(ctx, auth, {
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        avatar: agent.avatar ?? "bot",
        effort: agent.effort,
        skills: agent.skills.flatMap((slug) => renamed.get(slug) ?? []),
      }),
    );
  const present = new Set((await connectors.list(ctx, auth)).map((connector) => connector.slug));
  const created = results.filter((result) => result.created).length;
  return {
    created,
    skipped: results.length - created,
    roles: results.map((result) => result.agent),
    connectors_to_configure: (manifest.connectors ?? [])
      .filter((connector) => !present.has(connector.slug))
      .map((connector) => ({ ...connector, requires_credentials: true, requires_setup: true })),
  };
}
