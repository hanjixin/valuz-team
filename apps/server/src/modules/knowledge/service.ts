/**
 * The organization's knowledge bases. Unlike a project's files, which stay on a
 * device, these are kept on the server: every member, and every device's agents,
 * can search them whether or not any one computer is on.
 *
 * Every member reads; a knowledge base is changed by whoever created it or by an
 * organization owner or admin.
 */
import path from "node:path";
import type { Schema } from "@agent-base/contract";
import mime from "mime";
import { isOrgAdmin } from "../../infra/auth.ts";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest, forbidden, notFound } from "../../infra/errors.ts";
import type { UploadedFile } from "../../infra/upload.ts";
import * as audit from "../audit/service.ts";
import * as projects from "../projects/service.ts";
import * as parser from "./parse.ts";
import * as repo from "./repo.ts";

type Base = Schema<"KnowledgeBase">;
type Doc = Schema<"DocumentListItem">;
type Task = Schema<"ImportTaskResponse">;
type Node = Schema<"KnowledgeBaseTree">["nodes"][number];
type Binding = Schema<"KbBinding">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ folders

/** A folder has no row: it is a path prefix inside a knowledge base, and its id says both. */
const folderId = (kbId: string, folder: string): string => `${kbId}.${Buffer.from(folder).toString("base64url")}`;

function parseFolderId(id: string): { kbId: string; prefix: string } | null {
  const [kbId, encoded, ...rest] = id.split(".");
  if (!kbId || !encoded || rest.length > 0 || !UUID.test(kbId)) return null;
  const prefix = Buffer.from(encoded, "base64url").toString("utf8");
  return prefix ? { kbId, prefix } : null;
}

const parentFolderId = (kbId: string, relativePath: string): string | null => {
  const dir = path.posix.dirname(relativePath);
  return dir === "." ? null : folderId(kbId, dir);
};

/** Where an upload goes inside the knowledge base — never outside it. */
function cleanPath(name: string): string {
  const parts = name
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.includes("..")) throw badRequest(`"${name}" is not a path inside the knowledge base`);
  return parts.join("/");
}

// ------------------------------------------------------------------ presenting

const presentBase = (auth: Auth, row: repo.KbRow): Base => ({
  id: row.id,
  name: row.name,
  root_path: "",
  parser_routing: "default",
  document_count: Number(row.document_count ?? 0),
  status: Number(row.pending_count ?? 0) > 0 ? "has_processing" : "all_ready",
  created_at: row.created_at.getTime(),
  auto_discover: false,
  last_full_scan_at: null,
  owner_id: row.owner_id,
  editable: row.owner_id === auth.userId || isOrgAdmin(auth),
});

const presentDoc = (row: repo.DocRow): Doc => ({
  id: row.id,
  filename: row.filename,
  title: row.filename,
  status: row.status,
  chunk_count: row.chunk_count,
  file_size_bytes: Number(row.size_bytes),
  mime_type: row.mime_type,
  kb_id: row.kb_id,
  kb_folder_id: parentFolderId(row.kb_id, row.relative_path),
  relative_path: row.relative_path,
  created_at: row.created_at.getTime(),
});

const presentTask = (row: repo.TaskRow): Task => ({
  task_id: row.id,
  task_type: row.task_type as NonNullable<Task["task_type"]>,
  status: row.processed_items >= row.total_items ? "completed" : row.processed_items > 0 ? "processing" : "queued",
  total_items: row.total_items,
  processed_items: row.processed_items,
  failed_items: row.failed_items,
  kb_id: row.kb_id,
  project_id: null,
  created_at: row.created_at.getTime(),
});

// ------------------------------------------------------------------ knowledge bases

async function requireBase(ctx: Ctx, auth: Auth, id: string, change = false): Promise<repo.KbRow> {
  const row = UUID.test(id) ? await repo.findBase(ctx.db, auth.orgId, id) : undefined;
  if (!row) throw notFound("knowledge base");
  if (change && row.owner_id !== auth.userId && !isOrgAdmin(auth))
    throw forbidden("only its creator or an organization admin can change this knowledge base");
  return row;
}

