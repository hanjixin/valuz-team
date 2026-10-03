/**
 * Server-hosted MCP toolkits. A session running on any device, under any
 * runtime, reaches server-side capabilities (task orchestration, the knowledge
 * base) through these endpoints, authenticated by the per-session token
 * injected at dispatch. Stateless: one MCP server per request, so any replica
 * can answer.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "./context.ts";
import type { Row } from "./db.ts";
import { signToolToken, verifyToolToken } from "./tasks/prompts.ts";

/** A failure the model can read and act on — returned as a tool error. */
export class ToolError extends Error {}

export interface Toolkit<C> {
  path: string;
  name: string;
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  /** Who is calling, or null when this session may not use the toolkit. */
  authorize(session: Row): Promise<C | null> | C | null;
  call(caller: C, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export function mountToolkit<C>(app: FastifyInstance, ctx: Ctx, kit: Toolkit<C>): void {
  app.post(kit.path, async (req, reply) => {
    const header = req.headers.authorization;
    const sessionId = header?.startsWith("Bearer ") ? await verifyToolToken(ctx, header.slice(7)) : null;
    const session = sessionId ? await ctx.db.one("SELECT * FROM sessions WHERE id = $1", [sessionId]) : null;
    const caller = session ? await kit.authorize(session) : null;
    if (!caller) return reply.code(401).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "invalid tool token" } });

    const server = new Server({ name: `agent-base-${kit.name}`, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: kit.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const result = await kit.call(caller, request.params.name, request.params.arguments ?? {});
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
      } catch (err) {
        if (!(err instanceof ToolError)) req.log.error({ err, tool: request.params.name }, "tool crashed");
        return { isError: true, content: [{ type: "text", text: err instanceof ToolError ? err.message : "internal error while running the tool" }] };
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

  // Stateless server: there is no stream to open and no session to delete.
  const notAllowed = { jsonrpc: "2.0", id: null, error: { code: -32000, message: "method not allowed" } };
  app.get(kit.path, async (_req, reply) => reply.code(405).send(notAllowed));
  app.delete(kit.path, async (_req, reply) => reply.code(405).send(notAllowed));
}

/** The MCP server entry a session uses to reach one of the toolkits. */
export async function toolkitServer(ctx: Ctx, sessionId: string, name: string, path: string, toolTimeoutSec: number | null = null): Promise<McpServerConfig> {
  return {
    name,
    transport: "http",
    url: `${ctx.config.PUBLIC_URL}${path}`,
    headers: { authorization: `Bearer ${await signToolToken(ctx, sessionId)}` },
    tool_timeout_sec: toolTimeoutSec,
    server_instructions_trusted: true,
  };
}
