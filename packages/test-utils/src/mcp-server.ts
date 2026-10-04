/**
 * A real MCP server over streamable HTTP, with two tools and an optional
 * bearer token — so connectors are exercised against the actual protocol.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface TestMcpServer {
  url: string;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  token: string | null;
  /** Arguments of every `lookup` call, in order. */
  calls: string[];
  /** The `Authorization` header of every request, in order. */
  authorizations: (string | undefined)[];
  stop(): Promise<void>;
}

function build(state: TestMcpServer): McpServer {
  const mcp = new McpServer({ name: "test-tools", version: "1.0.0" });
  mcp.registerTool(
    "lookup",
    { description: "Look a term up in the test catalogue", inputSchema: { term: z.string() } },
    async ({ term }) => {
      state.calls.push(term);
      return { content: [{ type: "text", text: `${term}: found in the catalogue` }] };
    },
  );
  mcp.registerTool("ping", { description: "Answer pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  return mcp;
}

export async function startMcpServer(): Promise<TestMcpServer> {
  const state: TestMcpServer = { url: "", token: null, calls: [], authorizations: [], stop: async () => undefined };
  const http: Server = createServer((req, res) => {
    state.authorizations.push(req.headers.authorization);
    if (state.token && req.headers.authorization !== `Bearer ${state.token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      // Stateless: each request gets a server and transport of its own.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      void build(state)
        .connect(transport)
        .then(() => transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined));
    });
  });
  state.stop = async () => {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  };
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  return state;
}
