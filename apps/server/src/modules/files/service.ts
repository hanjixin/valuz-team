/**
 * Files. Two kinds, kept apart on purpose:
 *
 *   - what a member attaches to a message — held in the server's storage only
 *     until the message is sent, then written into the session's workspace on
 *     the device (where the agent reads) and dropped from the server;
 *   - what is on a device — a project's folder, a session's workspace. The
 *     server holds none of it: it asks the device, on the caller's behalf, and
 *     the device applies its owner's sharing policy.
 */
import path from "node:path";
import type { Schema } from "@agent-base/contract";
import type { Attachment, FsTreeNode } from "@agent-base/protocol";
import { managedCwd } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import mime from "mime";
import type { Auth, Ctx } from "../../infra/context.ts";
import { DeviceOfflineError } from "../../infra/device-hub.ts";
import { HttpError, badRequest, notFound } from "../../infra/errors.ts";
import * as knowledge from "../knowledge/service.ts";
import * as devices from "../devices/service.ts";
import * as projects from "../projects/service.ts";
import * as sharing from "../sharing/service.ts";
import * as artifacts from "./artifacts.ts";
import * as repo from "./repo.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_REF = /^valuz-file:\/{2,3}/;
const FILE_TOKEN_TTL_S = 10 * 60;

type Item = Schema<"SessionAttachmentItem">;
const actorOf = (auth: Auth) => ({ user_id: auth.userId, name: auth.name });

/** A file name safe to use as a single path segment on any device. */
const safeName = (name: string): string =>
  path
    .basename(name.replaceAll("\\", "/"))
    .replace(/[^\w.\-一-鿿 ]+/g, "_")
    .slice(0, 120) || "file";

const present = (row: repo.AttachmentRow): Item => ({
  id: row.id,
  session_id: row.session_id,
  file_name: row.file_name,
  ref: row.device_path ? `valuz-file://${row.device_path}` : "",
  parsed_ref: null,
  parse_status: row.kb_document_id ? "ready" : "skipped",
  size_bytes: row.size_bytes,
  mime_type: row.mime_type,
  created_at: row.created_at.getTime(),
  source_kind: row.kb_document_id ? "kb_doc" : "local",
  consumed_at: row.consumed_at?.getTime() ?? null,
});

// -- Attachments --

export async function upload(
  ctx: Ctx,
  auth: Auth,
  file: { name: string; bytes: Buffer; mimeType?: string },
): Promise<Item> {
  if (file.bytes.length === 0) throw badRequest("the file is empty");
  const id = crypto.randomUUID();
  const storageKey = `attachments/${auth.orgId}/${id}`;
  // A browser that does not know the type says "octet-stream"; the name often says more.
  const declared = file.mimeType && file.mimeType !== "application/octet-stream" ? file.mimeType : null;
  const mimeType = declared ?? mime.getType(file.name) ?? file.mimeType ?? null;
  await ctx.storage.put(storageKey, file.bytes, mimeType);
  const row = await repo.insert(ctx.db, {
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    file_name: safeName(file.name),
    size_bytes: file.bytes.length,
    mime_type: mimeType,
    storage_key: storageKey,
  });
  return present(row);
}

/**
 * Stage knowledge-base documents for the caller's next message. A reference,
 * not a copy: the document's text is fetched when the message is sent.
 */
export async function attachDocuments(ctx: Ctx, auth: Auth, documentIds: string[]): Promise<Item[]> {
  const staged = new Set((await repo.listStaged(ctx.db, auth)).map((row) => row.kb_document_id));
  const added: Item[] = [];
  for (const documentId of new Set(documentIds)) {
    const doc = await knowledge.textOf(ctx, auth.orgId, documentId).catch(() => {
      throw badRequest(`knowledge-base document "${documentId}" is not available`, "document_unavailable");
    });
    if (staged.has(doc.id)) continue;
    const row = await repo.insert(ctx.db, {
      id: crypto.randomUUID(),
      org_id: auth.orgId,
      owner_id: auth.userId,
      file_name: safeName(doc.filename),
      size_bytes: Buffer.byteLength(doc.text),
      mime_type: doc.mimeType,
      storage_key: null,
      kb_document_id: doc.id,
    });
    added.push(present(row));
  }
  return added;
}

