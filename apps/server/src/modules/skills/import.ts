/**
 * Bringing a skill in from outside: a zip a member uploads, or a link — a
 * GitHub repository or folder, an archive, a single SKILL.md. A source may hold
 * one skill or many (a collection: `skills/<name>/SKILL.md` …), so importing is
 * two steps: a preview that lists every skill found and waits a quarter of an
 * hour, and a confirm per skill the member picks.
 *
 * A link is an address a member typed: it is fetched through the outbound
 * check, redirects followed one checked hop at a time.
 */
import type { Schema } from "@agent-base/contract";
import type { SkillFile } from "@agent-base/db";
import { strFromU8, unzipSync } from "fflate";
import matter from "gray-matter";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, badRequest, notFound } from "../../infra/errors.ts";
import { BlockedAddressError, assertOutboundAllowed } from "../../infra/outbound.ts";
import { deriveSlug } from "../agents/slug.ts";
import * as skills from "./service.ts";

type Preview = Schema<"SkillImportArchivePreview">;

const MANIFEST = "SKILL.md";
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 200;
const MAX_CANDIDATES = 50;
const PREVIEW_SECONDS = 900;
const previewKey = (auth: Auth, id: string): string => `skill-import:${auth.orgId}:${auth.userId}:${id}`;

const failed = (message: string): HttpError => new HttpError(422, "import_failed", message);

interface Candidate {
  name: string;
  description: string;
  /** Where in the source it was found, for display. */
  relpath: string;
  files: SkillFile[];
  warnings: string[];
}

/** What a source holds: its text files, and the paths of what was left out. */
interface Source {
  files: SkillFile[];
  /** Not text, or too large to be a skill's file. */
  skipped: string[];
}

/** The text files of a zip, by path. What is not text, or too large to be a skill's file, is named and left out. */
export function filesOfZip(zip: Uint8Array): Source {
  let entries: [string, Uint8Array][];
  try {
    entries = Object.entries(unzipSync(zip));
  } catch {
    throw failed("that is not a zip archive");
  }
  const files: SkillFile[] = [];
  const skipped: string[] = [];
  for (const [path, bytes] of entries) {
    if (path.endsWith("/") || path.startsWith("__MACOSX/") || path.split("/").some((part) => part === "..")) continue;
    // A NUL byte: not text. Skills are text; a binary asset is left behind and said so.
    if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) skipped.push(path);
    else files.push({ path, content: strFromU8(bytes) });
  }
  return { files, skipped };
}

/** Every skill in a set of files: each folder holding a SKILL.md, with what is under it. */
export function skillsIn({ files, skipped }: Source): Candidate[] {
  const roots = files
    .filter((file) => file.path === MANIFEST || file.path.endsWith(`/${MANIFEST}`))
    .map((file) => file.path.slice(0, file.path.length - MANIFEST.length))
    // A skill inside a skill belongs to the outer one.
    .sort((a, b) => a.length - b.length);
  const outer = roots.filter((root, index) => !roots.slice(0, index).some((other) => root.startsWith(other)));
  return outer.slice(0, MAX_CANDIDATES).map((root) => {
    const own = files.filter((file) => file.path.startsWith(root));
    const kept = own.slice(0, MAX_FILES).map((file) => ({ path: file.path.slice(root.length), content: file.content }));
    const manifest = matter(kept.find((file) => file.path === MANIFEST)?.content ?? "").data as {
      name?: unknown;
      description?: unknown;
    };
    const folder = root.replace(/\/$/, "").split("/").pop() ?? "";
    const warnings: string[] = [];
    if (typeof manifest.name !== "string" || !manifest.name.trim())
      warnings.push("SKILL.md declares no `name`; the folder's name is used");
    if (typeof manifest.description !== "string" || !manifest.description.trim())
      warnings.push("SKILL.md declares no `description`, which is how an agent decides when to use the skill");
    if (own.length > MAX_FILES) warnings.push(`only the first ${MAX_FILES} files are imported`);
    // Only what was left out of this skill is its business.
    const left = skipped.filter((path) => path.startsWith(root)).length;
    if (left > 0) warnings.push(`${left} file(s) that are not text, or are over 1 MB, are left out`);
    return {
      name: (typeof manifest.name === "string" && manifest.name.trim()) || folder || "imported-skill",
      description: typeof manifest.description === "string" ? manifest.description.trim() : "",
      relpath: root.replace(/\/$/, ""),
      files: kept,
      warnings,
    };
  });
}

// ------------------------------------------------------------------ fetching a link

