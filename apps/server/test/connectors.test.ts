import { type TestMcpServer, startMcpServer } from "@agent-base/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serversFor } from "../src/modules/connectors/service.ts";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe("connectors", () => {
  let t: TestServer;
  let mcp: TestMcpServer;
  let alice: Account;
  let bob: Account;
  let id: string;

  const call = (account: Account, method: string, url: string, body?: object) =>
    t.call(method, url, { token: account.token, ...(body ? { body } : {}) });

  beforeAll(async () => {
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    mcp = await startMcpServer();
    mcp.token = "s3cret-token";
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
  });
  afterAll(async () => {
    await mcp?.stop();
    await t?.stop();
  });

  it("adds an MCP server, sealing what is marked secret and never giving it back", async () => {
    const created = await call(alice, "POST", "/v1/connectors", {
      display_name: "Catalogue Tools",
      transport: "http",
      url: mcp.url,
      description: "Looks things up",
      headers: [
        { key: "Authorization", secret: true, value: "Bearer s3cret-token" },
        { key: "X-Client", secret: false, value: "agent-base" },
      ],
      params: [{ key: "tenant", secret: false, value: "acme" }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: created.body.id,
      slug: "catalogue-tools",
      needs_auth: false,
      authorization_url: null,
    });
    id = created.body.id;

    const item = (await call(alice, "GET", `/v1/connectors/${id}`)).body;
    expect(item).toMatchObject({
      slug: "catalogue-tools",
      display_name: "Catalogue Tools",
      transport: "http",
      url: mcp.url,
      has_api_key: true,
      enabled: true,
      status: "untested",
      tool_count: null,
      permission: "admin",
      headers: [
        { key: "Authorization", secret: true, value: null },
        { key: "X-Client", secret: false, value: "agent-base" },
      ],
      params: [{ key: "tenant", secret: false, value: "acme" }],
    });
    const row = await t.server.ctx.db
      .selectFrom("connectors")
      .select(["config", "secret_enc"])
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row.config)).not.toContain("s3cret-token");
    expect(row.secret_enc).toMatch(/^v1\./);

    expect((await call(alice, "POST", "/v1/connectors", { display_name: "x", transport: "http" })).status).toBe(400);
    expect((await call(alice, "POST", "/v1/connectors", { display_name: "x", transport: "stdio" })).status).toBe(400);
    expect(
      (
        await call(alice, "POST", "/v1/connectors", {
          display_name: "x",
          transport: "http",
          url: mcp.url,
          slug: "catalogue-tools",
        })
      ).body.code,
    ).toBe("slug_taken");
  });

  it("connects for real when tested, and remembers what it found", async () => {
    const tested = await call(alice, "POST", `/v1/connectors/${id}/test`);
    expect(tested.body).toEqual({
      ok: true,
      tool_count: 2,
      tools: ["lookup", "ping"],
      tool_details: [
        { name: "lookup", description: "Look a term up in the test catalogue" },
        { name: "ping", description: "Answer pong" },
      ],
      error: null,
    });
    expect(mcp.authorizations.at(-1)).toBe("Bearer s3cret-token");
    const after = (await call(alice, "GET", `/v1/connectors/${id}`)).body;
    expect(after).toMatchObject({ status: "connected", tool_count: 2, error_message: null });
    expect(after.last_tested_at).toBeGreaterThan(0);

    mcp.token = "rotated";
    const failed = (await call(alice, "POST", `/v1/connectors/${id}/test`)).body;
    expect(failed).toMatchObject({ ok: false, tool_count: null, tools: [] });
    expect(failed.error).toBeTruthy();
    expect((await call(alice, "GET", `/v1/connectors/${id}`)).body.status).toBe("error");
  });

  it("an edit that leaves a secret blank keeps it; one that sends a value replaces it", async () => {
    const renamed = await call(alice, "PATCH", `/v1/connectors/${id}`, {
      display_name: "Catalogue",
      headers: [
        { key: "Authorization", secret: true, value: null }, // as the form sends an untouched secret
        { key: "X-Client", secret: false, value: "agent-base/2" },
      ],
    });
    expect(renamed.body).toMatchObject({
      display_name: "Catalogue",
      slug: "catalogue-tools",
      status: "untested",
      has_api_key: true,
    });
    mcp.token = "s3cret-token";
    expect((await call(alice, "POST", `/v1/connectors/${id}/test`)).body.ok).toBe(true);

    mcp.token = "rotated";
    await call(alice, "PATCH", `/v1/connectors/${id}`, {
      headers: [{ key: "Authorization", secret: true, value: "Bearer rotated" }],
    });
    expect((await call(alice, "POST", `/v1/connectors/${id}/test`)).body.ok).toBe(true);
    // Dropping the header drops its secret with it.
    await call(alice, "PATCH", `/v1/connectors/${id}`, { headers: [] });
    expect((await call(alice, "GET", `/v1/connectors/${id}`)).body.has_api_key).toBe(false);
    await call(alice, "PATCH", `/v1/connectors/${id}`, {
      headers: [{ key: "Authorization", secret: true, value: "Bearer rotated" }],
    });
  });

  it("is private until shared; `use` lets a colleague's agents call it without showing how it is set up", async () => {
    expect((await call(bob, "GET", "/v1/connectors")).body.connectors).toEqual([]);
    await call(alice, "PUT", `/v1/shares/connector/${id}`, {
      principal_type: "user",
      principal_id: bob.userId,
      permission: "use",
    });
    const seen = (await call(bob, "GET", "/v1/connectors/catalogue-tools")).body; // by slug
    expect(seen).toMatchObject({
      permission: "use",
      url: null,
      headers: [{ key: "Authorization", secret: true, value: null }],
      params: [{ key: "tenant", value: null }],
    });
    expect((await call(bob, "POST", `/v1/connectors/${id}/test`)).body.ok).toBe(true);
    expect((await call(bob, "PATCH", `/v1/connectors/${id}`, { display_name: "Mine" })).status).toBe(403);
    expect((await call(bob, "POST", `/v1/connectors/${id}/disable`)).status).toBe(403);
    expect((await call(bob, "DELETE", `/v1/connectors/${id}`)).status).toBe(403);
  });

  it("hands a turn the server definitions of the enabled connectors its agent names, secrets filled in", async () => {
    await call(alice, "POST", "/v1/connectors", {
      display_name: "Local Files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-mcp-server"],
      env: { API_KEY: "local-secret" },
    });
    const stdio = (await call(alice, "GET", "/v1/connectors/local-files")).body;
    expect(stdio).toMatchObject({ command: "npx", env: [{ key: "API_KEY", secret: true, value: null }] });
    expect((await call(alice, "POST", "/v1/connectors/local-files/test")).body).toMatchObject({
      ok: false,
      error: expect.stringContaining("run on a device"),
    });

    const servers = await serversFor(t.server.ctx, alice.orgId, ["catalogue-tools", "local-files", "gone"]);
    expect(servers).toEqual([
      {
        name: "catalogue-tools",
        transport: "http",
        url: `${mcp.url}?tenant=acme`,
        headers: { Authorization: "Bearer rotated" },
        tool_timeout_sec: null,
        server_instructions_trusted: false,
      },
      {
        name: "local-files",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp-server"],
        env: { API_KEY: "local-secret" },
        env_vars: [],
      },
    ]);

    await call(alice, "POST", `/v1/connectors/${id}/disable`);
    expect((await serversFor(t.server.ctx, alice.orgId, ["catalogue-tools"])).length).toBe(0);
    expect((await call(alice, "POST", `/v1/connectors/${id}/enable`)).body.enabled).toBe(true);
  });

  it("deleting a connector ends its shares", async () => {
    expect((await call(alice, "DELETE", `/v1/connectors/${id}`)).body).toEqual({ ok: true });
    expect((await call(bob, "GET", "/v1/connectors")).body.connectors).toEqual([]);
    const shares = await t.server.ctx.db
      .selectFrom("resource_shares")
      .select("id")
      .where("resource_id", "=", id)
      .execute();
    expect(shares).toEqual([]);
    // The directory says, for each, how it is signed in to and whether the member already has it.
    const recommended = (await call(alice, "GET", "/v1/connectors/recommended")).body.items as Json[];
    expect(recommended.map((item) => [item.slug, item.auth_type, item.installed])).toEqual([
      ["github", "oauth", false],
      ["linear", "oauth", false],
      ["notion", "oauth", false],
      ["firecrawl", "none", false],
    ]);
    // GitHub registers no clients itself: the member is asked for the one they made.
    expect(recommended[0].oauth_credentials_schema.map((field: Json) => field.key)).toEqual([
      "client_id",
      "client_secret",
    ]);
    expect(recommended[3].description).toContain("网页抓取");
  });
});