export const listStaged = async (ctx: Ctx, auth: Auth): Promise<Item[]> =>
  (await repo.listStaged(ctx.db, auth)).map(present);

export const listForSession = async (ctx: Ctx, sessionId: string): Promise<Item[]> =>
  (await repo.listForSession(ctx.db, sessionId)).map(present);

export async function discard(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  const removed = UUID.test(id) ? await repo.remove(ctx.db, auth, id) : undefined;
  if (!removed) throw notFound("attachment");
  if (removed.storage_key)
    await ctx.storage
      .remove(removed.storage_key)
      .catch((err: unknown) => ctx.log(err, "could not remove a stored file"));
}

/**
 * Put the attachments a message claims into the session's workspace on its
 * device, and say where each landed. Only the sender's own staged uploads can
 * be claimed; once delivered they belong to the session.
 */
export async function deliver(
  ctx: Ctx,
  auth: Auth,
  session: { id: string; device_id: string | null; cwd: string },
  ids: string[],
): Promise<Attachment[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  if (!wanted.every((id) => UUID.test(id))) throw notFound("attachment");
  const rows = await repo.stagedByIds(ctx.db, auth, wanted);
  if (rows.length !== wanted.length) throw notFound("attachment");
  if (!session.device_id) throw new HttpError(409, "device_removed", "the device this session ran on was removed");

  const delivered: Attachment[] = [];
  for (const row of rows) {
    // An upload is delivered as it is; a knowledge-base document as the text parsed from it,
    // which an agent can read whatever the original's format.
    const document = row.kb_document_id ? await knowledge.textOf(ctx, auth.orgId, row.kb_document_id) : null;
    const bytes = document ? Buffer.from(document.text, "utf8") : await ctx.storage.get(row.storage_key ?? "");
    const name = document && !/\.(md|markdown|txt)$/i.test(row.file_name) ? `${row.file_name}.md` : row.file_name;
    const written = (await ctx.hub.call(
      session.device_id,
      "fs.write",
      // The id keeps two files of the same name apart.
      {
        path: `${session.cwd}/.attachments/${row.id.slice(0, 8)}-${name}`,
        content: bytes.toString("base64"),
        encoding: "base64",
      },
      actorOf(auth),
    )) as { path: string };
    await repo.markDelivered(ctx.db, row.id, session.id, written.path);
    // The device's copy is the file now; the server was only holding an upload on its way.
    if (row.storage_key)
      await ctx.storage.remove(row.storage_key).catch((err: unknown) => ctx.log(err, "could not remove a staged file"));
    delivered.push({ source_path: written.path, parsed_path: document ? written.path : null });
  }
  return delivered;
}

// -- A project's folder, on its device --

/** Where a project's files are: its own folder, or the workspace the device manages for it. */
async function workspaceOf(ctx: Ctx, project: { id: string; kind: string; root_path: string | null }): Promise<string> {
  if (project.root_path) return project.root_path;
  if (project.kind !== "chat") return managedCwd(`project-${project.id}`);
  // A quick chat's project is its one session's workspace.
  const session = await ctx.db
    .selectFrom("sessions")
    .select("cwd")
    .where("project_id", "=", project.id)
    .orderBy("created_at")
    .executeTakeFirst();
  return session?.cwd ?? managedCwd(`project-${project.id}`);
}