async function download(ctx: Ctx, url: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  let next = url;
  for (let hop = 0; hop < 5; hop++) {
    try {
      await assertOutboundAllowed(ctx.config, next);
    } catch (err) {
      if (err instanceof BlockedAddressError) throw badRequest(err.message, "blocked_address");
      throw err;
    }
    let res: Response;
    try {
      res = await fetch(next, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw failed(`could not fetch ${new URL(next).host}: ${(err as Error).message}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      next = new URL(location, next).toString();
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw failed(`${new URL(next).host} answered ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES)
      throw failed("that download is over 20 MB");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw failed("that download is over 20 MB");
    return { bytes, type: res.headers.get("content-type") ?? "" };
  }
  throw failed("too many redirects");
}

/**
 * A GitHub address as the repository's archive and the folder inside it:
 * `github.com/owner/repo`, `…/tree/<ref>/<dir>`, `…/blob/<ref>/<dir>/SKILL.md`.
 * A ref may itself contain slashes, so the candidates are tried from the
 * shortest ref up; with none named, the usual default branches.
 */
export function githubSources(url: URL): { archive: string; subdir: string }[] | null {
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
  const [owner, repoRaw, kind, ...rest] = url.pathname.split("/").filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  const archive = (ref: string) =>
    `https://codeload.github.com/${owner}/${repo}/zip/${ref.split("/").map(encodeURIComponent).join("/")}`;
  if ((kind !== "tree" && kind !== "blob") || rest.length === 0)
    return ["main", "master"].map((ref) => ({ archive: archive(ref), subdir: "" }));
  const parts = kind === "blob" && rest.at(-1) === MANIFEST ? rest.slice(0, -1) : rest;
  return parts.slice(0, 4).map((_, index) => ({
    archive: archive(parts.slice(0, index + 1).join("/")),
    subdir: parts.slice(index + 1).join("/"),
  }));
}

/** The files a link leads to. */
async function filesAt(ctx: Ctx, raw: string): Promise<Source> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest("that is not a link");
  }
  if (!/^https?:$/.test(url.protocol)) throw badRequest("a link starts with http:// or https://");
  const github = githubSources(url);
  if (github) {
    for (const source of github) {
      const got = await download(ctx, source.archive);
      if (!got) continue;
      const unpacked = filesOfZip(got.bytes);
      // GitHub wraps a repository's archive in one folder named after it.
      const top = `${unpacked.files[0]?.path.split("/")[0] ?? ""}/`;
      const prefix = top + (source.subdir ? `${source.subdir}/` : "");
      return {
        skipped: unpacked.skipped.filter((path) => path.startsWith(prefix)).map((path) => path.slice(top.length)),
        files: unpacked.files
          .filter((file) => file.path.startsWith(prefix))
          .map((file) => ({ ...file, path: file.path.slice(top.length) })),
      };
    }
    throw failed("that GitHub repository, branch or folder was not found (a private repository cannot be read)");
  }
  const got = await download(ctx, url.toString());
  if (!got) throw failed("nothing was found at that link");
  // A zip says so in its first bytes, whatever the server calls it.
  if (got.bytes[0] === 0x50 && got.bytes[1] === 0x4b) return filesOfZip(got.bytes);
  if (got.bytes.includes(0)) throw failed("that link is neither a zip archive nor a SKILL.md");
  return { files: [{ path: MANIFEST, content: strFromU8(got.bytes) }], skipped: [] };
}

// ------------------------------------------------------------------ preview and confirm

async function preview(ctx: Ctx, auth: Auth, source: Source): Promise<Preview> {
  const found = skillsIn(source);
  if (found.length === 0) throw failed("no SKILL.md was found in it");
  const taken = new Set((await skills.list(ctx, auth)).map((skill) => skill.slug));
  const kept = await Promise.all(
    found.map(async (candidate) => {
      const id = crypto.randomUUID();
      await ctx.redis.set(previewKey(auth, id), JSON.stringify(candidate), "EX", PREVIEW_SECONDS);
      return { id, candidate };
    }),
  );
  const first = kept[0] as (typeof kept)[number];
  const slug = deriveSlug(first.candidate.name).toLowerCase();
  const conflict = taken.has(slug);
  return {
    preview_id: first.id,
    name: first.candidate.name,
    description: first.candidate.description,
    tags: [],
    file_tree: skills.treeOf(first.candidate.files),
    validation_warnings: first.candidate.warnings,
    name_conflict: conflict,
    suggested_name: conflict ? `${first.candidate.name} (2)` : null,
    skills: kept.map(({ id, candidate }) => ({
      preview_id: id,
      name: candidate.name,
      description: candidate.description,
      file_count: candidate.files.length,
      relpath: candidate.relpath,
    })),
  };
}

export const previewArchive = (ctx: Ctx, auth: Auth, zip: Uint8Array): Promise<Preview> =>
  preview(ctx, auth, filesOfZip(zip));

export const previewUrl = async (ctx: Ctx, auth: Auth, url: string): Promise<Preview> =>
  preview(ctx, auth, await filesAt(ctx, url));

/** Take one previewed skill into the member's library, under the name they settled on. */
export async function confirm(
  ctx: Ctx,
  auth: Auth,
  input: { preview_id: string; name?: string | null },
): Promise<Schema<"SkillView">> {
  const key = previewKey(auth, input.preview_id);
  const raw = await ctx.redis.get(key);
  if (!raw) throw notFound("import preview (it is kept for fifteen minutes — preview the source again)");
  const candidate = JSON.parse(raw) as Candidate;
  const created = await skills.createFromPackage(ctx, auth, {
    name: input.name?.trim() || candidate.name,
    description: candidate.description,
    files: candidate.files,
  });
  await ctx.redis.del(key);
  return created;
}
