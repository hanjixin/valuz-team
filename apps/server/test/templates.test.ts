import { type ModelGateway, startModelGateway } from "@agent-base/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Ready-made teams a member copies into their library, and what the first-run tour does with them. */
describe("agent templates and the first-run tour", () => {
  let t: TestServer;
  let model: ModelGateway;
  let alice: Account;
  let bob: Account;

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const template = async (account: Account, id: string) =>
    (await call(account, "GET", "/v1/agent-templates")).body.templates.find((item: Json) => item.id === id);
  const addChannel = async (account: Account) => {
    const channel = (
      await call(account, "POST", "/v1/providers", {
        name: "Gateway",
        provider_kind: "compatible",
        api_key: "sk",
        base_url: model.url,
        models: ["test-model"],
      })
    ).body;
    await call(account, "POST", "/v1/providers/default", { provider_id: channel.id });
    return channel.id as string;
  };

  beforeAll(async () => {
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    model = await startModelGateway();
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
  });
  afterAll(async () => {
    await model?.stop();
    await t?.stop();
  });

  it("lists the bundled teams in the member's language, each role with its instructions", async () => {
    const templates = (await call(alice, "GET", "/v1/agent-templates")).body.templates;
    expect(templates).toHaveLength(24);
    const content = templates.find((item: Json) => item.id === "content");
    expect(content).toMatchObject({ name: "小红书内容创作", scenario: "内容创作", added: false });
    expect(content.roles.map((role: Json) => [role.slug, role.name, role.in_library])).toEqual([
      ["xhs-topic-planner", "选题策划", false],
      ["xhs-note-writer", expect.any(String), false],
      ["xhs-visual-designer", expect.any(String), false],
      ["xhs-publisher", expect.any(String), false],
    ]);
    expect(content.roles[0].instructions).toContain("你是小红书选题策划");

    await call(alice, "PATCH", "/v1/settings/preferences", { default_locale: "en-US" });
    expect(await template(alice, "content")).toMatchObject({ name: "Xiaohongshu Content" });
    await call(alice, "PATCH", "/v1/settings/preferences", { default_locale: "zh-CN" });
  });

  it("needs a model channel before it can make agents", async () => {
    const refused = await call(alice, "POST", "/v1/agent-templates/content:add");
    expect([refused.status, refused.body.code]).toEqual([422, "no_model_channel"]);
    expect((await call(alice, "POST", "/v1/onboarding/assistant")).status).toBe(422);
    expect((await call(alice, "GET", "/v1/agents")).body.agents).toEqual([]);
    expect((await call(alice, "POST", "/v1/agent-templates/nope:add")).status).toBe(404);
  });

  it("copies a team into the library once: adding again changes nothing", async () => {
    const channelId = await addChannel(alice);
    const added = (await call(alice, "POST", "/v1/agent-templates/content:add")).body;
    expect(added).toMatchObject({ template_id: "content", created: 4, skipped: 0 });
    expect(added.roles[0]).toMatchObject({
      slug: "xhs-topic-planner",
      name: "选题策划",
      provider_id: channelId,
      model: "test-model",
      owner_id: alice.userId,
    });
    expect(added.roles[0].instructions).toContain("你是小红书选题策划");
    expect((await call(alice, "POST", "/v1/agent-templates/content:add")).body).toMatchObject({
      created: 0,
      skipped: 4,
    });
    expect(await template(alice, "content")).toMatchObject({ added: true });
    expect((await call(alice, "GET", "/v1/agents")).body.agents).toHaveLength(4);
  });

  it("gives a colleague their own copies, under slugs of their own", async () => {
    await addChannel(bob);
    expect(await template(bob, "content")).toMatchObject({ added: false }); // Alice's are not shared with him
    const added = (await call(bob, "POST", "/v1/agent-templates/content:add")).body;
    expect(added).toMatchObject({ created: 4, skipped: 0 });
    expect(added.roles[0].slug).toBe(`xhs-topic-planner-${bob.userId.slice(0, 6)}`);
    expect(added.roles[0].owner_id).toBe(bob.userId);
    expect((await call(bob, "POST", "/v1/agent-templates/content:add")).body).toMatchObject({ created: 0, skipped: 4 });
    expect(await template(bob, "content")).toMatchObject({ added: true });
  });

  it("ends the tour with a general assistant, or with a team in an example project", async () => {
    const assistant = (await call(alice, "POST", "/v1/onboarding/assistant")).body;
    expect(assistant).toEqual({ agent_slug: "valurion" });
    expect((await call(alice, "POST", "/v1/onboarding/assistant")).body).toEqual(assistant);
    expect((await call(alice, "GET", "/v1/agents/valurion")).body).toMatchObject({ name: "Valurion", effort: "high" });

    const first = await call(alice, "POST", "/v1/onboarding/example-project", { team_id: "development-engineering" });
    expect(first.status).toBe(200);
    expect(first.body.project_name).toBe("示例项目");
    const project = (await call(alice, "GET", `/v1/projects/${first.body.project_id}`)).body;
    expect(project).toMatchObject({ name: "示例项目", default_lead_agent_slug: "eng-feature-developer" });
    const team = (await call(alice, "GET", `/v1/projects/${first.body.project_id}/agents`)).body.agents;
    expect(team.map((entry: Json) => entry.member.agent_slug)).toEqual([
      "eng-feature-developer",
      "eng-refactoring-specialist",
      "eng-code-reviewer",
      "eng-bug-fixer",
    ]);
    // Running the tour again finds the same project and adds nobody twice.
    const again = await call(alice, "POST", "/v1/onboarding/example-project", { team_id: "development-engineering" });
    expect(again.body.project_id).toBe(first.body.project_id);
    expect((await call(alice, "GET", `/v1/projects/${first.body.project_id}/agents`)).body.agents).toHaveLength(4);
    expect((await call(alice, "POST", "/v1/onboarding/example-project", { team_id: "nope" })).status).toBe(400);
  });
});
