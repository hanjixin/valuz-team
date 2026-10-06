/**
 * The skill library. A skill is a package of files an agent's runtime can
 * discover — a `SKILL.md` saying what it is for and how to use it, plus
 * whatever it needs. It belongs to the member who made it, is shared through
 * the ladder, and keeps every version of its content.
 */
import { createHash } from "node:crypto";
import type { Schema } from "@agent-base/contract";
import type { SkillFile } from "@agent-base/db";
import matter from "gray-matter";
import type { Auth, Ctx } from "../../infra/context.ts";
import { redactSecrets, unsafeReason } from "../../infra/safety.ts";
import { badRequest, conflict, forbidden, notFound } from "../../infra/errors.ts";
import { deriveSlug, ensureUniqueSlug } from "../agents/slug.ts";
import * as audit from "../audit/service.ts";
import * as settings from "../settings/service.ts";
import * as sharing from "../sharing/service.ts";
import * as builtin from "./builtin.ts";
import * as repo from "./repo.ts";

sharing.registerShareable("skill", "skills");

const MANIFEST = "SKILL.md";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;

type View = Schema<"SkillView">;

/** A member's own switch for a skill in their library; everything is on until turned off. */
const switchedOff = async (ctx: Ctx, auth: Auth): Promise<Set<string>> =>
  new Set((await settings.get(ctx.db, auth, "skills", { disabled: [] as string[] })).disabled);

const hashOf = (files: SkillFile[]): string =>
  createHash("sha256")
    .update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))))
    .digest("hex");

const manifestOf = (files: SkillFile[]): string => files.find((file) => file.path === MANIFEST)?.content ?? "";

/** The instructions in SKILL.md, without its frontmatter. */
const instructionsOf = (files: SkillFile[]): string => matter(manifestOf(files)).content.replace(/^\n+/, "");

const writeManifest = (name: string, description: string, instructions: string): string =>
  matter.stringify(instructions.endsWith("\n") ? instructions : `${instructions}\n`, { name, description });

/** A built-in skill in the shape of a library row, so everything that reads one reads it the same way. */
const builtinRow = (skill: builtin.BuiltinSkill, auth: Auth): repo.SkillRow => ({
  id: skill.id,
  org_id: auth.orgId,
  owner_id: "",
  slug: skill.slug,
  name: skill.name,
  description: skill.description,
  files: skill.files,
  version: 1,
  creation_origin: "builtin",
  created_at: new Date(0),
  updated_at: new Date(0),
  permission: "view",
});
const isBuiltin = (row: { creation_origin: string }): boolean => row.creation_origin === "builtin";

function present(row: repo.SkillRow, auth: Auth, off: Set<string>): View {
  if (isBuiltin(row))
    return {
      ...present({ ...row, creation_origin: "imported" }, auth, off),
      scope: "official",
      source: "builtin",
      readonly: true,
      protected: true,
      origin_label: "builtin",
      creation_origin: "imported",
    };
  const permission = row.permission ?? "view";
  const mine = row.owner_id === auth.userId;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    scope: "user",
    source: mine ? "user" : "org",
    path: `skills/${row.slug}`,
    enabled: !off.has(row.slug),
    library_enabled: !off.has(row.slug),
    tags: [],
    status: "available",
    readonly: !sharing.permissionAtLeast(permission, "edit"),
    is_locked: false,
    protected: false,
    origin_label: mine ? null : "shared",
    content_hash: hashOf(row.files),
    version: row.version,
    folder_created_at: row.created_at.getTime(),
    creation_origin: row.creation_origin as View["creation_origin"],
  };
}

async function mustFind(ctx: Ctx, auth: Auth, key: string, needed: sharing.Permission = "view") {
  const shipped = builtin.find(key);
  if (shipped) {
    if (needed !== "view") throw forbidden("a built-in skill cannot be changed — take a copy and change that");
    return builtinRow(shipped, auth);
  }
  const row = await repo.find(ctx.db, auth, key, UUID.test(key));
  if (!row?.permission) throw notFound("skill");
  if (!sharing.permissionAtLeast(row.permission, needed))
    throw forbidden(`this needs "${needed}" permission on the skill`);
  return row;
}

