/**
 * Knowledge base. A document is an uploaded file parsed to text, cut into
 * chunks, and searched by agents through the `docs` toolkit while they work.
 * Parsing runs off the request path on a BullMQ queue; the parsers and the
 * splitter are third-party (officeparser, @langchain/textsplitters).
 */
import path from "node:path";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { type Job, Queue, Worker } from "bullmq";
import { parseOfficeAsync } from "officeparser";
import { redisConnection } from "./automations.ts";
import type { Ctx } from "./context.ts";
import type { Row } from "./db.ts";
import { ToolError, type Toolkit } from "./mcp.ts";
import type { FileRef } from "./storage.ts";

const QUEUE = "documents";
export const DOCS_MCP_PATH = "/v1/mcp/docs";
const MAX_BYTES = 50 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".html", ".htm", ".xml", ".log"]);
const OFFICE_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods"]);
export const SUPPORTED_EXTENSIONS = [...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS];

/** What a session may read: its project's documents plus the org library. */
export interface DocScope {
  orgId: string;
  projectId: string | null;
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/**
 * Turn a query into search terms. Space-separated words are used as they are;
 * a run of CJK text has no word boundaries, so it also contributes its
 * 2-character slices.
 */
export function searchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.split(/[\s,.;:!?，。；：！？、"'“”()（）\[\]{}<>|/\\]+/).filter(Boolean)) {
    if (!CJK.test(word)) {
      if (word.length >= 2) terms.add(word.toLowerCase());
      continue;
    }
    terms.add(word);
    for (let i = 0; i + 2 <= word.length && terms.size < 24; i++) terms.add(word.slice(i, i + 2));
  }
  return [...terms].slice(0, 24);
}

const likePattern = (term: string): string => `%${term.replace(/[\\%_]/g, "\\$&")}%`;

export class DocumentService {
  private readonly queue: Queue<{ documentId: string }>;
  private worker: Worker<{ documentId: string }> | null = null;
  private readonly splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1200, chunkOverlap: 150 });

  constructor(private readonly ctx: Ctx) {
    this.queue = new Queue(QUEUE, { connection: redisConnection(ctx.config.REDIS_URL) });
  }

  start(): void {
    this.worker = new Worker(QUEUE, (job) => this.parse(job), { connection: redisConnection(this.ctx.config.REDIS_URL), concurrency: 2 });
    this.worker.on("failed", (job, err) => console.error(`[document ${job?.data.documentId}] ${err.message}`));
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  async enqueue(documentId: string): Promise<void> {
    await this.ctx.db.query("UPDATE documents SET status = 'queued', error = NULL, updated_at = now() WHERE id = $1", [documentId]);
    await this.queue.add("parse", { documentId }, { removeOnComplete: 100, removeOnFail: 100 });
  }

  private async extract(filename: string, bytes: Buffer): Promise<string> {
    const ext = path.extname(filename).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return bytes.toString("utf8");
    if (OFFICE_EXTENSIONS.has(ext)) return parseOfficeAsync(bytes, { newlineDelimiter: "\n", ignoreNotes: false });
    throw new Error(`unsupported file type "${ext || filename}" (supported: ${SUPPORTED_EXTENSIONS.join(" ")})`);
  }

  private async parse(job: Job<{ documentId: string }>): Promise<void> {
    const id = job.data.documentId;
    const doc = await this.ctx.db.one(
      "SELECT d.*, f.driver, f.storage_key, f.content_type, f.size FROM documents d JOIN files f ON f.id = d.file_id WHERE d.id = $1",
      [id],
    );
    if (!doc) return; // deleted while queued
    await this.ctx.db.query("UPDATE documents SET status = 'parsing', updated_at = now() WHERE id = $1", [id]);
    try {
      if ((doc["size"] as number) > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES / 1024 / 1024} MB`);
      const file: FileRef = { id: doc["file_id"] as string, driver: doc["driver"] as string, storage_key: doc["storage_key"] as string, content_type: doc["content_type"] as string, org_id: doc["org_id"] as string };
      // Postgres text cannot hold NUL bytes; some PDFs carry them.
      const text = (await this.extract(doc["filename"] as string, await this.ctx.storage.read(file))).replace(/\u0000/g, "").trim();
      if (!text) throw new Error("no text could be extracted (a scanned document needs OCR, which is not available)");
      const chunks = await this.splitter.splitText(text);
      await this.ctx.db.tx(async (tx) => {
        await tx.query("DELETE FROM document_chunks WHERE document_id = $1", [id]);
        await tx.query("INSERT INTO document_chunks (document_id, ord, content) SELECT $1, ord - 1, content FROM unnest($2::text[]) WITH ORDINALITY AS t(content, ord)", [id, chunks]);
        await tx.query("UPDATE documents SET status = 'ready', error = NULL, content = $2, text_chars = $3, chunk_count = $4, updated_at = now() WHERE id = $1", [id, text, text.length, chunks.length]);
      });
    } catch (err) {
      // A document that cannot be parsed is a result, not a job to retry.
      await this.ctx.db.query("UPDATE documents SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, (err as Error).message.slice(0, 500)]);
      await this.ctx.notify(doc["owner_id"] as string, doc["org_id"] as string, {
        kind: "document_failed", title: `文档解析失败：${String(doc["title"])}`, body: (err as Error).message.slice(0, 300), link: doc["project_id"] ? `/projects/${String(doc["project_id"])}` : "/library",
      });
    }
  }

  async search(scope: DocScope, query: string, limit = 8): Promise<Row[]> {
    const terms = searchTerms(query);
    if (terms.length === 0) return [];
    return this.ctx.db.query(
      `SELECT c.document_id, d.title, d.filename, c.ord AS chunk, c.content AS snippet,
              (SELECT count(*)::int FROM unnest($3::text[]) p WHERE c.content ILIKE p) AS matched_terms
         FROM document_chunks c JOIN documents d ON d.id = c.document_id
        WHERE d.org_id = $1 AND d.status = 'ready' AND (d.project_id IS NULL OR d.project_id = $2::uuid)
          AND c.content ILIKE ANY($3::text[])
        ORDER BY matched_terms DESC, c.document_id, c.ord LIMIT $4`,
      [scope.orgId, scope.projectId, terms.map(likePattern), Math.min(Math.max(limit, 1), 20)],
    );
  }

  list(scope: DocScope): Promise<Row[]> {
    return this.ctx.db.query(
      `SELECT id AS document_id, title, filename, text_chars, CASE WHEN project_id IS NULL THEN 'organization' ELSE 'project' END AS scope
         FROM documents WHERE org_id = $1 AND status = 'ready' AND (project_id IS NULL OR project_id = $2::uuid) ORDER BY created_at`,
      [scope.orgId, scope.projectId],
    );
  }

  /** A window of a document's text, for reading around a search hit. */
  async read(scope: DocScope, documentId: string, offset = 0, length = 8000): Promise<Row> {
    const start = Math.max(0, Math.floor(offset));
    const doc = await this.ctx.db.one<{ id: string; title: string; text_chars: number; text: string }>(
      `SELECT id, title, text_chars, substr(content, $4::int + 1, $5::int) AS text FROM documents
        WHERE id::text = $1 AND org_id = $2 AND status = 'ready' AND (project_id IS NULL OR project_id = $3::uuid)`,
      [documentId, scope.orgId, scope.projectId, start, length],
    );
    if (!doc) throw new ToolError(`no readable document with id "${documentId}" — use list_doc_scope or doc_search to find one`);
    const end = start + doc.text.length;
    return { document_id: doc.id, title: doc.title, offset: start, text: doc.text, next_offset: end < doc.text_chars ? end : null, total_chars: doc.text_chars };
  }

  /** The toolkit a session uses to consult the knowledge base. */
  toolkit(): Toolkit<DocScope> {
    return {
      path: DOCS_MCP_PATH,
      name: "docs",
      authorize: (session) => ({ orgId: session["org_id"] as string, projectId: (session["project_id"] as string | null) ?? null }),
      tools: [
        {
          name: "doc_search",
          description: "Search the knowledge base (this project's documents and the organization library) for passages matching the query. Returns the best passages with their document_id and title. Search before answering questions the documents may cover, and name the document you relied on.",
          inputSchema: { type: "object", properties: { query: { type: "string", description: "Keywords or a short phrase." }, limit: { type: "integer", description: "Max passages (default 8, max 20)." } }, required: ["query"] },
        },
        {
          name: "doc_read",
          description: "Read a document's text starting at a character offset (about 8000 characters per call). Use it to read around a doc_search hit or to read a short document in full; continue with next_offset.",
          inputSchema: { type: "object", properties: { document_id: { type: "string" }, offset: { type: "integer", description: "Character offset to start from (default 0)." } }, required: ["document_id"] },
        },
        {
          name: "list_doc_scope",
          description: "List the documents available to this session: document_id, title, filename, size, and whether each belongs to the project or the organization library.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      call: async (scope, tool, args) => {
        if (tool === "doc_search") {
          const query = typeof args["query"] === "string" ? args["query"] : "";
          if (!query.trim()) throw new ToolError("'query' is required");
          const results = await this.search(scope, query, Number(args["limit"]) || 8);
          return results.length ? { results } : { results: [], note: "no passage matched — try other keywords, or list_doc_scope to see what exists" };
        }
        if (tool === "doc_read") return this.read(scope, String(args["document_id"] ?? ""), Number(args["offset"]) || 0);
        if (tool === "list_doc_scope") return { documents: await this.list(scope) };
        throw new ToolError(`unknown tool "${tool}"`);
      },
    };
  }
}