async function requireDocument(ctx: Ctx, auth: Auth, id: string): Promise<repo.DocRow> {
  const row = UUID.test(id) ? await repo.findDocument(ctx.db, auth.orgId, id) : undefined;
  if (!row) throw notFound("document");
  return row;
}

export const list = async (ctx: Ctx, auth: Auth): Promise<Base[]> =>
  (await repo.listBases(ctx.db, auth.orgId)).map((row) => presentBase(auth, row));

export const get = async (ctx: Ctx, auth: Auth, id: string): Promise<Base> =>
  presentBase(auth, await requireBase(ctx, auth, id));

export async function create(ctx: Ctx, auth: Auth, input: Schema<"KnowledgeBaseCreateRequest">): Promise<Base> {
  const name = input.name.trim();
  if (!name) throw badRequest("a knowledge base needs a name");
  const id = crypto.randomUUID();
  await repo.insertBase(ctx.db, { id, org_id: auth.orgId, owner_id: auth.userId, name });
  await audit.record(ctx.db, auth, "knowledge_base.create", { type: "knowledge_base", id }, { name });
  return get(ctx, auth, id);
}

export async function rename(ctx: Ctx, auth: Auth, id: string, name: string | null | undefined): Promise<Base> {
  await requireBase(ctx, auth, id, true);
  if (name?.trim()) await repo.renameBase(ctx.db, id, name.trim());
  return get(ctx, auth, id);
}

export async function remove(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  const base = await requireBase(ctx, auth, id, true);
  const documents = await repo.listDocuments(ctx.db, auth.orgId, { kbId: id });
  await repo.deleteBase(ctx.db, id);
  await audit.record(ctx.db, auth, "knowledge_base.delete", { type: "knowledge_base", id }, { name: base.name });
  await discard(
    ctx,
    documents.map((doc) => doc.storage_key),
  );
}

/** Stored files that no row points at any more. Failing to remove one leaves an orphan, not a broken state. */
async function discard(ctx: Ctx, keys: string[]): Promise<void> {
  for (const key of keys)
    await ctx.storage.remove(key).catch((err: unknown) => ctx.log(err, `could not remove stored file ${key}`));
}

// ------------------------------------------------------------------ documents

async function startTask(ctx: Ctx, auth: Auth, kbId: string | null, type: string, ids: string[]): Promise<Task> {
  const task = await repo.insertTask(ctx.db, {
    id: crypto.randomUUID(),
    org_id: auth.orgId,
    kb_id: kbId,
    task_type: type,
    total_items: ids.length,
  });
  await repo.setStatus(ctx.db, ids, "queued");
  if (ids.length > 0) await parser.enqueue(ctx, task.id, ids);
  return presentTask(task);
}

/** Add documents to a knowledge base. Each file's name is its path inside it; an existing path is replaced. */
export async function upload(ctx: Ctx, auth: Auth, kbId: string, files: UploadedFile[]): Promise<Task> {
  await requireBase(ctx, auth, kbId, true);
  const placed = files.map((file) => ({ file, relativePath: cleanPath(file.name) }));
  const refused = placed.filter(({ relativePath }) => !parser.supported(relativePath));
  if (refused.length > 0)
    throw badRequest(
      `unsupported file type: ${refused.map(({ relativePath }) => path.posix.basename(relativePath)).join(", ")} ` +
        `(supported: ${parser.SUPPORTED_EXTENSIONS.join(" ")})`,
      "unsupported_file_type",
    );

  const ids: string[] = [];
  for (const { file, relativePath } of placed) {
    const id = crypto.randomUUID();
    // The key is new on every upload, so replacing a document never overwrites what a parse is reading.
    const key = `kb/${auth.orgId}/${kbId}/${id}`;
    const filename = path.posix.basename(relativePath);
    const mimeType = file.mimeType === "application/octet-stream" ? mime.getType(filename) : file.mimeType;
    await ctx.storage.put(key, file.bytes, mimeType);
    const put = await repo.putDocument(ctx.db, {
      id,
      org_id: auth.orgId,
      kb_id: kbId,
      owner_id: auth.userId,
      relative_path: relativePath,
      filename,
      mime_type: mimeType,
      size_bytes: file.bytes.length,
      storage_key: key,
    });
    if (put.replacedKey) await discard(ctx, [put.replacedKey]);
    ids.push(put.id);
  }
  return startTask(ctx, auth, kbId, "import_files", ids);
}