/** A path inside the package: relative, no `..`, no empty segments. */
function safePath(path: string): string {
  const clean = path.trim().replace(/^\.\//, "");
  const parts = clean.split("/");
  if (!clean || clean.startsWith("/") || parts.some((part) => part === "" || part === "." || part === ".."))
    throw badRequest("a skill file path must stay inside the skill", "invalid_path");
  return clean;
}

function checkPackage(files: SkillFile[]): void {
  if (files.length > MAX_FILES) throw badRequest(`a skill holds at most ${MAX_FILES} files`);
  if (files.some((file) => Buffer.byteLength(file.content) > MAX_FILE_BYTES))
    throw badRequest("a skill file is at most 1 MB");
  if (!files.some((file) => file.path === MANIFEST)) throw badRequest(`a skill must keep its ${MANIFEST}`);
}

// -- Reading --

export async function list(ctx: Ctx, auth: Auth): Promise<View[]> {
  const [rows, off] = await Promise.all([repo.list(ctx.db, auth), switchedOff(ctx, auth)]);
  // The member's own first, then the ones every library starts with.
  return [...rows, ...builtin.BUILTIN.map((skill) => builtinRow(skill, auth))].map((row) => present(row, auth, off));
}

export async function get(ctx: Ctx, auth: Auth, key: string): Promise<Schema<"SkillDetail">> {
  const row = await mustFind(ctx, auth, key);
  return {
    ...present(row, auth, await switchedOff(ctx, auth)),
    instructions_markdown: instructionsOf(row.files),
    file_count: row.files.length,
    root_path: `skills/${row.slug}`,
    manifest_filename: MANIFEST,
    metadata: matter(manifestOf(row.files)).data,
    origin: null,
  };
}

const view = async (ctx: Ctx, auth: Auth, key: string): Promise<View> =>
  present(await mustFind(ctx, auth, key), auth, await switchedOff(ctx, auth));

// -- Writing --

async function createWith(ctx: Ctx, auth: Auth, content: repo.Content, origin: string): Promise<View> {
  checkPackage(content.files);
  const id = crypto.randomUUID();
  const slug = ensureUniqueSlug(
    deriveSlug(content.name).toLowerCase(),
    new Set([...(await repo.slugsInOrg(ctx.db, auth.orgId)), ...builtin.SLUGS]),
  );
  await repo.insert(ctx.db, {
    ...content,
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    slug,
    creation_origin: origin,
  });
  await audit.record(ctx.db, auth, "skill.create", { type: "skill", id }, { slug });
  return view(ctx, auth, id);
}

/** A skill as a package to carry elsewhere: its name, description and files. */
export async function packageOf(ctx: Ctx, auth: Auth, key: string): Promise<repo.Content & { slug: string }> {
  const row = await mustFind(ctx, auth, key);
  return { slug: row.slug, name: row.name, description: row.description, files: row.files };
}

/**
 * Add a skill that arrived as files under a slug it must keep (a market skill:
 * agents name it by that slug). Its name and description are its manifest's.
 */
export async function installPackage(ctx: Ctx, auth: Auth, slug: string, files: SkillFile[]): Promise<View> {
  checkPackage(files);
  const manifest = matter(manifestOf(files)).data as { name?: unknown; description?: unknown };
  const taken = new Set([...(await repo.slugsInOrg(ctx.db, auth.orgId)), ...builtin.SLUGS]);
  if (taken.has(slug)) throw conflict(`skill '${slug}' already exists`, "slug_taken");
  const id = crypto.randomUUID();
  await repo.insert(ctx.db, {
    name: String(manifest.name ?? slug),
    description: String(manifest.description ?? ""),
    files,
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    slug,
    creation_origin: "imported",
  });
  await audit.record(ctx.db, auth, "skill.create", { type: "skill", id }, { slug, from: "marketplace" });
  return view(ctx, auth, id);
}

/** Add a skill that arrived as a package (an imported agent pack). */
export const createFromPackage = (ctx: Ctx, auth: Auth, content: repo.Content): Promise<View> =>
  createWith(ctx, auth, content, "imported");

export function create(ctx: Ctx, auth: Auth, input: Schema<"SkillCreateRequest">): Promise<View> {
  const name = input.name.trim();
  if (!name) throw badRequest("a skill needs a name");
  const description = input.description ?? "";
  const instructions = input.instructions_markdown ?? `# ${name}\n\nDescribe when to use this skill and how.\n`;
  return createWith(
    ctx,
    auth,
    { name, description, files: [{ path: MANIFEST, content: writeManifest(name, description, instructions) }] },
    "created",
  );
}

// -- What an agent writes itself --

const LEARNING_KEY = "skill-learning";
export type LearningSettings = Schema<"SkillSettings">;

/** Whether this member's agents may write skills. On until they switch it off. */
export const learningSettings = (ctx: Ctx, member: { orgId: string; userId: string }): Promise<LearningSettings> =>
  settings.get(ctx.db, { orgId: member.orgId, userId: member.userId }, LEARNING_KEY, { auto_learn: true });

export async function patchLearningSettings(
  ctx: Ctx,
  member: { orgId: string; userId: string },
  patch: Partial<LearningSettings>,
): Promise<LearningSettings> {
  const next = { ...(await learningSettings(ctx, member)), ...patch };
  await settings.set(ctx.db, { orgId: member.orgId, userId: member.userId }, LEARNING_KEY, next);
  return next;
}

const MAX_LEARNED_CHARS = 20_000;

/**
 * Text a model wrote for a skill: a later model will follow it as instructions,
 * so it is held to what memory is — no instructions aimed at the reader, no
 * credentials — and to a size a person can still read.
 */
function learnedText(text: string, what: string): string {
  const clean = redactSecrets(text.trim());
  if (!clean) throw badRequest(`a skill's ${what} cannot be empty`);
  if (clean.length > MAX_LEARNED_CHARS)
    throw badRequest(`a skill's ${what} is at most ${MAX_LEARNED_CHARS} characters`);
  if (unsafeReason(clean)) throw badRequest(`the ${what} was blocked by the safety scan`, "unsafe_content");
  return clean;
}

/** A skill an agent wrote from what it worked out. It belongs to the member the agent was working for. */
export function learn(
  ctx: Ctx,
  auth: Auth,
  input: { name: string; description: string; instructions: string },
): Promise<View> {
  const name = learnedText(input.name, "name").slice(0, 80);
  const description = learnedText(input.description, "description").slice(0, 500);
  const instructions = learnedText(input.instructions, "instructions");
  return createWith(
    ctx,
    auth,
    { name, description, files: [{ path: MANIFEST, content: writeManifest(name, description, instructions) }] },
    "learned",
  );
}

/**
 * Correct a skill's instructions in one place: `oldText` → `newText`. Only a
 * skill the caller may edit — never a built-in one, never one merely shared for
 * use. A new version, so the correction can be looked at and undone.
 */
export async function amend(ctx: Ctx, auth: Auth, key: string, oldText: string, newText: string): Promise<View> {
  const row = await mustFind(ctx, auth, key, "edit");
  const instructions = instructionsOf(row.files);
  if (!oldText || instructions.split(oldText).length !== 2)
    throw badRequest("`old_text` must match exactly one place in the skill's instructions", "no_unique_match");
  const amended = learnedText(
    instructions.replace(oldText, () => newText),
    "instructions",
  );
  const manifest = writeManifest(row.name, row.description, amended);
  await save(ctx, auth, row, {
    name: row.name,
    description: row.description,
    files: row.files.map((file) => (file.path === MANIFEST ? { ...file, content: manifest } : file)),
  });
  return view(ctx, auth, row.id);
}

/** Add or replace one supporting file of a skill the caller may edit, held to the same checks. */
export async function attachFile(ctx: Ctx, auth: Auth, key: string, path: string, content: string): Promise<View> {
  if (path.trim().replace(/^\.\//, "") === MANIFEST)
    throw badRequest("change the instructions with `patch`, not by replacing SKILL.md");
  await changeFile(ctx, auth, key, { action: "create", path, content: learnedText(content, "file") });
  return view(ctx, auth, key);
}

/** The instructions of a skill the caller can see, for an agent deciding whether to correct it. */
export async function instructionsFor(ctx: Ctx, auth: Auth, key: string) {
  const row = await mustFind(ctx, auth, key);
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    editable: !isBuiltin(row) && sharing.permissionAtLeast(row.permission ?? "view", "edit"),
    instructions: instructionsOf(row.files),
  };
}

/** Store new content for a skill as its next version — unless nothing actually changed. */
async function save(ctx: Ctx, auth: Auth, row: repo.SkillRow, content: repo.Content): Promise<void> {
  checkPackage(content.files);
  const unchanged =
    content.name === row.name && content.description === row.description && hashOf(content.files) === hashOf(row.files);
  if (unchanged) return;
  const version = await repo.saveContent(ctx.db, row.id, content, auth.userId);
  await audit.record(ctx.db, auth, "skill.update", { type: "skill", id: row.id }, { version });
}

export async function update(ctx: Ctx, auth: Auth, key: string, input: Schema<"SkillUpdateRequest">): Promise<View> {
  const row = await mustFind(ctx, auth, key, "edit");
  const name = input.name?.trim() || row.name;
  const description = input.description ?? row.description;
  const instructions = input.instructions_markdown ?? instructionsOf(row.files);
  // The manifest's frontmatter follows the skill's name and description.
  const manifest = writeManifest(name, description, instructions);
  const files = row.files.map((file) => (file.path === MANIFEST ? { ...file, content: manifest } : file));
  await save(ctx, auth, row, { name, description, files });
  return view(ctx, auth, row.id);
}

/** Anyone who can see a skill can take a copy; the copy is theirs. */
export async function copy(ctx: Ctx, auth: Auth, key: string, newName: string): Promise<View> {
  const source = await mustFind(ctx, auth, key);
  const name = newName.trim();
  if (!name) throw badRequest("a skill needs a name");
  const manifest = writeManifest(name, source.description, instructionsOf(source.files));
  const files = source.files.map((file) => (file.path === MANIFEST ? { ...file, content: manifest } : file));
  return createWith(ctx, auth, { name, description: source.description, files }, "created");
}

export async function remove(ctx: Ctx, auth: Auth, key: string): Promise<void> {
  const row = await mustFind(ctx, auth, key, "admin");
  await ctx.db.transaction().execute(async (tx) => {
    await sharing.revokeForResource(tx, "skill", row.id);
    await repo.remove(tx, row.id);
    await audit.record(tx, auth, "skill.delete", { type: "skill", id: row.id }, { slug: row.slug });
  });
}

/** Turn a skill on or off in the caller's own library. Nobody else's is affected. */
export async function setLibraryState(ctx: Ctx, auth: Auth, key: string, enabled: boolean): Promise<View> {
  const row = await mustFind(ctx, auth, key);
  const off = await switchedOff(ctx, auth);
  if (enabled) off.delete(row.slug);
  else off.add(row.slug);
  await settings.set(ctx.db, auth, "skills", { disabled: [...off].sort() });
  return present(row, auth, off);
}

// -- Files --

type Node = Schema<"SkillFileNode">;

/** The package as a tree: directories first, then files, each level by name. */
function treeOf(files: SkillFile[]): Node[] {
  const root: Node[] = [];
  for (const file of files) {
    let level = root;
    const parts = file.path.split("/");
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/");
      const leaf = index === parts.length - 1;
      let node = level.find((candidate) => candidate.name === name);
      if (!node) {
        node = leaf
          ? { name, path, type: "file", size: Buffer.byteLength(file.content) }
          : { name, path, type: "directory", children: [] };
        level.push(node);
      }
      level = node.children ?? [];
    });
  }
  const sort = (nodes: Node[]): Node[] =>
    nodes
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
      .map((node) => (node.children ? { ...node, children: sort(node.children) } : node));
  return sort(root);
}

