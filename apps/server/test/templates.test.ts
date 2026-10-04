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
    // The built-in assistant is not made by the tour: it is there, channel or not.
    expect((await call(alice, "POST", "/v1/onboarding/assistant")).body).toEqual({ agent_slug: "valurion" });
    expect((await call(alice, "GET", "/v1/agents?source=custom")).body.agents).toEqual([]);
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
    expect((await call(alice, "GET", "/v1/agents?source=custom")).body.agents).toHaveLength(4);
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
    expect((await call(alice, "GET", "/v1/agents/valurion")).body).toMatchObject({ name: "小万", effort: "high" });

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
  it("carries agents and their skills to a colleague as one file", async () => {
    const skill = (
      await call(alice, "POST", "/v1/skills", {
        name: "House style",
        description: "How we write",
        instructions_markdown: "# House style\n\nShort sentences.",
      })
    ).body;
    await call(alice, "POST", "/v1/agents", {
      name: "Editor",
      slug: "editor",
      description: "Edits copy",
      instructions: "You edit copy.",
      skills: [skill.slug],
      connector_types: ["github"],
    });
    const exported = await t.server.app.inject({
      method: "POST",
      url: "/v1/agent-packs/export",
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { agent_slugs: ["editor"], collection: { name: "Editorial" } },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toBe("application/zip");
    expect(exported.headers["content-disposition"]).toContain("editor.valuzpack");
    expect((await call(alice, "POST", "/v1/agent-packs/export", { agent_slugs: ["nobody"] })).status).toBe(404);
    // Nothing of the channel travels with it.
    expect(exported.rawPayload.toString("latin1")).not.toContain("provider_id");

    const url = await t.listen();
    const upload = async (account: Account, bytes: Uint8Array) => {
      const form = new FormData();
      form.append("file", new Blob([bytes]), "editor.valuzpack");
      const res = await fetch(`${url}/v1/agent-packs/import`, {
        method: "POST",
        headers: { authorization: `Bearer ${account.token}` },
        body: form,
      });
      return { status: res.status, body: (await res.json()) as Json };
    };
    expect((await upload(bob, new TextEncoder().encode("not a zip"))).body.code).toBe("invalid_pack");

    const preview = await upload(bob, exported.rawPayload);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      collection: { name: "Editorial" },
      agents: [{ slug: "editor", name: "Editor", in_library: false }],
      skills: [{ slug: skill.slug, source: "embedded" }],
      connectors: [{ slug: "github", already_present: false, requires_setup: true }],
    });
    // Looking changed nothing.
    expect((await call(bob, "GET", "/v1/agents?source=custom")).body.agents).toHaveLength(4);

    const imported = (
      await call(bob, "POST", "/v1/agent-packs/import/confirm", { preview_id: preview.body.preview_id })
    ).body;
    expect(imported).toMatchObject({ created: 1, skipped: 0, connectors_to_configure: [{ slug: "github" }] });
    const editor = imported.roles[0];
    expect(editor).toMatchObject({
      name: "Editor",
      instructions: "You edit copy.",
      owner_id: bob.userId,
      model: "test-model",
    });
    expect(editor.slug).toBe(`editor-${bob.userId.slice(0, 6)}`); // Alice holds the plain slug
    // The skill came along as Bob's own copy, and the agent carries that copy.
    expect(editor.skills).toHaveLength(1);
    const copy = (await call(bob, "GET", `/v1/skills/${editor.skills[0]}`)).body;
    expect(copy).toMatchObject({ name: "House style" });
    expect(editor.skills[0]).not.toBe(skill.slug);

    // A preview is confirmed once; importing the same pack again adds nothing.
    const reused = await call(bob, "POST", "/v1/agent-packs/import/confirm", { preview_id: preview.body.preview_id });
    expect([reused.status, reused.body.code]).toEqual([400, "preview_expired"]);
    const second = await upload(bob, exported.rawPayload);
    expect(second.body.agents[0].in_library).toBe(true);
    const again = (await call(bob, "POST", "/v1/agent-packs/import/confirm", { preview_id: second.body.preview_id }))
      .body;
    expect(again).toMatchObject({ created: 0, skipped: 1 });
    expect(
      (await call(bob, "GET", "/v1/skills")).body.skills.filter((s: { source: string }) => s.source !== "builtin"),
    ).toHaveLength(1);
  });
  it("works for a member whose default is a subscription: the roles run on the device's own login", async () => {
    const dana = await joinOrg(t, alice, "dana");
    await call(dana, "POST", "/v1/providers/default", { provider_id: "ch-claude-subscription" });
    const project = await call(dana, "POST", "/v1/onboarding/example-project", { team_id: "content" });
    expect(project.status).toBe(200);
    const added = (await call(dana, "POST", "/v1/agent-templates/content:add")).body;
    expect(added).toMatchObject({ created: 0, skipped: 4 });
    expect(added.roles[0]).toMatchObject({
      runtime: "claude_agent",
      provider_id: "ch-claude-subscription",
      model: "claude-sonnet-4-6",
    });
    expect((await call(dana, "POST", "/v1/onboarding/assistant")).body).toEqual({ agent_slug: "valurion" });
    // Editing an agent onto the other subscription moves its runtime with it.
    const moved = await call(dana, "PATCH", `/v1/agents/${added.roles[0].slug}`, {
      provider_id: "ch-codex-subscription",
    });
    expect(moved.body).toMatchObject({ runtime: "codex", provider_id: "ch-codex-subscription" });
  });
});
