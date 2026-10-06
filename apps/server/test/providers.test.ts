import { type ProviderUpstream, startProviderUpstream } from "@agent-base/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credentials } from "../src/modules/providers/service.ts";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

describe("model channels", () => {
  let t: TestServer;
  let vendor: ProviderUpstream;
  let alice: Account; // adds the channel (also the organization's owner)
  let bob: Account;
  let channelId: string;

  const call = (account: Account, method: string, url: string, body?: object) =>
    t.call(method, url, { token: account.token, ...(body ? { body } : {}) });
  /** The channels a member added or was given — the two built-in subscription channels aside. */
  const added = async (account: Account) =>
    (await call(account, "GET", "/v1/providers")).body.providers.filter(
      (channel: { auth_type: string }) => channel.auth_type !== "oauth",
    );
  const add = (account: Account, body: object) => call(account, "POST", "/v1/providers", body);

  beforeAll(async () => {
    // The stand-in vendor listens on localhost, which the server refuses by default.
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    vendor = await startProviderUpstream();
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
  });
  afterAll(async () => {
    await vendor?.stop();
    await t?.stop();
  });

  it("offers the kinds of channel that can be added — subscription logins are a device matter, not the server's", async () => {
    const { body } = await call(alice, "GET", "/v1/providers/config");
    const kinds = body.providers.map((p: { kind: string }) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(["anthropic", "openai", "deepseek", "compatible"]));
    expect(kinds.some((kind: string) => kind.includes("subscription"))).toBe(false);
    expect(body.providers.find((p: { kind: string }) => p.kind === "deepseek")).toMatchObject({
      supports_protocol_selection: true,
      supports_custom_base_url: true,
      auth_type: "api_key",
    });
  });

  it("lists an upstream's models before anything is saved, and says why when the key is wrong", async () => {
    const probe = (api_key: string) =>
      call(alice, "POST", "/v1/providers/probe-models", { provider_kind: "deepseek", api_key, base_url: vendor.url });
    expect((await probe(vendor.apiKey)).body).toEqual({
      models: ["alpha-1", "beta-2"],
      model_labels: { "beta-2": "Beta Two" },
      suggested_default: "alpha-1",
    });
    const wrong = await probe("sk-wrong");
    expect([wrong.status, wrong.body.detail]).toEqual([422, "API Key 无效，请检查后重试"]);
    expect(await added(alice)).toEqual([]);
  });

  it("adds a channel only when the upstream accepts the key, and never gives the key back", async () => {
    const refused = await add(alice, {
      name: "Bad",
      provider_kind: "deepseek",
      api_key: "sk-wrong",
      base_url: vendor.url,
    });
    expect(refused.status).toBe(422);
    expect(await added(alice)).toEqual([]);
    expect((await add(alice, { name: "x", provider_kind: "nope", api_key: "k" })).status).toBe(400);

    const created = await add(alice, {
      name: "Team DeepSeek",
      provider_kind: "deepseek",
      api_key: vendor.apiKey,
      base_url: `${vendor.url}/`,
    });
    expect(created.status).toBe(201);
    channelId = created.body.id;
    expect(created.body).toMatchObject({
      name: "Team DeepSeek",
      source: "user",
      group: "api_key",
      enabled: true,
      deletable: true,
      default_model: "alpha-1",
      test_status: "success",
      credential_source: "secret_ref",
      effective_protocol: "anthropic",
      compatible_protocols: ["anthropic", "openai-completion", "openai-response"],
      base_url: `${vendor.url}/`,
      permission: "admin",
    });
    expect(created.body.models).toEqual([
      { id: "alpha-1", label: null, runtimes: ["claude_agent", "codex", "deepagents"], max_input_tokens: null },
      { id: "beta-2", label: "Beta Two", runtimes: ["claude_agent", "codex", "deepagents"], max_input_tokens: null },
    ]);
    expect(JSON.stringify(created.body)).not.toContain(vendor.apiKey);

    // At rest the key is sealed, and opens only for its purpose.
    const row = await t.server.ctx.db.selectFrom("providers").select("secret_enc").executeTakeFirstOrThrow();
    expect(row.secret_enc).toMatch(/^v1\./);
    expect(row.secret_enc).not.toContain(vendor.apiKey);
    expect(() => t.server.ctx.box.open("something-else", row.secret_enc as string)).toThrow();
  });

  it("is private to its owner until shared; `use` runs models through it without revealing where it points", async () => {
    expect(await added(bob)).toEqual([]);
    expect((await call(bob, "GET", `/v1/providers/${channelId}`)).status).toBe(404);
    expect((await call(bob, "GET", "/v1/providers/not-a-uuid")).status).toBe(404);

    await call(alice, "PUT", `/v1/shares/provider/${channelId}`, {
      principal_type: "user",
      principal_id: bob.userId,
      permission: "use",
    });
    const seen = (await call(bob, "GET", `/v1/providers/${channelId}`)).body;
    expect(seen).toMatchObject({ source: "org", group: "org", deletable: false, permission: "use", base_url: null });
    expect((await call(bob, "PATCH", `/v1/providers/${channelId}`, { name: "mine now" })).status).toBe(403);
    expect((await call(bob, "DELETE", `/v1/providers/${channelId}`)).status).toBe(403);
    expect((await call(bob, "POST", `/v1/providers/${channelId}/test`)).body).toMatchObject({ success: true });

    // The kernel is handed the key on bob's behalf; an outsider to the share is not.
    const auth = { userId: bob.userId, orgId: bob.orgId, role: "member" as const, name: "bob" };
    expect(await credentials(t.server.ctx, auth, channelId)).toMatchObject({
      api_key: vendor.apiKey,
      default_model: "alpha-1",
    });
    const stranger = await signUp(t, "stranger");
    expect((await call(stranger, "GET", `/v1/providers/${channelId}`)).status).toBe(404);
  });

  it("keeps each member's default apart, and offers the picker every model with a runtime it can run on", async () => {
    expect((await call(bob, "GET", "/v1/settings/model-defaults")).body).toEqual({
      default_runtime: "claude_agent",
      default_provider_id: null,
      default_model: null,
      default_effort: "high",
    });
    const set = await call(bob, "POST", "/v1/providers/default", { provider_id: channelId, default_model: "beta-2" });
    expect(set.body).toEqual({ provider_id: channelId, message: "Default provider updated" });
    expect((await call(bob, "GET", `/v1/providers/${channelId}`)).body.is_default).toBe(true);
    expect((await call(alice, "GET", `/v1/providers/${channelId}`)).body.is_default).toBe(false);

    const options = (await call(bob, "GET", "/v1/settings/model-options")).body;
    expect(options.current).toEqual({ runtime: "claude_agent", provider_id: channelId, model: "beta-2" });
    expect(options.groups.map((group: { key: string }) => group.key)).toEqual(["subscription", "org"]);
    const shared = options.groups[1];
    expect(shared).toMatchObject({
      key: "org",
      providers: [{ label: "Team DeepSeek", status: "available" }],
    });
    expect(shared.providers[0].models).toEqual([
      expect.objectContaining({
        model_id: "alpha-1",
        label: "alpha-1",
        default_runtime: "claude_agent",
        is_current_default: false,
      }),
      expect.objectContaining({ model_id: "beta-2", label: "Beta Two", is_current_default: true }),
    ]);

    const patched = await call(bob, "PATCH", "/v1/settings/model-defaults", {
      default_effort: "max",
      default_runtime: "codex",
    });
    expect(patched.body).toMatchObject({ default_effort: "max", default_runtime: "codex", default_model: "beta-2" });
    expect((await call(bob, "PATCH", "/v1/settings/model-defaults", { default_effort: "ludicrous" })).status).toBe(400);
  });

  it("offers the Claude and Codex subscriptions as built-in channels that hold nothing: the device's login is the key", async () => {
    const carol = await joinOrg(t, alice, "carol");
    const channels = (await call(carol, "GET", "/v1/providers")).body.providers;
    expect(channels.map((c: { id: string }) => c.id)).toEqual(["ch-claude-subscription", "ch-codex-subscription"]);
    expect(channels[0]).toMatchObject({
      provider_kind: "claude-subscription",
      auth_type: "oauth",
      enabled: true,
      credential_source: "cli_keychain",
      deletable: false,
      effective_protocol: "anthropic",
      default_model: "claude-sonnet-4-6",
    });
    expect(channels[0].models[0]).toMatchObject({ runtimes: ["claude_agent"] });
    expect(channels[1].models.every((m: { runtimes: string[] }) => m.runtimes[0] === "codex")).toBe(true);

    // It can be a member's default; the runtime follows it.
    await call(carol, "PATCH", "/v1/settings/model-defaults", { default_runtime: "claude_agent" });
    const set = await call(carol, "POST", "/v1/providers/default", { provider_id: "ch-codex-subscription" });
    expect(set.status).toBe(200);
    expect((await call(carol, "GET", "/v1/settings/model-defaults")).body).toMatchObject({
      default_provider_id: "ch-codex-subscription",
      default_model: "gpt-5.5",
      default_runtime: "codex",
    });
    expect((await call(carol, "GET", "/v1/providers/ch-codex-subscription")).body.is_default).toBe(true);
    const picker = (await call(carol, "GET", "/v1/settings/model-options")).body;
    expect(picker.groups[0]).toMatchObject({ key: "subscription" });
    expect(picker.groups[0].providers.map((p: { status: string }) => p.status)).toEqual(["available", "available"]);

    // Switched off and on by the member; never deleted, and there is nothing to test or edit.
    const off = await call(carol, "PATCH", "/v1/providers/ch-claude-subscription", { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, credential_source: "none" });
    expect((await call(alice, "GET", "/v1/providers/ch-claude-subscription")).body.enabled).toBe(true); // hers alone
    expect((await call(carol, "POST", "/v1/providers/ch-claude-subscription/enable")).body).toMatchObject({
      enabled: true,
      credential_source: "cli_keychain",
    });
    expect((await call(carol, "DELETE", "/v1/providers/ch-claude-subscription")).status).toBe(403);
  });

  it("a custom endpoint takes the model ids its owner names, and checks which of them really answer", async () => {
    const ping = await call(alice, "POST", "/v1/providers/ping", {
      base_url: vendor.url,
      api_key: vendor.apiKey,
      models: ["alpha-1", "typo-9"],
    });
    expect(ping.body.ok).toEqual(["alpha-1"]);
    expect(ping.body.failed).toEqual([
      { model: "typo-9", reason: expect.stringContaining("模型「typo-9」可能不存在") },
    ]);

    const noModels = await add(alice, {
      name: "Custom",
      provider_kind: "compatible",
      api_key: vendor.apiKey,
      base_url: vendor.url,
    });
    expect([noModels.status, noModels.body.detail]).toEqual([422, "至少需要 1 个模型 id"]);
    const custom = await add(alice, {
      name: "Custom",
      provider_kind: "compatible",
      api_key: vendor.apiKey,
      base_url: vendor.url,
      models: ["beta-2", "alpha-1"],
    });
    expect(custom.status).toBe(201);
    expect(custom.body).toMatchObject({ default_model: "beta-2", compatible_protocols: ["openai-completion"] });
    expect(custom.body.models.map((m: { id: string; runtimes: string[] }) => [m.id, m.runtimes])).toEqual([
      ["beta-2", ["deepagents"]],
      ["alpha-1", ["deepagents"]],
    ]);

    // Re-testing a saved channel needs no key; the stored one is used.
    const again = await call(alice, "POST", "/v1/providers/ping", {
      base_url: vendor.url,
      provider_id: custom.body.id,
      models: ["alpha-1"],
    });
    expect(again.body).toEqual({ ok: ["alpha-1"], failed: [] });

    // The Anthropic shape is spoken too, through the vendor's own SDK path.
    const anthropic = await call(alice, "POST", "/v1/providers/ping", {
      base_url: vendor.url,
      api_key: vendor.apiKey,
      protocol: "anthropic",
      models: ["alpha-1"],
    });
    expect(anthropic.body.ok).toEqual(["alpha-1"]);
    expect(vendor.hits).toContain("POST /v1/messages");

    // A gateway's own model names say nothing about their size: the owner declares the input window.
    const windows = (body: { models: { id: string; max_input_tokens: number | null }[] }) =>
      Object.fromEntries(body.models.map((model) => [model.id, model.max_input_tokens]));
    expect(windows(custom.body)).toEqual({ "beta-2": null, "alpha-1": null });
    const declared = await call(alice, "PATCH", `/v1/providers/${custom.body.id}`, {
      model_limits: { "beta-2": 32_000, "no-such-model": 8000 },
    });
    expect(windows(declared.body)).toEqual({ "beta-2": 32_000, "alpha-1": null });
    // Rewriting the model list keeps what its models had; 0 withdraws a declaration.
    const relisted = await call(alice, "PATCH", `/v1/providers/${custom.body.id}`, { models: ["alpha-1", "beta-2"] });
    expect(windows(relisted.body)).toEqual({ "alpha-1": null, "beta-2": 32_000 });
    const cleared = await call(alice, "PATCH", `/v1/providers/${custom.body.id}`, { model_limits: { "beta-2": 0 } });
    expect(windows(cleared.body)).toEqual({ "alpha-1": null, "beta-2": null });
  });

  it("catches an upstream that answers with a different model than the one asked for", async () => {
    vendor.substituteWith = "house-default";
    const ping = await call(alice, "POST", "/v1/providers/ping", {
      base_url: vendor.url,
      api_key: vendor.apiKey,
      models: ["alpha-1"],
    });
    vendor.substituteWith = null;
    expect(ping.body.ok).toEqual([]);
    expect(ping.body.failed[0].reason).toContain("上游返回了模型「house-default」而非请求的「alpha-1」");
  });

  it("refreshes the model list from the upstream, and re-checks the key when it is replaced", async () => {
    vendor.models.push({ id: "gamma-3" });
    const refreshed = await call(alice, "POST", `/v1/providers/${channelId}/discover-models`);
    expect(refreshed.body).toMatchObject({
      discovered: ["alpha-1", "beta-2", "gamma-3"],
      merged: ["alpha-1", "beta-2", "gamma-3"],
    });

    const bad = await call(alice, "PATCH", `/v1/providers/${channelId}`, { api_key: "sk-wrong" });
    expect(bad.status).toBe(422);
    // The refused key did not replace the working one.
    expect((await call(alice, "POST", `/v1/providers/${channelId}/test`)).body.success).toBe(true);

    const renamed = await call(alice, "PATCH", `/v1/providers/${channelId}`, {
      name: "DeepSeek (team)",
      default_model: "gamma-3",
    });
    expect(renamed.body).toMatchObject({ name: "DeepSeek (team)", default_model: "gamma-3" });

    vendor.apiKey = "sk-rotated";
    const failing = await call(alice, "POST", `/v1/providers/${channelId}/test`);
    expect(failing.body).toEqual({ success: false, latency_ms: null, error_message: "API Key 无效，请检查后重试" });
    expect((await call(alice, "GET", `/v1/providers/${channelId}`)).body.test_status).toBe("failed");
    expect((await call(alice, "PATCH", `/v1/providers/${channelId}`, { api_key: "sk-rotated" })).body.test_status).toBe(
      "success",
    );

    const logs = (await call(alice, "GET", "/v1/org/audit-logs?limit=200")).body.logs;
    const updates = logs.filter((l: { action: string }) => l.action === "provider.update");
    expect(updates.map((l: { detail: { fields: string[] } }) => l.detail.fields)).toContainEqual(
      expect.arrayContaining(["api_key"]),
    );
    expect(JSON.stringify(logs)).not.toContain("sk-rotated");
  });

  it("deleting a channel ends its shares, and a default that pointed at it reads as unset", async () => {
    expect((await call(alice, "DELETE", `/v1/providers/${channelId}`)).status).toBe(204);
    expect(await added(bob)).toEqual([]);
    expect((await call(bob, "GET", "/v1/settings/model-defaults")).body).toMatchObject({
      default_provider_id: null,
      default_model: null,
      default_effort: "max",
    });
    const shares = await t.server.ctx.db
      .selectFrom("resource_shares")
      .select("id")
      .where("resource_type", "=", "provider")
      .execute();
    expect(shares).toEqual([]);
  });

  it("keeps personal preferences per member, with verification tied to citations", async () => {
    const initial = (await call(alice, "GET", "/v1/settings/preferences")).body;
    expect(initial).toMatchObject({ default_locale: "zh-CN", theme: "light", conversation_citations_enabled: true });
    expect(initial.detected_timezone).toBeTruthy();
    const on = await call(alice, "PATCH", "/v1/settings/preferences", {
      theme: "dark",
      conversation_verification_enabled: true,
    });
    expect(on.body).toMatchObject({ theme: "dark", conversation_verification_enabled: true });
    const off = await call(alice, "PATCH", "/v1/settings/preferences", {
      conversation_citations_enabled: false,
      theme: null,
    });
    expect(off.body).toMatchObject({
      theme: "light",
      conversation_citations_enabled: false,
      conversation_verification_enabled: false,
    });
    expect((await call(bob, "GET", "/v1/settings/preferences")).body.conversation_citations_enabled).toBe(true);
  });
});

describe("model channels on a server with default settings", () => {
  let t: TestServer;
  let vendor: ProviderUpstream;
  beforeAll(async () => {
    t = await startTestServer();
    vendor = await startProviderUpstream();
  });
  afterAll(async () => {
    await vendor?.stop();
    await t?.stop();
  });

  it("will not call an endpoint on a private network on a member's say-so", async () => {
    const mallory = await signUp(t, "mallory");
    for (const base_url of [
      vendor.url,
      "http://169.254.169.254/latest",
      "http://[::1]:8080/v1",
      "file:///etc/passwd",
    ]) {
      const res = await t.call("POST", "/v1/providers/probe-models", {
        token: mallory.token,
        body: { provider_kind: "deepseek", api_key: "k", base_url },
      });
      expect([base_url, res.status]).toEqual([base_url, 422]);
      expect(res.body.detail).toMatch(/^Endpoint 不可用/);
    }
    expect(vendor.hits).toEqual([]);
  });
});
