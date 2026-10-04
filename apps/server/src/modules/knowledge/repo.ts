import type { Db } from "@agent-base/db";
import { type Expression, type SqlBool, sql } from "kysely";

export type KbRow = Awaited<ReturnType<typeof listBases>>[number];
export type DocRow = NonNullable<Awaited<ReturnType<typeof findDocument>>>;
export type TaskRow = NonNullable<Awaited<ReturnType<typeof findTask>>>;
export type Status = "queued" | "processing" | "ready" | "failed";

/** What may be consulted: everything in the organization, or what a project was bound to. */
export interface Scope {
  orgId: string;
  kbIds: string[];
  documentIds: string[];
  /** Folders, as a knowledge base and the path prefix inside it. */
  folders: { kbId: string; prefix: string }[];
  /** No bindings: the whole organization. */
  everything: boolean;
}

/** Everything about a document except its text, which is large and asked for separately. */
const DOC_COLUMNS = [
  "id",
  "org_id",
  "kb_id",
  "owner_id",
  "relative_path",
  "filename",
  "mime_type",
  "size_bytes",
  "storage_key",
  "status",
  "error",
  "chunk_count",
  "created_at",
] as const;

const likePrefix = (prefix: string): string => `${prefix.replace(/[\\%_]/g, "\\$&")}/%`;

/** A knowledge base with how many documents it holds and how many are still on their way. */
const bases = (db: Db, orgId: string) =>
  db
    .selectFrom("knowledge_bases as kb")
    .selectAll("kb")
    .select((eb) => [
      eb
        .selectFrom("kb_documents as d")
        .whereRef("d.kb_id", "=", "kb.id")
        .select(eb.fn.countAll<number>().as("n"))
        .as("document_count"),
      eb
        .selectFrom("kb_documents as d")
        .whereRef("d.kb_id", "=", "kb.id")
        .where("d.status", "in", ["queued", "processing"])
        .select(eb.fn.countAll<number>().as("n"))
        .as("pending_count"),
    ])
    .where("kb.org_id", "=", orgId);

export const listBases = (db: Db, orgId: string) => bases(db, orgId).orderBy("kb.created_at").execute();

export const findBase = (db: Db, orgId: string, id: string) =>
  bases(db, orgId).where("kb.id", "=", id).executeTakeFirst();

export const insertBase = (db: Db, row: { id: string; org_id: string; owner_id: string; name: string }) =>
  db.insertInto("knowledge_bases").values(row).execute();

export const renameBase = (db: Db, id: string, name: string) =>
  db.updateTable("knowledge_bases").set({ name }).where("id", "=", id).execute();

export const deleteBase = (db: Db, id: string) => db.deleteFrom("knowledge_bases").where("id", "=", id).execute();

export const findDocument = (db: Db, orgId: string, id: string) =>
  db.selectFrom("kb_documents").select(DOC_COLUMNS).where("org_id", "=", orgId).where("id", "=", id).executeTakeFirst();

/** For the parser, which works for no organization in particular. */
export const documentForParsing = (db: Db, id: string) =>
  db.selectFrom("kb_documents").select(DOC_COLUMNS).where("id", "=", id).executeTakeFirst();

export function listDocuments(
  db: Db,
  orgId: string,
  filter: { kbId?: string; q?: string; status?: string; prefix?: string; ids?: string[]; unsettled?: boolean },
) {
  let query = db.selectFrom("kb_documents").select(DOC_COLUMNS).where("org_id", "=", orgId);
  if (filter.kbId) query = query.where("kb_id", "=", filter.kbId);
  if (filter.status) query = query.where("status", "=", filter.status as Status);
  if (filter.q) query = query.where("filename", "ilike", `%${filter.q.replace(/[\\%_]/g, "\\$&")}%`);
  if (filter.prefix) query = query.where("relative_path", "like", likePrefix(filter.prefix));
  if (filter.ids) query = query.where("id", "in", filter.ids);
  if (filter.unsettled) query = query.where("status", "!=", "ready");
  return query.orderBy("relative_path").execute();
}

