import { type ProviderUpstream, startProviderUpstream } from "@agent-base/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveSlug, ensureUniqueSlug, isValidSlug } from "../src/modules/agents/slug.ts";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

describe("agent slugs", () => {
  it("derives an ASCII handle from a display name, keeping case", () => {
    expect(deriveSlug("Market Analyst")).toBe("Market-Analyst");
    expect(deriveSlug("  data__pipeline   v2 ")).toBe("data-pipeline-v2");
    expect(deriveSlug("Café Müller")).toBe("Cafe-Muller");
    expect(deriveSlug("R&D (beta)!")).toBe("RD-beta");
    expect(deriveSlug("!!!")).toBe("agent");
  });

  it("gives names with nothing ASCII in them distinct, stable handles", () => {
    const analyst = deriveSlug("行情分析师");
    expect(analyst).toMatch(/^agent-[0-9a-f]{4}$/);
    expect(deriveSlug("行情分析师")).toBe(analyst);
    expect(deriveSlug("研究员")).not.toBe(analyst);
    // Mixed names keep their readable part.
    expect(deriveSlug("研究员 Alpha")).toBe("Alpha");
  });

  it("resolves collisions with a counter and validates supplied slugs", () => {
    expect(ensureUniqueSlug("Analyst", new Set())).toBe("Analyst");
    expect(ensureUniqueSlug("Analyst", new Set(["Analyst", "Analyst-2"]))).toBe("Analyst-3");
    expect(["Analyst-2", "a", "A1-b2"].every(isValidSlug)).toBe(true);
    expect(["", "-a", "a-", "a--b", "a b", "分析", "a/b", "x".repeat(121)].some(isValidSlug)).toBe(false);
  });
});

