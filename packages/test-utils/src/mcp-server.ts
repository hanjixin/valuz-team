/**
 * A real MCP server over streamable HTTP, with two tools and an optional
 * bearer token — so connectors are exercised against the actual protocol.
 */
import { createHash } from "node:crypto";
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
  /**
   * When set, the server asks for an OAuth sign-in instead: it publishes its authorization
   * server (itself), registers clients, and takes only the access tokens it issued.
   */
  oauth: {
    /** False: no self-registration — a member must bring a client id. */
    registration: boolean;
    /** How long an access token lasts, in seconds. */
    expiresIn: number;
    /** Clients it knows, tokens it issued, and each request to its token endpoint. */
    clients: Set<string>;
    accessTokens: Set<string>;
    grants: { grant_type: string; client_id: string }[];
  } | null;
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
  const state: TestMcpServer = {
    url: "",
    token: null,
    calls: [],
    authorizations: [],
    oauth: null,
    stop: async () => undefined,
  };
  // code → what it was issued for; refresh token → client.
  const codes = new Map<string, { client: string; challenge: string; redirect: string }>();
  const refreshTokens = new Map<string, string>();
  let issued = 0;
  const http: Server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? "", base);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const oauth = state.oauth;
    if (oauth && url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (oauth && url.pathname.startsWith("/.well-known/oauth-authorization-server"))
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(oauth.registration ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        scopes_supported: ["tools"],
      });
    if (oauth && url.pathname.startsWith("/.well-known/")) return json(404, {});
    if (oauth && (url.pathname === "/register" || url.pathname === "/token")) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (url.pathname === "/register") {
          const client = `client-${oauth.clients.size + 1}`;
          oauth.clients.add(client);
          return json(201, { ...(JSON.parse(raw) as object), client_id: client });
        }
        const form = new URLSearchParams(raw);
        const client = form.get("client_id") ?? "";
        const grant = form.get("grant_type") ?? "";
        oauth.grants.push({ grant_type: grant, client_id: client });
        const issue = () => {
          const access = `at-${++issued}`;
          const refresh = `rt-${issued}`;
          oauth.accessTokens.add(access);
          refreshTokens.set(refresh, client);
          return json(200, {
            access_token: access,
            refresh_token: refresh,
            token_type: "Bearer",
            expires_in: oauth.expiresIn,
          });
        };
        if (!oauth.clients.has(client)) return json(401, { error: "invalid_client" });
        if (grant === "refresh_token")
          return refreshTokens.get(form.get("refresh_token") ?? "") === client
            ? issue()
            : json(400, { error: "invalid_grant" });
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        // PKCE: the verifier must hash to the challenge the authorization request carried.
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          !code ||
          code.client !== client ||
          code.challenge !== challenge ||
          code.redirect !== form.get("redirect_uri")
        )
          return json(400, { error: "invalid_grant" });
        return issue();
      });
      return;
    }
    if (oauth && url.pathname === "/authorize") {
      // The person "signs in": the browser is sent back with a code (or with a refusal, when asked to deny).
      const client = url.searchParams.get("client_id") ?? "";
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (!oauth.clients.has(client) || url.searchParams.get("deny")) {
        redirect.searchParams.set("error", "access_denied");
        redirect.searchParams.set("error_description", "the user refused");
      } else {
        const code = `code-${codes.size + 1}-${Date.now()}`;
        codes.set(code, {
          client,
          challenge: url.searchParams.get("code_challenge") ?? "",
          redirect: url.searchParams.get("redirect_uri") ?? "",
        });
        redirect.searchParams.set("code", code);
      }
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    state.authorizations.push(req.headers.authorization);
    if (oauth && !oauth.accessTokens.has((req.headers.authorization ?? "").replace("Bearer ", "")))
      return json(
        401,
        { error: "unauthorized" },
        {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        },
      );
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