/** Parse again whatever in the knowledge base is not ready. */
export async function rescan(ctx: Ctx, auth: Auth, kbId: string): Promise<Task> {
  await requireBase(ctx, auth, kbId, true);
  const unsettled = await repo.listDocuments(ctx.db, auth.orgId, { kbId, unsettled: true });
  return startTask(
    ctx,
    auth,
    kbId,
    "rescan",
    unsettled.map((doc) => doc.id),
  );
}

export async function reindex(ctx: Ctx, auth: Auth, documentIds: string[]): Promise<Task> {
  const ids = [...new Set(documentIds)].filter((id) => UUID.test(id));
  const documents = ids.length > 0 ? await repo.listDocuments(ctx.db, auth.orgId, { ids }) : [];
  if (documents.length !== new Set(documentIds).size) throw notFound("document");
  for (const kbId of new Set(documents.map((doc) => doc.kb_id))) await requireBase(ctx, auth, kbId, true);
  const kbIds = [...new Set(documents.map((doc) => doc.kb_id))];
  return startTask(ctx, auth, kbIds.length === 1 ? (kbIds[0] ?? null) : null, "reindex", ids);
}

export async function task(ctx: Ctx, auth: Auth, id: string): Promise<Task> {
  const row = UUID.test(id) ? await repo.findTask(ctx.db, auth.orgId, id) : undefined;
  if (!row) throw notFound("task");
  return presentTask(row);
}

export async function listDocuments(
  ctx: Ctx,
  auth: Auth,
  filter: { kbId?: string; q?: string; status?: string },
): Promise<Doc[]> {
  if (filter.kbId && !UUID.test(filter.kbId)) return [];
  return (await repo.listDocuments(ctx.db, auth.orgId, filter)).map(presentDoc);
}

export async function getDocument(ctx: Ctx, auth: Auth, id: string): Promise<Schema<"DocumentDetail">> {
  const row = await requireDocument(ctx, auth, id);
  return {
    ...presentDoc(row),
    // A reference the file service resolves to the stored original (see `original`).
    source_path: `${ORIGINAL_PREFIX}${row.id}/${row.filename}`,
    original_path: null,
    managed_path: null,
    parser_mode: "default",
    docs_runtime_id: null,
    last_error_code: row.status === "failed" ? "parse_failed" : null,
    last_error_message: row.error,
    parser_attempts: [],
  };
}

/** How a document's original file is referred to: not a path on any device, a name in the knowledge base. */
export const ORIGINAL_PREFIX = "kb/";

/** The uploaded file behind a document reference, for a member of its organization. */
export async function original(
  ctx: Ctx,
  auth: Auth,
  reference: string,
): Promise<{ id: string; name: string; size: number; mimeType: string | null } | null> {
  const id = reference.slice(ORIGINAL_PREFIX.length).split("/")[0] ?? "";
  const row = UUID.test(id) ? await repo.findDocument(ctx.db, auth.orgId, id) : undefined;
  return row ? { id: row.id, name: row.filename, size: Number(row.size_bytes), mimeType: row.mime_type } : null;
}

/** The bytes of a document's original file. Whoever holds a token for it was already allowed to read it. */
export async function originalBytes(ctx: Ctx, documentId: string): Promise<Buffer | null> {
  const key = await repo.storageKey(ctx.db, documentId);
  return key ? ctx.storage.get(key) : null;
}

/** A document's parsed text, for handing to an agent. 404 unless it is this organization's and ready. */
export async function textOf(
  ctx: Ctx,
  orgId: string,
  id: string,
): Promise<{ id: string; filename: string; mimeType: string | null; text: string }> {
  const row = UUID.test(id) ? await repo.findDocument(ctx.db, orgId, id) : undefined;
  if (!row || row.status !== "ready") throw notFound("document");
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    text: (await repo.content(ctx.db, orgId, id)) ?? "",
  };
}