/**
 * A connector whose server asks for a sign-in. The authorization server and the MCP server are
 * stood in for (one process plays both); the flow through this server is the real one.
 */
describe("connectors that are signed in to (OAuth)", () => {
  let t: TestServer;
  let url: string;
  let mcp: TestMcpServer;
  let alice: Account;

  const call = (method: string, route: string, body?: object) =>
    t.call(method, route, { token: alice.token, ...(body ? { body } : {}) });
  /** What the person's browser does: follow the sign-in address to the callback, and load it. */
  const signInAt = async (authorizationUrl: string, extra = "") => {
    const asked = await fetch(`${authorizationUrl}${extra}`, { redirect: "manual" });
    const back = asked.headers.get("location") ?? "";
    const landed = await fetch(back);
    return { back, status: landed.status, page: await landed.text() };
  };
  const connector = async (id: string) => (await call("GET", `/v1/connectors/${id}`)).body as Json;

  beforeAll(async () => {
    mcp = await startMcpServer();
    mcp.oauth = { registration: true, expiresIn: 3600, clients: new Set(), accessTokens: new Set(), grants: [] };
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    url = await t.listen();
    // Where a browser is sent back to: this server, at the address it turned out to listen on.
    (t.server.ctx.config as { PUBLIC_URL: string }).PUBLIC_URL = url;
    alice = await signUp(t, "alice");
  });
  afterAll(async () => {
    await mcp?.stop();
    await t?.stop();
  });

  it("says what a server asks for before it is added", async () => {
    const found = (await call("POST", "/v1/connectors/discover", { url: mcp.url })).body;
    expect(found).toMatchObject({
      auth_type: "oauth",
      discovered: true,
      oauth_authorization_endpoint: expect.stringContaining("/authorize"),
      oauth_token_endpoint: expect.stringContaining("/token"),
      oauth_registration_endpoint: expect.stringContaining("/register"),
    });
    const plain = await startMcpServer();
    expect((await call("POST", "/v1/connectors/discover", { url: plain.url })).body).toMatchObject({
      auth_type: "none",
      discovered: false,
    });
    await plain.stop();
  });

  it("sends the member to sign in, takes them back, and is connected — the tokens never shown", async () => {
    const added = await call("POST", "/v1/connectors", {
      display_name: "Tracker",
      transport: "http",
      url: mcp.url,
      auth_type: "oauth",
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ slug: "tracker", needs_auth: true });
    const authorization = new URL(added.body.authorization_url);
    // Registered itself as a client, asks with PKCE, and wants the browser back at this server.
    expect(mcp.oauth?.clients.size).toBe(1);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${new URL(url).port}/v1/connectors/oauth/callback`,
    );
    expect(await connector(added.body.id)).toMatchObject({ auth_type: "oauth", status: "pending_auth" });

    const done = await signInAt(added.body.authorization_url);
    expect(done.status).toBe(200);
    expect(done.page).toContain("connector_oauth_success");
    const signed = await connector(added.body.id);
    expect(signed).toMatchObject({ status: "connected", tool_count: 2, error_message: null });
    expect(JSON.stringify(signed)).not.toMatch(/at-1|rt-1/);
    // The MCP server was reached with the token it issued.
    expect(mcp.authorizations.at(-1)).toBe("Bearer at-1");
    // The link is good once.
    expect((await fetch(done.back)).status).toBe(400);

    const tested = (await call("POST", `/v1/connectors/${added.body.id}/test`)).body;
    expect(tested).toMatchObject({ ok: true, tools: ["lookup", "ping"] });
  });

  it("notices by itself that a server asks for a sign-in, and adds one that does not as before", async () => {
    // Nothing said about how it authenticates: the server turned an empty-handed caller away and said where to sign in.
    const guessed = await call("POST", "/v1/connectors", { display_name: "Guessed", transport: "http", url: mcp.url });
    expect(guessed.body).toMatchObject({ needs_auth: true });
    expect(await connector(guessed.body.id)).toMatchObject({ auth_type: "oauth", status: "pending_auth" });
    const open = await startMcpServer();
    const plain = await call("POST", "/v1/connectors", { display_name: "Open", transport: "http", url: open.url });
    expect(plain.body).toMatchObject({ needs_auth: false, authorization_url: null });
    await open.stop();
  });

  it("renews a token that is about to run out, and asks for a new sign-in when it cannot", async () => {
    // Tokens that last a minute are inside the renewal margin from the start.
    (mcp.oauth as NonNullable<typeof mcp.oauth>).expiresIn = 60;
    const added = await call("POST", "/v1/connectors", {
      display_name: "Short lived",
      transport: "http",
      url: mcp.url,
      auth_type: "oauth",
    });
    await signInAt(added.body.authorization_url);
    const grantsBefore = mcp.oauth?.grants.length ?? 0;
    expect((await call("POST", `/v1/connectors/${added.body.id}/test`)).body.ok).toBe(true);
    expect(mcp.oauth?.grants.slice(grantsBefore).map((grant) => grant.grant_type)).toEqual(["refresh_token"]);
    // The renewed token is the one used, and the one kept.
    const used = mcp.authorizations.at(-1);
    expect(used).not.toBe("Bearer at-1");

    // The authorization server forgets the client: nothing can be renewed, and the token runs out.
    mcp.oauth?.clients.clear();
    mcp.oauth?.accessTokens.clear();
    const failed = (await call("POST", `/v1/connectors/${added.body.id}/test`)).body;
    expect(failed.ok).toBe(false);
    // Signing in again is asked for the same way as adding it, and keeps the connector it was.
    mcp.oauth?.clients.add("client-9");
    const again = await call("POST", "/v1/connectors", {
      slug: "short-lived",
      display_name: "Short lived",
      transport: "http",
      url: mcp.url,
      auth_type: "oauth",
      credentials: { client_id: "client-9" },
    });
    expect(again.body).toMatchObject({ id: added.body.id, needs_auth: true });
    expect(new URL(again.body.authorization_url).searchParams.get("client_id")).toBe("client-9");
    expect((await signInAt(again.body.authorization_url)).status).toBe(200);
    expect(await connector(added.body.id)).toMatchObject({ status: "connected" });
  });

  it("says so when the member refuses, when no client can be had, and when nobody can be asked", async () => {
    const added = await call("POST", "/v1/connectors", {
      display_name: "Refused",
      transport: "http",
      url: mcp.url,
      auth_type: "oauth",
    });
    const refused = await signInAt(added.body.authorization_url, "&deny=1");
    expect(refused.status).toBe(400);
    expect(refused.page).toContain("connector_oauth_error");
    expect(await connector(added.body.id)).toMatchObject({ status: "pending_auth", error_message: "the user refused" });

    // A server that registers no clients itself: the member must bring one, and nothing is left behind if not.
    (mcp.oauth as NonNullable<typeof mcp.oauth>).registration = false;
    const before = ((await call("GET", "/v1/connectors")).body.connectors as Json[]).length;
    const none = await call("POST", "/v1/connectors", {
      display_name: "No client",
      transport: "http",
      url: mcp.url,
      auth_type: "oauth",
    });
    expect([none.status, none.body.code]).toEqual([422, "oauth_client_required"]);
    expect(((await call("GET", "/v1/connectors")).body.connectors as Json[]).length).toBe(before);
    mcp.oauth?.clients.add("my-app");
    const brought = await call("POST", "/v1/connectors", {
      display_name: "Own client",
      transport: "http",
      url: mcp.url,
      auth_type: "oauth",
      credentials: { client_id: "my-app", client_secret: "shh" },
    });
    expect(new URL(brought.body.authorization_url).searchParams.get("client_id")).toBe("my-app");
    // The client's secret is for the authorization server: it is not sent to the MCP server as a header.
    expect((await connector(brought.body.id)).headers).toEqual([]);
    (mcp.oauth as NonNullable<typeof mcp.oauth>).registration = true;

    // A server that says nothing about signing in cannot be signed in to.
    const silent = await startMcpServer();
    const lost = await call("POST", "/v1/connectors", {
      display_name: "Silent",
      transport: "http",
      url: silent.url,
      auth_type: "oauth",
    });
    expect([lost.status, lost.body.code]).toEqual([502, "oauth_discovery_failed"]);
    await silent.stop();
    expect((await fetch(`${url}/v1/connectors/oauth/callback?code=x&state=made-up`)).status).toBe(400);
  });

  it("hands a turn the token, and leaves out a connector that must be signed in to again", async () => {
    const orgId = (await call("GET", "/v1/me")).body.current_org_id as string;
    const servers = await serversFor(t.server.ctx, orgId, ["tracker", "refused"]);
    // "refused" was never signed in to: it is not offered to the turn at all.
    expect(servers.map((server) => server.name)).toEqual(["tracker"]);
    expect(servers[0]).toMatchObject({
      url: mcp.url,
      headers: { Authorization: expect.stringMatching(/^Bearer at-/) },
    });
  });
});

describe("connectors on a server with default settings", () => {
  let t: TestServer;
  let mcp: TestMcpServer;
  beforeAll(async () => {
    t = await startTestServer();
    mcp = await startMcpServer();
  });
  afterAll(async () => {
    await mcp?.stop();
    await t?.stop();
  });

  it("will not test a server on a private network on a member's say-so", async () => {
    const mallory = await signUp(t, "mallory");
    const created = await t.call("POST", "/v1/connectors", {
      token: mallory.token,
      body: { display_name: "Inside", transport: "http", url: mcp.url },
    });
    const tested = await t.call("POST", `/v1/connectors/${created.body.id}/test`, { token: mallory.token });
    expect(tested.body).toMatchObject({ ok: false, error: expect.stringContaining("private network") });
    expect(mcp.authorizations).toEqual([]);
  });
});
