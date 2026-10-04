/**
 * Server-hosted MCP toolkits. A session running on any device, under any
 * runtime, reaches server-side capabilities (task orchestration, the knowledge
 * base) through these endpoints, as itself: each turn is handed a
 * token that names its session. Stateless — one MCP server per request — so
 * any replica can answer.
 */
import { SERVER_URL_PLACEHOLDER, type McpServerConfig } from "@agent-base/protocol";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";

/** A failure the model can read and act on — returned as a tool error, not a crash. */
export class ToolError extends Error {}

export interface Toolkit<Caller> {
  path: string;
  name: string;
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  /** Who the session is to this toolkit, or null when it may not use it. */
  authorize(sessionId: string): Promise<Caller | null>;
  call(caller: Caller, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

const TOKEN_TYPE = "tool";

/** A token that lets exactly one session call toolkits as itself. */
export const signToolToken = (app: FastifyInstance, sessionId: string): string =>
  app.jwt.sign({ typ: TOKEN_TYPE }, { sub: sessionId, expiresIn: "7d" });

function sessionOf(app: FastifyInstance, header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const payload = app.jwt.verify<{ typ?: string; sub?: string }>(header.slice(7));
    return payload.typ === TOKEN_TYPE && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

export function mountToolkit<Caller>(app: FastifyInstance, kit: Toolkit<Caller>): void {
  app.post(kit.path, async (req, reply) => {
    const sessionId = sessionOf(app, req.headers.authorization);
    const caller = sessionId ? await kit.authorize(sessionId) : null;
    if (!caller)
      return reply.code(401).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "invalid tool token" } });

    const server = new Server({ name: `agent-base-${kit.name}`, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: kit.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const result = await kit.call(caller, request.params.name, request.params.arguments ?? {});
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
      } catch (err) {
        if (!(err instanceof ToolError)) req.log.error({ err, tool: request.params.name }, "tool crashed");
        const text = err instanceof ToolError ? err.message : "internal error while running the tool";
        return { isError: true, content: [{ type: "text", text }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless: there is no stream to open and no session to delete.
  const notAllowed = { jsonrpc: "2.0", id: null, error: { code: -32000, message: "method not allowed" } };
  app.get(kit.path, async (_req, reply) => reply.code(405).send(notAllowed));
  app.delete(kit.path, async (_req, reply) => reply.code(405).send(notAllowed));
}

/**
 * The MCP server entry a session uses to reach a toolkit. The URL is written
 * relative to the server; the host fills in the address it links by.
 */
export const toolkitServer = (
  app: FastifyInstance,
  sessionId: string,
  kit: { name: string; path: string },
  toolTimeoutSec: number | null = null,
): McpServerConfig => ({
  name: kit.name,
  transport: "http",
  url: `${SERVER_URL_PLACEHOLDER}${kit.path}`,
  headers: { authorization: `Bearer ${signToolToken(app, sessionId)}` },
  tool_timeout_sec: toolTimeoutSec,
  server_instructions_trusted: true,
});