export async function removeDocument(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  const row = await requireDocument(ctx, auth, id);
  await requireBase(ctx, auth, row.kb_id, true);
  await repo.deleteDocument(ctx.db, id);
  await discard(ctx, [row.storage_key]);
}

/** One window of a document's parsed text, measured in bytes and cut on character boundaries. */
export async function preview(
  ctx: Ctx,
  auth: Auth,
  id: string,
  offset: number,
  maxBytes: number,
): Promise<Schema<"DocumentPreview">> {
  await requireDocument(ctx, auth, id);
  const bytes = Buffer.from((await repo.content(ctx.db, auth.orgId, id)) ?? "", "utf8");
  const continuation = (at: number): boolean => ((bytes[at] ?? 0) & 0xc0) === 0x80;
  let start = Math.min(offset, bytes.length);
  while (start < bytes.length && continuation(start)) start++;
  let end = Math.min(start + maxBytes, bytes.length);
  while (end > start && end < bytes.length && continuation(end)) end--;
  return {
    document_id: id,
    markdown: bytes.subarray(start, end).toString("utf8"),
    offset: start,
    returned_bytes: end - start,
    total_bytes: bytes.length,
    truncated: end < bytes.length,
  };
}

export async function health(ctx: Ctx, auth: Auth): Promise<Schema<"DocsHealthResponse">> {
  const counts = await repo.health(ctx.db, auth.orgId);
  return {
    status: "healthy",
    preview_dir_exists: true,
    total_documents: counts.queued + counts.processing + counts.ready + counts.failed,
    ready_count: counts.ready,
    processing_count: counts.queued + counts.processing,
    failed_count: counts.failed,
    missing_count: 0,
  };
}

/** One level of a knowledge base: the folders and documents directly inside `folder` (or its root). */
export async function tree(ctx: Ctx, auth: Auth, kbId: string, folder?: string): Promise<Node[]> {
  await requireBase(ctx, auth, kbId);
  const at = folder ? parseFolderId(folder) : null;
  if (folder && at?.kbId !== kbId) throw notFound("folder");
  const prefix = at ? `${at.prefix}/` : "";
  const documents = await repo.listDocuments(ctx.db, auth.orgId, { kbId, ...(at ? { prefix: at.prefix } : {}) });

  const folders = new Map<string, { count: number; pending: boolean; failed: boolean }>();
  const leaves: Node[] = [];
  for (const doc of documents) {
    const rest = doc.relative_path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      leaves.push({
        id: doc.id,
        name: doc.filename,
        relative_path: doc.relative_path,
        kind: "document",
        status: doc.status,
        document_count: 0,
      });
      continue;
    }
    const name = rest.slice(0, slash);
    const entry = folders.get(name) ?? { count: 0, pending: false, failed: false };
    entry.count++;
    entry.pending ||= doc.status === "queued" || doc.status === "processing";
    entry.failed ||= doc.status === "failed";
    folders.set(name, entry);
  }
  const branches = [...folders].map(([name, entry]): Node => ({
    id: folderId(kbId, prefix + name),
    name,
    relative_path: prefix + name,
    kind: "folder",
    status: entry.pending ? "processing" : entry.failed ? "failed" : "ready",
    document_count: entry.count,
  }));
  return [...branches.sort((a, b) => a.name.localeCompare(b.name)), ...leaves];
}

// ------------------------------------------------------------------ what a project may consult

export async function bindings(ctx: Ctx, auth: Auth, projectId: string): Promise<Binding[]> {
  await projects.require(ctx, auth, projectId);
  return repo.listBindings(ctx.db, projectId);
}

export async function setBindings(ctx: Ctx, auth: Auth, projectId: string, wanted: Binding[]): Promise<Binding[]> {
  await projects.require(ctx, auth, projectId, "edit");
  for (const binding of wanted) {
    // A binding must name something of this organization — never a way to reach another's documents.
    if (binding.binding_kind === "kb") await requireBase(ctx, auth, binding.target_id);
    else if (binding.binding_kind === "document") await requireDocument(ctx, auth, binding.target_id);
    else await requireBase(ctx, auth, parseFolderId(binding.target_id)?.kbId ?? "");
  }
  await repo.replaceBindings(
    ctx.db,
    projectId,
    wanted.map(({ binding_kind, target_id }) => ({ binding_kind, target_id })),
  );
  return repo.listBindings(ctx.db, projectId);
}