/** Put a document at a path of a knowledge base, replacing whatever was there. Returns the key it replaced. */
export async function putDocument(
  db: Db,
  row: {
    id: string;
    org_id: string;
    kb_id: string;
    owner_id: string;
    relative_path: string;
    filename: string;
    mime_type: string | null;
    size_bytes: number;
    storage_key: string;
  },
): Promise<{ id: string; replacedKey: string | null }> {
  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("kb_documents")
      .select(["id", "storage_key"])
      .where("kb_id", "=", row.kb_id)
      .where("relative_path", "=", row.relative_path)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      await tx.insertInto("kb_documents").values(row).execute();
      return { id: row.id, replacedKey: null };
    }
    await tx
      .updateTable("kb_documents")
      .set({
        owner_id: row.owner_id,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        storage_key: row.storage_key,
        status: "queued",
        error: null,
        updated_at: new Date(),
      })
      .where("id", "=", existing.id)
      .execute();
    return { id: existing.id, replacedKey: existing.storage_key };
  });
}

export const storageKey = async (db: Db, id: string): Promise<string | undefined> =>
  (await db.selectFrom("kb_documents").select("storage_key").where("id", "=", id).executeTakeFirst())?.storage_key;

export const deleteDocument = (db: Db, id: string) => db.deleteFrom("kb_documents").where("id", "=", id).execute();

export const setStatus = (db: Db, ids: string[], status: Status, error: string | null = null) =>
  ids.length === 0
    ? Promise.resolve([])
    : db.updateTable("kb_documents").set({ status, error, updated_at: new Date() }).where("id", "in", ids).execute();

/** The parsed text and its search index replace whatever the document had. */
export const storeParsed = (db: Db, id: string, content: string, chunks: string[]) =>
  db.transaction().execute(async (tx) => {
    await tx.deleteFrom("kb_chunks").where("document_id", "=", id).execute();
    // Many small inserts rather than one statement with thousands of parameters.
    for (let at = 0; at < chunks.length; at += 500)
      await tx
        .insertInto("kb_chunks")
        .values(chunks.slice(at, at + 500).map((text, i) => ({ document_id: id, ord: at + i, content: text })))
        .execute();
    await tx
      .updateTable("kb_documents")
      .set({ status: "ready", error: null, content, chunk_count: chunks.length, updated_at: new Date() })
      .where("id", "=", id)
      .execute();
  });

export const insertTask = (
  db: Db,
  row: { id: string; org_id: string; kb_id: string | null; task_type: string; total_items: number },
) => db.insertInto("kb_tasks").values(row).returningAll().executeTakeFirstOrThrow();

export const findTask = (db: Db, orgId: string, id: string) =>
  db.selectFrom("kb_tasks").selectAll().where("org_id", "=", orgId).where("id", "=", id).executeTakeFirst();

export const advanceTask = (db: Db, id: string, failed: boolean) =>
  db
    .updateTable("kb_tasks")
    .set((eb) => ({
      processed_items: eb("processed_items", "+", 1),
      ...(failed ? { failed_items: eb("failed_items", "+", 1) } : {}),
    }))
    .where("id", "=", id)
    .execute();

export async function health(db: Db, orgId: string): Promise<Record<Status, number>> {
  const rows = await db
    .selectFrom("kb_documents")
    .select(["status", (eb) => eb.fn.countAll<number>().as("n")])
    .where("org_id", "=", orgId)
    .groupBy("status")
    .execute();
  const counts: Record<Status, number> = { queued: 0, processing: 0, ready: 0, failed: 0 };
  for (const row of rows) counts[row.status] = Number(row.n);
  return counts;
}

// ---------------------------------------------------------------- bindings

export const listBindings = (db: Db, projectId: string) =>
  db
    .selectFrom("project_kb_bindings")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("binding_kind")
    .orderBy("target_id")
    .execute();

export const replaceBindings = (
  db: Db,
  projectId: string,
  bindings: { binding_kind: "kb" | "folder" | "document"; target_id: string }[],
) =>
  db.transaction().execute(async (tx) => {
    await tx.deleteFrom("project_kb_bindings").where("project_id", "=", projectId).execute();
    if (bindings.length > 0)
      await tx
        .insertInto("project_kb_bindings")
        .values(bindings.map((binding) => ({ project_id: projectId, ...binding })))
        .onConflict((oc) => oc.doNothing())
        .execute();
  });