export const listFiles = async (ctx: Ctx, auth: Auth, key: string): Promise<Node[]> =>
  treeOf((await mustFind(ctx, auth, key)).files);

export async function readFile(ctx: Ctx, auth: Auth, key: string, path: string): Promise<Schema<"SkillFileContent">> {
  const row = await mustFind(ctx, auth, key);
  const file = row.files.find((candidate) => candidate.path === path);
  if (!file) throw notFound("skill file");
  return { path: file.path, content: file.content, encoding: "utf-8" };
}

/** Create or overwrite, rename, or delete one file. Each change is a new version of the skill. */
export async function changeFile(
  ctx: Ctx,
  auth: Auth,
  key: string,
  input: Schema<"SkillFileAction">,
): Promise<Schema<"SkillFileContent">> {
  const row = await mustFind(ctx, auth, key, "edit");
  const path = safePath(input.path);
  const existing = row.files.find((file) => file.path === path);
  let files: SkillFile[];
  let result: SkillFile;
  if (input.action === "create") {
    result = { path, content: input.content ?? "" };
    files = existing ? row.files.map((file) => (file.path === path ? result : file)) : [...row.files, result];
  } else if (!existing) {
    throw notFound("skill file");
  } else if (input.action === "delete") {
    if (path === MANIFEST) throw badRequest(`a skill must keep its ${MANIFEST}`);
    files = row.files.filter((file) => file.path !== path);
    result = { path, content: "" };
  } else {
    const target = safePath(input.new_path ?? "");
    if (path === MANIFEST) throw badRequest(`${MANIFEST} cannot be renamed`);
    if (row.files.some((file) => file.path === target)) throw conflict("a file with that name already exists");
    result = { path: target, content: existing.content };
    files = row.files.map((file) => (file.path === path ? result : file));
  }
  // Editing SKILL.md by hand may change the name and description it declares.
  const declared = matter(manifestOf(files)).data as { name?: unknown; description?: unknown };
  await save(ctx, auth, row, {
    name: typeof declared.name === "string" && declared.name.trim() ? declared.name.trim() : row.name,
    description: typeof declared.description === "string" ? declared.description : row.description,
    files,
  });
  return { path: result.path, content: result.content, encoding: "utf-8" };
}