/** A path inside the project: relative, no `..`. */
function inside(root: string, relative: string | undefined): string {
  const clean = (relative ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (clean.split("/").some((part) => part === ".." || part === "."))
    throw badRequest("the path must stay inside the project", "invalid_path");
  return clean ? `${root.replace(/\/+$/, "")}/${clean}` : root;
}

export async function projectTree(
  ctx: Ctx,
  auth: Auth,
  projectId: string,
  options: { depth?: number; path?: string; includeHidden?: boolean },
): Promise<Schema<"ProjectFileTree">> {
  const project = await projects.require(ctx, auth, projectId);
  if (!project.device_id) return { files: [], root: null, device_online: false };
  try {
    const result = (await ctx.hub.call(
      project.device_id,
      "fs.tree",
      {
        path: inside(await workspaceOf(ctx, project), options.path),
        depth: options.depth ?? 2,
        include_hidden: options.includeHidden ?? false,
      },
      actorOf(auth),
    )) as { path: string; files: FsTreeNode[] };
    return { files: result.files, root: result.path, device_online: true };
  } catch (err) {
    // A panel showing a project's files should not fail because its device is asleep.
    if (err instanceof DeviceOfflineError) return { files: [], root: null, device_online: false };
    throw err;
  }
}

export async function uploadToProject(
  ctx: Ctx,
  auth: Auth,
  projectId: string,
  files: { name: string; bytes: Buffer }[],
): Promise<Schema<"ProjectFilesWritten">> {
  const project = await projects.require(ctx, auth, projectId, "edit");
  if (!project.device_id) throw new HttpError(409, "device_removed", "this project has no device to hold its files");
  const root = await workspaceOf(ctx, project);
  const written: string[] = [];
  for (const file of files) {
    const target = inside(root, file.name);
    if (target === root) throw badRequest("a file needs a name");
    await ctx.hub.call(
      project.device_id,
      "fs.write",
      { path: target, content: file.bytes.toString("base64"), encoding: "base64" },
      actorOf(auth),
    );
    written.push(file.name);
  }
  return { project_id: project.id, written };
}

// -- Reading a file that is on a device --

type Descriptor = Schema<"ResolvedFileDescriptor">;
type PreviewKind = Descriptor["previewKind"];

const PREVIEW: [PreviewKind, RegExp][] = [
  ["markdown", /\.(md|markdown|mdx)$/i],
  ["image", /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i],
  ["pdf", /\.pdf$/i],
  ["html", /\.html?$/i],
  ["docx", /\.docx?$/i],
  ["presentation", /\.pptx?$/i],
  ["spreadsheet", /\.(xlsx?|csv|tsv)$/i],
  ["media", /\.(mp4|webm|mov|mp3|wav|m4a|ogg)$/i],
  [
    "code",
    /\.(ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|swift|c|h|cpp|cs|rb|php|sh|bash|zsh|sql|ya?ml|toml|ini|xml|css|scss|vue|svelte|dockerfile)$/i,
  ],
  ["plain", /\.(txt|log|env|gitignore)$/i],
];
const previewKindOf = (name: string): PreviewKind =>
  PREVIEW.find(([, pattern]) => pattern.test(name))?.[0] ?? "unsupported";

const unresolved = (ref: string, error: Descriptor["error"]): Descriptor => ({
  ref,
  kind: "",
  absPath: null,
  url: null,
  downloadUrl: null,
  expiresAt: null,
  name: ref.split("/").pop() ?? "",
  mimeType: null,
  size: null,
  revision: null,
  exists: false,
  previewKind: "unsupported",
  capabilities: { canPreview: false, canDownload: false, canOpenExternal: false, canCopyContent: false },
  error,
});

/**
 * Which device a path is on. A file reference carries only a path, so: the
 * device of the project whose folder contains it, or the one a deliverable at
 * that path was delivered from, else the caller's only
 * device they may control.
 */
async function deviceFor(ctx: Ctx, auth: Auth, absPath: string): Promise<string | null> {
  const under = (root: string) => absPath === root || absPath.startsWith(`${root.replace(/\/+$/, "")}/`);
  const project = (await projects.list(ctx, auth)).find((p) => p.device_id && p.root_path && under(p.root_path));
  if (project?.device_id) return project.device_id;
  // A deliverable says where it is, wherever its conversation worked.
  const delivered = await artifacts.deviceOf(ctx, auth, absPath);
  if (delivered) return delivered;
  const reachable = (await devices.list(ctx, auth)).filter(
    (device) => device.online && sharing.permissionAtLeast(device.permission ?? "view", "control"),
  );
  return reachable.length === 1 ? (reachable[0]?.id ?? null) : null;
}

/** A file that exists, as the app is told of it: what it is, and a short-lived address for its bytes. */
function described(
  app: FastifyInstance,
  auth: Auth,
  ref: string,
  where: { device: string; path: string } | { kb: string },
  name: string,
  size: number | null,
  revision: string | null,
  absPath: string | null = null,
): Descriptor {
  const token = app.jwt.sign({ typ: "file", ...where, name }, { sub: auth.userId, expiresIn: FILE_TOKEN_TTL_S });
  const previewKind = previewKindOf(name);
  const tooLarge = (size ?? 0) > app.ctx.config.MAX_UPLOAD_BYTES;
  return {
    ref,
    kind: "remote",
    absPath,
    url: `/v1/files/raw/${token}`,
    downloadUrl: `/v1/files/raw/${token}?download=1`,
    expiresAt: Date.now() + FILE_TOKEN_TTL_S * 1000,
    name,
    mimeType: mime.getType(name),
    size,
    revision,
    exists: true,
    previewKind,
    capabilities: {
      canPreview: previewKind !== "unsupported" && !tooLarge,
      canDownload: !tooLarge,
      canOpenExternal: false,
      canCopyContent: ["markdown", "code", "plain", "html"].includes(previewKind) && !tooLarge,
    },
    error: null,
  };
}

/**
 * Turn file references into addresses the browser can fetch. Each address is
 * a short-lived token for that one file, on that one device, read as the caller.
 */
export async function resolve(app: FastifyInstance, auth: Auth, refs: string[]): Promise<Descriptor[]> {
  const ctx = app.ctx;
  return Promise.all(
    refs.map(async (ref): Promise<Descriptor> => {
      if (!FILE_REF.test(ref)) return unresolved(ref, "invalid_ref");
      const absPath = `/${decodeURIComponent(ref.replace(FILE_REF, "")).replace(/^\/+/, "")}`;
      // A knowledge-base document's original is in the server's own storage, not on a device.
      if (absPath.startsWith(`/${knowledge.ORIGINAL_PREFIX}`)) {
        const doc = await knowledge.original(ctx, auth, absPath.slice(1));
        return doc ? described(app, auth, ref, { kb: doc.id }, doc.name, doc.size, null) : unresolved(ref, "not_found");
      }
      const deviceId = await deviceFor(ctx, auth, absPath);
      if (!deviceId) return unresolved(ref, "not_found");
      let stat: { path: string; kind?: string; size?: number; mtime_ms?: number };
      try {
        stat = (await ctx.hub.call(deviceId, "fs.stat", { path: absPath }, actorOf(auth))) as typeof stat;
      } catch (err) {
        return unresolved(ref, err instanceof HttpError && err.status === 403 ? "forbidden" : "not_found");
      }
      if (stat.kind !== "file") return unresolved(ref, "not_found");
      return described(
        app,
        auth,
        ref,
        { device: deviceId, path: stat.path },
        path.posix.basename(absPath),
        stat.size ?? null,
        stat.mtime_ms ? String(Math.round(stat.mtime_ms)) : null,
        stat.path,
      );
    }),
  );
}

/** The bytes a file token stands for, fetched from the device as the member the token was issued to. */
export async function readByToken(app: FastifyInstance, token: string): Promise<{ bytes: Buffer; name: string }> {
  let claim: { typ?: string; sub?: string; device?: string; path?: string; kb?: string; name?: string };
  try {
    claim = app.jwt.verify(token);
  } catch {
    throw notFound("file");
  }
  if (claim.typ === "file" && claim.kb) {
    const bytes = await knowledge.originalBytes(app.ctx, claim.kb);
    if (!bytes) throw notFound("file");
    return { bytes, name: claim.name ?? "file" };
  }
  if (claim.typ !== "file" || !claim.sub || !claim.device || !claim.path) throw notFound("file");
  const file = (await app.ctx.hub.call(
    claim.device,
    "fs.read",
    { path: claim.path, max_bytes: app.ctx.config.MAX_UPLOAD_BYTES },
    { user_id: claim.sub, name: "" },
  )) as { content: string; encoding: "utf8" | "base64" };
  return { bytes: Buffer.from(file.content, file.encoding), name: claim.name ?? "file" };
}