describe("agent library", () => {
  let t: TestServer;
  let vendor: ProviderUpstream;
  let alice: Account;
  let bob: Account;
  let channelId: string;

  const call = (account: Account, method: string, url: string, body?: object) =>
    t.call(method, url, { token: account.token, ...(body ? { body } : {}) });

  beforeAll(async () => {
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    vendor = await startProviderUpstream();
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
    const channel = await call(alice, "POST", "/v1/providers", {
      name: "Team channel",
      provider_kind: "compatible",
      api_key: vendor.apiKey,
      base_url: vendor.url,
      models: ["alpha-1"],
    });
    channelId = channel.body.id;
  });
  afterAll(async () => {
    await vendor?.stop();
    await t?.stop();
  });

  it("creates an agent from just a name, deriving its handle and filling the contract's defaults", async () => {
    const created = await call(alice, "POST", "/v1/agents", { name: "Market Analyst" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: "Market-Analyst",
      name: "Market Analyst",
      description: "",
      instructions: "",
      runtime: "claude_agent",
      model: "claude-sonnet-4-6",
      // No channel of its own on the Claude runtime: it runs on the device's login.
      provider_id: "ch-claude-subscription",
      effort: null,
      skills: [],
      connector_types: [],
      knowledge_scope: [],
      kind: "standard",
      resource_policy: "explicit",
      inherit_global_instructions: true,
      permission_mode: "full_access",
      source: "custom",
      readonly: false,
      deletable: true,
      permission: "admin",
      owner_name: "alice",
    });
    // The same name again gets the next free handle; a handle asked for by name must be free.
    expect((await call(alice, "POST", "/v1/agents", { name: "Market Analyst" })).body.slug).toBe("Market-Analyst-2");
    const taken = await call(alice, "POST", "/v1/agents", { name: "Other", slug: "Market-Analyst" });
    expect([taken.status, taken.body.code]).toEqual([409, "slug_taken"]);
    const invalid = await call(alice, "POST", "/v1/agents", { name: "Other", slug: "bad slug" });
    expect([invalid.status, invalid.body.code]).toEqual([400, "invalid_slug"]);
    expect((await call(alice, "POST", "/v1/agents", { name: "x", runtime: "nope" })).status).toBe(400);
  });

  it("gives an agent a brain and equipment, and changes only what an update sends", async () => {
    const created = await call(alice, "POST", "/v1/agents", {
      name: "研究员",
      slug: "researcher",
      description: "Reads filings",
      instructions: "Be thorough.",
      runtime: "deepagents",
      model: "alpha-1",
      provider_id: channelId,
      effort: "high",
      skills: ["dcf-model"],
      connector_types: ["market-data"],
      avatar: "owl",
    });
    expect(created.body).toMatchObject({ slug: "researcher", name: "研究员", provider_id: channelId, effort: "high" });

    const updated = await call(alice, "PATCH", "/v1/agents/researcher", {
      description: "Reads filings and transcripts",
      skills: ["dcf-model", "comps"],
      name: null, // "leave it"
    });
    expect(updated.body).toMatchObject({
      name: "研究员",
      description: "Reads filings and transcripts",
      skills: ["dcf-model", "comps"],
      connector_types: ["market-data"],
      instructions: "Be thorough.",
      avatar: "owl",
    });
    expect((await call(alice, "GET", "/v1/agents/researcher")).body).toEqual(updated.body);
    expect((await call(alice, "GET", "/v1/agents/nobody")).status).toBe(404);
  });

  it("is private until shared: `use` lets a colleague work with it, `edit` change it, only the owner delete it", async () => {
    expect((await call(bob, "GET", "/v1/agents")).body.agents).toEqual([]);
    expect((await call(bob, "GET", "/v1/agents/researcher")).status).toBe(404);

    const agent = (await call(alice, "GET", "/v1/agents/researcher")).body;
    const share = (permission: string) =>
      call(alice, "PUT", `/v1/shares/agent/${agent.id}`, { principal_type: "org", permission });
    await share("use");
    const seen = (await call(bob, "GET", "/v1/agents/researcher")).body;
    expect(seen).toMatchObject({ permission: "use", readonly: true, deletable: false, owner_name: "alice" });
    expect((await call(bob, "PATCH", "/v1/agents/researcher", { name: "Mine" })).status).toBe(403);

    await share("edit");
    expect((await call(bob, "PATCH", "/v1/agents/researcher", { instructions: "Be brief." })).body).toMatchObject({
      instructions: "Be brief.",
      readonly: false,
      deletable: false,
    });
    expect((await call(bob, "DELETE", "/v1/agents/researcher")).status).toBe(403);
    expect(
      (await call(bob, "GET", "/v1/agents?source=custom")).body.agents.map((a: { slug: string }) => a.slug),
    ).toEqual(["researcher"]);
    expect((await call(bob, "GET", "/v1/agents?source=official")).body.agents).toEqual([]);
    // A handle belongs to the organization even where its agent is not visible.
    const clash = await call(bob, "POST", "/v1/agents", { name: "Mine", slug: "Market-Analyst" });
    expect(clash.status).toBe(409);
  });

  it("only binds an agent to a model channel its author may use", async () => {
    const refused = await call(bob, "POST", "/v1/agents", { name: "Borrower", provider_id: channelId });
    expect(refused.status).toBe(404); // bob cannot see alice's channel at all
    expect((await call(bob, "PATCH", "/v1/agents/researcher", { provider_id: channelId })).status).toBe(404);
  });

  it("a copy belongs to whoever took it, and brings the channel only if they may use it", async () => {
    const copied = await call(bob, "POST", "/v1/agents/researcher/copy", {});
    expect(copied.status).toBe(201);
    expect(copied.body).toMatchObject({
      name: "研究员 (copy)",
      slug: "copy",
      instructions: "Be brief.",
      skills: ["dcf-model", "comps"],
      provider_id: null,
      permission: "admin",
      owner_name: "bob",
    });
    expect((await call(alice, "GET", `/v1/agents/${copied.body.slug}`)).body).toMatchObject({ permission: "admin" }); // org owner
    const named = await call(alice, "POST", "/v1/agents/researcher/copy", {
      name: "Researcher II",
      slug: "researcher-2",
    });
    expect(named.body).toMatchObject({ slug: "researcher-2", provider_id: channelId });
  });

  it("deleting an agent ends its shares; deleting its channel leaves the agent without one", async () => {
    expect((await call(alice, "GET", "/v1/agents/researcher/deployments")).body).toEqual({ deployments: [], count: 0 });
    expect((await call(alice, "DELETE", "/v1/agents/researcher")).status).toBe(204);
    expect((await call(bob, "GET", "/v1/agents/researcher")).status).toBe(404);
    const shares = await t.server.ctx.db
      .selectFrom("resource_shares")
      .select("id")
      .where("resource_type", "=", "agent")
      .execute();
    expect(shares).toEqual([]);

    await call(alice, "DELETE", `/v1/providers/${channelId}`);
    expect((await call(alice, "GET", "/v1/agents/researcher-2")).body.provider_id).toBeNull();
    const actions = (await call(alice, "GET", "/v1/org/audit-logs?limit=200")).body.logs.map(
      (l: { action: string }) => l.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["agent.create", "agent.update", "agent.delete"]));
  });
  it("has no 'all available' resource list: an agent uses what it names", async () => {
    const created = (await call(alice, "POST", "/v1/agents", { name: "Explicit one" })).body;
    const res = await call(alice, "GET", `/v1/agents/${created.slug}/effective-resources`);
    expect([res.status, res.body.code]).toEqual([409, "explicit_resources"]);
    expect((await call(alice, "GET", "/v1/agents/nobody/effective-resources")).status).toBe(404);
  });
});