// -- Versions --

type VersionRow = Awaited<ReturnType<typeof repo.listVersions>>[number];

const presentVersion = (row: VersionRow, current: number): Schema<"SkillVersionItem"> => ({
  revision_id: row.id,
  version_no: row.version,
  created_at: row.created_at.getTime(),
  source_session_id: null,
  created_by: row.created_by,
  byte_size: row.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
  content_hash: hashOf(row.files),
  is_current: row.version === current,
});

export async function listVersions(ctx: Ctx, auth: Auth, key: string): Promise<Schema<"SkillVersionListResponse">> {
  const row = await mustFind(ctx, auth, key);
  // A built-in skill has the one version the server ships.
  const versions = isBuiltin(row) ? [] : await repo.listVersions(ctx.db, row.id);
  return { skill_id: row.id, artifact_id: null, items: versions.map((v) => presentVersion(v, row.version)) };
}

async function mustFindVersion(ctx: Ctx, auth: Auth, key: string, revisionId: string, needed?: sharing.Permission) {
  const skill = await mustFind(ctx, auth, key, needed);
  const version = UUID.test(revisionId) ? await repo.findVersion(ctx.db, skill.id, revisionId) : undefined;
  if (!version) throw notFound("skill version");
  return { skill, version };
}

export async function getVersion(ctx: Ctx, auth: Auth, key: string, revisionId: string) {
  const { skill, version } = await mustFindVersion(ctx, auth, key, revisionId);
  return {
    ...presentVersion(version, skill.version),
    files: version.files.map((file) => ({ path: file.path, size: Buffer.byteLength(file.content) })),
  };
}

