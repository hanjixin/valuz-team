import { type MarketIndex, type ModelGateway, startMarketIndex, startModelGateway } from "@agent-base/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * The marketplace: what a market index offers, seen against the member's own
 * library and installed into it. The index is stood in for.
 */
describe("marketplace", () => {
  let t: TestServer;
  let index: MarketIndex;
  let model: ModelGateway;
  let alice: Account;
  let bob: Account;

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const items = async (account: Account, type: string) =>
    (await call(account, "GET", `/v1/marketplace/items?type=${type}`)).body as Json;
  const install = (account: Account, id: string) => call(account, "POST", `/v1/marketplace/items/${id}:install`);
  const slugs = async (account: Account, what: "skills" | "agents") =>
    ((await call(account, "GET", `/v1/${what}`)).body[what] as Json[])
      .filter((entry) => entry.source !== "builtin")
      .map((entry) => entry.slug)
      .sort();

  beforeAll(async () => {
    index = await startMarketIndex();
    model = await startModelGateway();
    // The first address answers nothing: the next one is used.
    t = await startTestServer({
      ALLOW_PRIVATE_UPSTREAMS: "1",
      MARKETPLACE_INDEX_URLS: `http://127.0.0.1:9,${index.url}`,
    });
    await t.listen();
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
  });
  afterAll(async () => {
    await t?.stop();
    await index?.stop();
    await model?.stop();
  });

  it("shows what the index offers, and what of it the member already has", async () => {
    expect((await call(alice, "GET", "/v1/marketplace/categories?kind=skill")).body.categories).toEqual([
      { key: "development", label: "开发编程", count: 2, subcategories: [] },
    ]);
    const skills = await items(alice, "skill");
    expect(skills).toMatchObject({ total: 2, degraded: false });
    expect(skills.items.map((item: Json) => [item.id, item.installed])).toEqual([
      ["market:skill:code-review", false],
      ["market:skill:release-notes", false],
    ]);
    expect((await items(alice, "agent_team_template")).items[0].members).toHaveLength(2);
    // Plugin bundles are not provided: asked for, there are none — and the index is not troubled.
    const before = index.requests.length;
    expect(await items(alice, "plugin")).toMatchObject({ items: [], total: 0, degraded: false });
    expect((await call(alice, "GET", "/v1/marketplace/categories?kind=plugin")).body.categories).toEqual([]);
    expect(index.requests).toHaveLength(before);

    // Automation templates are browsed like the rest; using one opens the builder, filled in from what it carries.
    expect((await call(alice, "GET", "/v1/marketplace/categories?kind=automation")).body.categories).toHaveLength(1);
    const templates = await items(alice, "automation_template");
    expect(templates.items.map((item: Json) => [item.id, item.install_target])).toEqual([
      ["market:automation:weekly-digest", "automation_builder"],
    ]);
    const template = (await call(alice, "GET", "/v1/marketplace/items/market:automation:weekly-digest")).body;
    expect(template.install_manifest).toMatchObject({
      prompt_template: { "zh-CN": "整理本周的要点，列出下一步。" },
      trigger: { kind: "cron", cron_expr: "0 9 * * 1", timezone: "Asia/Shanghai" },
      action_kind: "chat",
    });
    expect((await install(alice, "market:automation:weekly-digest")).body.code).toBe("not_installable");

    const detail = (await call(alice, "GET", "/v1/marketplace/items/market:connector:task-master")).body;
    expect(detail.connector_config).toMatchObject({ transport: "stdio", command: "npx" });
    expect((await call(alice, "GET", "/v1/marketplace/items/market:skill:nope")).status).toBe(404);
  });

  it("installs a skill under its market name, once, as the member's own", async () => {
    const first = await install(alice, "market:skill:code-review");
    expect(first.body).toMatchObject({ status: "installed", installed_ref: "code-review" });
    expect((await install(alice, "market:skill:code-review")).body.status).toBe("already_installed");
    expect(await slugs(alice, "skills")).toEqual(["code-review"]);

    const skill = (await call(alice, "GET", "/v1/skills/code-review")).body;
    expect(skill).toMatchObject({ name: "code-review", description: "The code-review skill.", readonly: false });
    // The package's one folder is unwrapped, and what is not text is left behind.
    const paths = JSON.stringify((await call(alice, "GET", "/v1/skills/code-review/files")).body);
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("notes.md");
    expect(paths).not.toContain("logo.png");

    expect((await items(alice, "skill")).items[0]).toMatchObject({ id: "market:skill:code-review", installed: true });
    // It is alice's: bob has not got it, and the market tells him so.
    expect((await items(bob, "skill")).items[0].installed).toBe(false);
    expect((await call(alice, "GET", "/v1/marketplace/items/market:skill:code-review")).body.installed).toBe(true);
  });

  it("installs an agent with the skills it names, and a team role by role", async () => {
    // An agent needs something to run on before one is made.
    expect((await install(bob, "market:agent:reviewer")).body.code).toBe("no_model_channel");
    const channel = (
      await call(alice, "POST", "/v1/providers", {
        name: "Gateway",
        provider_kind: "compatible",
        api_key: "sk",
        base_url: model.url,
        models: ["test-model"],
      })
    ).body;
    await call(alice, "POST", "/v1/providers/default", { provider_id: channel.id });

    const agent = await install(alice, "market:agent:reviewer");
    expect(agent.body).toMatchObject({ status: "installed", installed_ref: "reviewer" });
    // The skill it names that the market has is there; the one nobody has is left out.
    expect((await call(alice, "GET", "/v1/agents/reviewer")).body).toMatchObject({
      name: "代码审查员",
      description: "审查代码",
      instructions: "你是代码审查员。",
      skills: ["code-review"],
    });
    expect((await install(alice, "market:agent:reviewer")).body.status).toBe("already_installed");

    const team = await install(alice, "market:team:release-crew");
    expect(team.body).toMatchObject({ status: "installed", installed_ref: "release-crew", created: 2, skipped: 0 });
    expect(await slugs(alice, "agents")).toEqual(["rc-lead", "rc-writer", "reviewer"]);
    expect(await slugs(alice, "skills")).toEqual(["code-review", "release-notes"]);
    expect((await call(alice, "GET", "/v1/agents/rc-writer")).body.skills).toEqual(["release-notes"]);
    expect((await install(alice, "market:team:release-crew")).body).toMatchObject({
      status: "already_installed",
      created: 0,
      skipped: 2,
    });
    expect((await items(alice, "agent_team_template")).items[0].installed).toBe(true);
    expect((await install(alice, "market:connector:task-master")).body.code).toBe("not_installable");
  });

  it("degrades to an empty market when the index is down, rather than failing the page", async () => {
    index.down = true;
    // What was fetched a moment ago is still shown…
    expect((await items(alice, "skill")).total).toBe(2);
    // …what was not is empty and marked so.
    expect(await items(alice, "connector")).toMatchObject({ items: [], degraded: true });
    expect((await call(alice, "GET", "/v1/marketplace/categories?kind=agent")).body).toEqual({
      categories: [],
      degraded: true,
    });
    const detail = await call(alice, "GET", "/v1/marketplace/items/market:skill:release-notes-2");
    expect([detail.status, detail.body.code]).toEqual([502, "marketplace_unavailable"]);
  });
});