/** What a project's agents may consult: its bindings, or with none, the whole organization. */
export async function scopeOf(ctx: Ctx, orgId: string, projectId: string | null): Promise<repo.Scope> {
  const bound = projectId ? await repo.listBindings(ctx.db, projectId) : [];
  const of = (kind: Binding["binding_kind"]): string[] =>
    bound.filter((binding) => binding.binding_kind === kind).map((binding) => binding.target_id);
  return {
    orgId,
    everything: bound.length === 0,
    kbIds: of("kb").filter((id) => UUID.test(id)),
    documentIds: of("document").filter((id) => UUID.test(id)),
    folders: of("folder").flatMap((id) => parseFolderId(id) ?? []),
  };
}

// ------------------------------------------------------------------ searching

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/**
 * Turn a query into search terms. Space-separated words are used as they are;
 * a run of CJK text has no word boundaries, so it also contributes its
 * 2-character slices.
 */
export function searchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.split(/[\s,.;:!?，。；：！？、"'“”()（）[\]{}<>|/\\]+/).filter(Boolean)) {
    if (!CJK.test(word)) {
      if (word.length >= 2) terms.add(word.toLowerCase());
      continue;
    }
    terms.add(word);
    for (let i = 0; i + 2 <= word.length && terms.size < 24; i++) terms.add(word.slice(i, i + 2));
  }
  return [...terms].slice(0, 24);
}

export async function searchScope(ctx: Ctx, scope: repo.Scope, query: string, limit: number): Promise<repo.Hit[]> {
  const terms = searchTerms(query);
  return terms.length === 0 ? [] : repo.search(ctx.db, scope, terms, Math.min(Math.max(limit, 1), 20));
}

/** Search as a member would from the app: within what a project may consult, optionally narrowed further. */
export async function search(ctx: Ctx, auth: Auth, input: Schema<"SearchRequest">): Promise<Schema<"SearchHit">[]> {
  const project = UUID.test(input.project_id) ? await projects.require(ctx, auth, input.project_id) : null;
  const scope = await scopeOf(ctx, auth.orgId, project?.id ?? null);
  const wanted = new Set(input.document_ids ?? []);
  const folders = (input.folder_ids ?? []).flatMap((id) => parseFolderId(id) ?? []);
  const narrowed = wanted.size > 0 || folders.length > 0;
  const top = input.top_k ?? 5;
  // Narrowing only: what is asked for must already be reachable, so search the scope and keep what was named.
  const hits = await searchScope(ctx, scope, input.query, narrowed ? 20 : top);
  return hits
    .filter(
      (hit) =>
        !narrowed ||
        wanted.has(hit.document_id) ||
        folders.some((folder) => hit.relative_path.startsWith(`${folder.prefix}/`)),
    )
    .slice(0, top)
    .map(presentHit(searchTerms(input.query).length));
}

const presentHit =
  (termCount: number) =>
  (hit: repo.Hit): Schema<"SearchHit"> => ({
    document_id: hit.document_id,
    filename: hit.filename,
    score: termCount === 0 ? 0 : hit.matched_terms / termCount,
    snippet: hit.snippet,
    page_ref: null,
    chunk_ref: String(hit.chunk),
  });

export const listReachable = (ctx: Ctx, scope: repo.Scope) => repo.listReachable(ctx.db, scope, 200);
export const hasReachable = async (ctx: Ctx, scope: repo.Scope): Promise<boolean> =>
  (await repo.countReachable(ctx.db, scope)) > 0;
export const readWindow = (ctx: Ctx, scope: repo.Scope, id: string, offset: number, length: number) =>
  UUID.test(id) ? repo.readWindow(ctx.db, scope, id, offset, length) : Promise.resolve(undefined);
export const sessionScope = async (ctx: Ctx, sessionId: string): Promise<repo.Scope | null> => {
  const session = await repo.sessionScope(ctx.db, sessionId);
  return session ? scopeOf(ctx, session.org_id, session.project_id) : null;
};
export type Scope = repo.Scope;