/** The session a toolkit call comes from, as far as the knowledge base cares. */
export const sessionScope = (db: Db, sessionId: string) =>
  db.selectFrom("sessions").select(["org_id", "project_id"]).where("id", "=", sessionId).executeTakeFirst();

// ---------------------------------------------------------------- reading

/** `d` is a ready document the scope reaches. */
function reachable(scope: Scope): Expression<SqlBool> {
  const mine = sql<SqlBool>`d.org_id = ${scope.orgId} AND d.status = 'ready'`;
  if (scope.everything) return mine;
  const any: Expression<SqlBool>[] = [sql<SqlBool>`false`];
  if (scope.kbIds.length > 0) any.push(sql<SqlBool>`d.kb_id = ANY(${scope.kbIds}::uuid[])`);
  if (scope.documentIds.length > 0) any.push(sql<SqlBool>`d.id = ANY(${scope.documentIds}::uuid[])`);
  for (const folder of scope.folders)
    any.push(sql<SqlBool>`(d.kb_id = ${folder.kbId}::uuid AND d.relative_path LIKE ${likePrefix(folder.prefix)})`);
  return sql<SqlBool>`${mine} AND (${sql.join(any, sql` OR `)})`;
}

export interface Hit {
  document_id: string;
  filename: string;
  relative_path: string;
  knowledge_base: string;
  chunk: number;
  snippet: string;
  matched_terms: number;
}

/** The passages that contain the most of `terms`. Substring matching, so it works without word boundaries. */
export async function search(db: Db, scope: Scope, terms: string[], limit: number): Promise<Hit[]> {
  const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
  const { rows } = await sql<Hit>`
    SELECT c.document_id, d.filename, d.relative_path, kb.name AS knowledge_base, c.ord AS chunk, c.content AS snippet,
           (SELECT count(*)::int FROM unnest(${patterns}::text[]) p WHERE c.content ILIKE p) AS matched_terms
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      JOIN knowledge_bases kb ON kb.id = d.kb_id
     WHERE ${reachable(scope)} AND c.content ILIKE ANY(${patterns}::text[])
     ORDER BY matched_terms DESC, c.document_id, c.ord
     LIMIT ${limit}`.execute(db);
  return rows;
}

export async function listReachable(db: Db, scope: Scope, limit: number) {
  const { rows } = await sql<{
    document_id: string;
    filename: string;
    relative_path: string;
    knowledge_base: string;
    chars: number;
  }>`
    SELECT d.id AS document_id, d.filename, d.relative_path, kb.name AS knowledge_base, length(d.content) AS chars
      FROM kb_documents d JOIN knowledge_bases kb ON kb.id = d.kb_id
     WHERE ${reachable(scope)}
     ORDER BY kb.name, d.relative_path
     LIMIT ${limit}`.execute(db);
  return rows;
}

export async function countReachable(db: Db, scope: Scope): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM kb_documents d WHERE ${reachable(scope)}`.execute(db);
  return rows[0]?.n ?? 0;
}

/** A window of a reachable document's text, in characters. */
export async function readWindow(db: Db, scope: Scope, id: string, offset: number, length: number) {
  const { rows } = await sql<{ id: string; filename: string; total: number; text: string }>`
    SELECT d.id, d.filename, length(d.content) AS total, substr(d.content, ${offset}::int + 1, ${length}::int) AS text
      FROM kb_documents d
     WHERE ${reachable(scope)} AND d.id = ${id}::uuid`.execute(db);
  return rows[0];
}

/** A document's whole parsed text, for the preview. */
export async function content(db: Db, orgId: string, id: string): Promise<string | undefined> {
  const row = await db
    .selectFrom("kb_documents")
    .select("content")
    .where("org_id", "=", orgId)
    .where("id", "=", id)
    .executeTakeFirst();
  return row?.content;
}
