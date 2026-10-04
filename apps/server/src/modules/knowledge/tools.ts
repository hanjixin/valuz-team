/** The toolkit a session uses to consult the knowledge base while it works. */
import { ToolError } from "../../infra/toolkit.ts";
import type { Ctx } from "../../infra/context.ts";
import * as service from "./service.ts";

export const DOCS_TOOLKIT = { name: "docs", path: "/v1/mcp/docs" };

export const DOCS_INSTRUCTIONS = [
  "## Knowledge base",
  "The organization keeps shared documents in a knowledge base, reachable through the `docs` tools.",
  "Before answering a question those documents may cover, search them (`doc_search`), read around what you find",
  "(`doc_read`), and name the document you relied on. `list_doc_scope` shows what is available.",
].join("\n");

export const DOCS_TOOLS = [
  {
    name: "doc_search",
    description:
      "Search the organization's knowledge base for passages matching the query. Returns the best passages with their document_id, filename and knowledge base. Search before answering questions the documents may cover, and name the document you relied on.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or a short phrase." },
        limit: { type: "integer", description: "Max passages (default 8, max 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "doc_read",
    description:
      "Read a document's text starting at a character offset (about 8000 characters per call). Use it to read around a doc_search hit or to read a short document in full; continue with next_offset.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        offset: { type: "integer", description: "Character offset to start from (default 0)." },
      },
      required: ["document_id"],
    },
  },
  {
    name: "list_doc_scope",
    description:
      "List the documents available to this session: document_id, filename, path, knowledge base and length.",
    inputSchema: { type: "object", properties: {} },
  },
];

const WINDOW = 8000;

export async function callTool(
  ctx: Ctx,
  scope: service.Scope,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (tool === "doc_search") {
    const query = typeof args["query"] === "string" ? args["query"] : "";
    if (!query.trim()) throw new ToolError("'query' is required");
    const results = await service.searchScope(ctx, scope, query, Number(args["limit"]) || 8);
    return results.length > 0
      ? { results }
      : { results: [], note: "no passage matched — try other keywords, or list_doc_scope to see what exists" };
  }
  if (tool === "doc_read") {
    const id = String(args["document_id"] ?? "");
    const offset = Math.max(0, Math.floor(Number(args["offset"]) || 0));
    const doc = await service.readWindow(ctx, scope, id, offset, WINDOW);
    if (!doc)
      throw new ToolError(`no readable document with id "${id}" — use list_doc_scope or doc_search to find one`);
    const end = offset + doc.text.length;
    return {
      document_id: doc.id,
      filename: doc.filename,
      offset,
      text: doc.text,
      next_offset: end < doc.total ? end : null,
      total_chars: doc.total,
    };
  }
  if (tool === "list_doc_scope") return { documents: await service.listReachable(ctx, scope) };
  throw new ToolError(`unknown tool "${tool}"`);
}
