/**
 * The marketplace: what the market index offers, seen against the member's own
 * library, and installed into it. Browsing is the index's answer with
 * `installed` worked out here; installing uses the same doors as doing it by
 * hand — a skill package into the skill library, a role into the agent library.
 *
 * Connectors are not installed here: the app reads an item's `connector_config`
 * and creates the connector itself; nor are automation templates, which the app
 * opens in its automation builder. Plugin bundles are not provided at all.
 */
import type { Schema } from "@agent-base/contract";
import type { SkillFile } from "@agent-base/db";
import { strFromU8, unzipSync } from "fflate";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, notFound } from "../../infra/errors.ts";
import * as agents from "../agents/service.ts";
import * as connectors from "../connectors/service.ts";
import * as settings from "../settings/service.ts";
import * as skills from "../skills/service.ts";
import * as templates from "../templates/service.ts";
import * as index from "./index-client.ts";

type Item = Schema<"MarketplaceItem">;
type Detail = Schema<"MarketplaceItemDetail">;
type Result = Schema<"MarketplaceInstallResult">;
type Locale = "zh-CN" | "en-US";
type Localized = Partial<Record<Locale, string>> | string | null | undefined;

const MAX_SKILL_FILES = 200;
const MAX_SKILL_FILE_BYTES = 1_000_000;

const localeOf = async (ctx: Ctx, auth: Auth): Promise<Locale> =>
  (await settings.getPreferences(ctx.db, { orgId: auth.orgId, userId: auth.userId })).default_locale === "en-US"
    ? "en-US"
    : "zh-CN";

const pick = (value: Localized, locale: Locale): string =>
  typeof value === "string" ? value : (value?.[locale] ?? value?.["zh-CN"] ?? value?.["en-US"] ?? "");

const unavailable = (err: unknown): HttpError =>
  new HttpError(502, "marketplace_unavailable", `the marketplace cannot be reached: ${(err as Error).message}`);

// ------------------------------------------------------------------ browsing

/** What the member already has, by the slug a market item would be installed under. */
async function library(ctx: Ctx, auth: Auth) {
  const [mySkills, myConnectors, myAgents] = await Promise.all([
    skills.list(ctx, auth),
    connectors.list(ctx, auth),
    agents.list(ctx, auth),
  ]);
  return {
    skill: new Set(mySkills.map((skill) => skill.slug)),
    connector: new Set(myConnectors.map((connector) => connector.slug)),
    agent: new Set(myAgents.map((agent) => agent.slug)),
  };
}
type Library = Awaited<ReturnType<typeof library>>;

const refOf = (item: { id: string }): string => item.id.split(":").slice(2).join(":");

function installedIn(have: Library, item: Item): boolean {
  if (item.type === "skill") return have.skill.has(refOf(item));
  if (item.type === "connector") return have.connector.has(refOf(item));
  if (item.type === "agent_template") return have.agent.has(refOf(item));
  if (item.type === "agent_team_template")
    return (item.members ?? []).length > 0 && (item.members ?? []).every((member) => have.agent.has(member.slug ?? ""));
  return false;
}

export async function categories(ctx: Ctx, auth: Auth, kind: string): Promise<Schema<"MarketplaceCategoryList">> {
  const empty = { categories: [], degraded: !index.configured(ctx) };
  // Plugin bundles and playbooks are not provided here.
  if (!index.configured(ctx) || !["skill", "agent", "connector", "automation"].includes(kind)) return empty;
  try {
    const answer = (await index.categories(ctx, kind, await localeOf(ctx, auth))) as Partial<typeof empty> | null;
    return { categories: answer?.categories ?? [], degraded: answer?.degraded ?? false };
  } catch {
    // An index that is down must not blank the page with an error.
    return { categories: [], degraded: true };
  }
}

export async function items(
  ctx: Ctx,
  auth: Auth,
  query: Record<string, string | number | undefined>,
): Promise<Schema<"MarketplaceItemList">> {
  const page = Number(query["page"] ?? 1);
  const page_size = Number(query["page_size"] ?? 30);
  const none = (degraded: boolean) => ({ items: [], total: 0, page, page_size, degraded });
  const type = String(query["type"] ?? "");
  // An automation template is not installed: the app opens its builder filled in from the item.
  if (!["skill", "connector", "agent_template", "agent_team_template", "automation_template"].includes(type))
    return none(false);
  if (!index.configured(ctx)) return none(true);
  const params: Record<string, string> = { locale: await localeOf(ctx, auth) };
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") params[key] = String(value);
  try {
    const [listing, have] = await Promise.all([index.items(ctx, params), library(ctx, auth)]);
    const list = { ...none(false), ...(listing as Partial<Schema<"MarketplaceItemList">> | null) };
    return { ...list, items: list.items.map((item) => ({ ...item, installed: installedIn(have, item) })) };
  } catch {
    return none(true);
  }
}

async function detailOf(ctx: Ctx, auth: Auth, itemId: string): Promise<Detail> {
  if (!index.configured(ctx)) throw notFound("marketplace item");
  let found: unknown;
  try {
    found = await index.detail(ctx, itemId, await localeOf(ctx, auth));
  } catch (err) {
    throw unavailable(err);
  }
  if (!found) throw notFound("marketplace item");
  return found as Detail;
}