export async function readVersionFile(ctx: Ctx, auth: Auth, key: string, revisionId: string, path: string) {
  const { version } = await mustFindVersion(ctx, auth, key, revisionId);
  const file = version.files.find((candidate) => candidate.path === path);
  if (!file) throw notFound("skill file");
  return { revision_id: version.id, path: file.path, content: file.content, size: Buffer.byteLength(file.content) };
}

/** Bring back an earlier version — as a new version, so nothing in between is lost. */
export async function restoreVersion(ctx: Ctx, auth: Auth, key: string, revisionId: string) {
  const { skill, version } = await mustFindVersion(ctx, auth, key, revisionId, "edit");
  if (version.version === skill.version) throw badRequest("that is already the current version");
  await save(ctx, auth, skill, { name: version.name, description: version.description, files: version.files });
  const restored = await view(ctx, auth, skill.id);
  const [latest] = await repo.listVersions(ctx.db, skill.id);
  return { skill: restored, revision_id: latest?.id ?? version.id, version_no: restored.version ?? skill.version };
}

// -- For a turn --

/**
 * The packages an agent's skills resolve to, for the device to materialize.
 * A slug that names no skill any more is simply left out.
 */
export const bundlesFor = async (ctx: Ctx, orgId: string, slugs: string[]) =>
  [
    ...builtin.BUILTIN.filter((skill) => slugs.includes(skill.slug)).map((skill) => ({ ...skill, version: 1 })),
    ...(await repo.bundlesBySlug(
      ctx.db,
      orgId,
      slugs.filter((slug) => !builtin.SLUGS.has(slug)),
    )),
  ].map((skill) => ({ slug: skill.slug, version: skill.version, files: skill.files }));