export async function item(ctx: Ctx, auth: Auth, itemId: string): Promise<Detail> {
  const [found, have] = await Promise.all([detailOf(ctx, auth, itemId), library(ctx, auth)]);
  return { ...found, installed: installedIn(have, found) };
}

// ------------------------------------------------------------------ installing

/** The files of a skill package: text only, and from inside its one top folder if it has one. */
function unpack(zip: Uint8Array): SkillFile[] {
  const entries = Object.entries(unzipSync(zip)).filter(
    ([path, bytes]) => !path.endsWith("/") && !path.startsWith("__MACOSX/") && bytes.byteLength <= MAX_SKILL_FILE_BYTES,
  );
  const manifest = entries.map(([path]) => path).find((path) => /(^|\/)SKILL\.md$/.test(path));
  if (!manifest) throw new HttpError(422, "not_a_skill", "the package holds no SKILL.md");
  const root = manifest.slice(0, manifest.length - "SKILL.md".length);
  return entries
    .filter(([path, bytes]) => path.startsWith(root) && !bytes.includes(0)) // a NUL byte: not text
    .slice(0, MAX_SKILL_FILES)
    .map(([path, bytes]) => ({ path: path.slice(root.length), content: strFromU8(bytes) }));
}

/** Put a market skill in the member's library under its market slug. False when it is already there. */
async function installSkill(ctx: Ctx, auth: Auth, slug: string, downloadUrl: string, sha256?: string) {
  if ((await skills.list(ctx, auth)).some((skill) => skill.slug === slug)) return false;
  let zip: Uint8Array;
  try {
    zip = await index.download(downloadUrl, sha256);
  } catch (err) {
    throw unavailable(err);
  }
  await skills.installPackage(ctx, auth, slug, unpack(zip));
  return true;
}

/** The skills a role names, fetched from the market where the member lacks them. One that cannot be had is left out. */
async function skillsFor(ctx: Ctx, auth: Auth, slugs: string[], urls: Map<string, string>): Promise<string[]> {
  const held: string[] = [];
  for (const slug of slugs) {
    try {
      const url =
        urls.get(slug) ??
        ((await detailOf(ctx, auth, `market:skill:${slug}`)).install_manifest as { download_url?: string } | null)
          ?.download_url;
      if (url) await installSkill(ctx, auth, slug, url);
      if ((await skills.list(ctx, auth)).some((skill) => skill.slug === slug)) held.push(slug);
    } catch (err) {
      ctx.log(err, `marketplace: skill ${slug} could not be installed`);
    }
  }
  return held;
}

interface RoleManifest {
  slug: string;
  name: Localized;
  role?: Localized;
  description?: Localized;
  instructions: Localized;
  icon?: string | null;
  avatar?: string | null;
  effort?: string | null;
  skills?: (string | { slug?: string })[];
}

async function installRole(ctx: Ctx, auth: Auth, role: RoleManifest, urls: Map<string, string>) {
  const locale = await localeOf(ctx, auth);
  if (await templates.held(ctx, auth, role.slug)) return { slug: role.slug, created: false };
  // Before anything is downloaded: an agent needs something to run on.
  await templates.modelDefaults(ctx, auth);
  const wanted = (role.skills ?? []).flatMap((skill) =>
    typeof skill === "string" ? [skill] : skill.slug ? [skill.slug] : [],
  );
  const { agent, created } = await templates.ensure(ctx, auth, {
    slug: role.slug,
    name: pick(role.name, locale),
    description: pick(role.description ?? role.role, locale),
    instructions: pick(role.instructions, locale),
    avatar: role.avatar ?? role.icon ?? "bot",
    effort: (role.effort ?? "high") as "high",
    skills: await skillsFor(ctx, auth, wanted, urls),
  });
  return { slug: agent.slug, created };
}

export async function install(ctx: Ctx, auth: Auth, itemId: string): Promise<Result> {
  const found = await detailOf(ctx, auth, itemId);
  const manifest = (found.install_manifest ?? {}) as Record<string, unknown>;
  const done = (installed: boolean, ref: string, extra: Partial<Result> = {}): Result => ({
    item_id: itemId,
    status: installed ? "installed" : "already_installed",
    installed_ref: ref,
    created: null,
    skipped: null,
    ...extra,
  });

  if (found.type === "skill") {
    const url = manifest["download_url"];
    if (typeof url !== "string") throw new HttpError(422, "not_installable", "this skill has no package to download");
    const sha = typeof manifest["sha256"] === "string" ? manifest["sha256"] : undefined;
    return done(await installSkill(ctx, auth, refOf(found), url, sha), refOf(found));
  }
  if (found.type === "agent_template") {
    const role = await installRole(ctx, auth, manifest as unknown as RoleManifest, new Map());
    return done(role.created, role.slug);
  }
  if (found.type === "agent_team_template") {
    const pack = manifest as { agents?: RoleManifest[]; skills?: { slug?: string; download_url?: string }[] };
    const urls = new Map(
      (pack.skills ?? []).flatMap((skill) =>
        skill.slug && skill.download_url ? [[skill.slug, skill.download_url]] : [],
      ) as [string, string][],
    );
    let created = 0;
    for (const role of pack.agents ?? []) if ((await installRole(ctx, auth, role, urls)).created) created++;
    return done(created > 0, refOf(found), { created, skipped: (pack.agents ?? []).length - created });
  }
  throw new HttpError(422, "not_installable", "this kind of item is not installed from here");
}
