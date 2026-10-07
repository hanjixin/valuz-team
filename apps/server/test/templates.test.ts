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
  it("carries a project to a colleague as one file: its instructions, team, automations, connectors and memory", async () => {
    const project = (await call(alice, "POST", "/v1/projects", { name: "Newsroom" })).body;
    await call(
      alice,
      "PUT",
      `/v1/projects/${project.id}/instructions?instructions_md=${encodeURIComponent("Write for a general reader.")}`,
    );
    const deployed = await call(alice, "POST", `/v1/projects/${project.id}/agents:deploy`, {
      source_agent_slug: "editor",
      agent_slug: "desk-editor",
    });
    expect(deployed.status).toBe(201);
    await call(alice, "PUT", `/v1/projects/${project.id}/connectors`, { slugs: ["wire-service"] });
    const automation = await call(alice, "POST", "/v1/automations", {
      name: "Morning digest",
      project_kind: "project",
      project_id: project.id,
      agent_kind: "project_member",
      agent_slug: "desk-editor",
      prompt_template: "Summarize overnight news.",
      trigger: { kind: "cron", cron_expr: "0 7 * * 1-5", timezone: "Asia/Shanghai" },
      action_kind: "chat",
    });
    expect(automation.status).toBe(201);

    const exported = await t.server.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/export`,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("Newsroom.valuzpack");
    // No channel and no file of the project's folder travels with it.
    expect(exported.rawPayload.toString("latin1")).not.toContain("provider_id");
    expect((await call(bob, "GET", `/v1/projects/${project.id}/export`)).status).toBe(404); // not his to export

    const url = await t.listen();
    const upload = async (account: Account, bytes: Uint8Array, route = "/v1/projects/import-preview") => {
      const form = new FormData();
      form.append("file", new Blob([Buffer.from(bytes)]), "Newsroom.valuzpack");
      const res = await fetch(`${url}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${account.token}` },
        body: form,
      });
      return { status: res.status, body: (await res.json()) as Json };
    };
    // carol is new here: nothing of the project is in her library yet.
    const carol = await joinOrg(t, alice, "carol");
    await addChannel(carol);
    const preview = await upload(carol, exported.rawPayload);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      project: { name: "Newsroom", kind: "project", instructions_md: "Write for a general reader." },
      // alice shared nothing with carol, so to carol there is no project of that name.
      name_conflict: false,
      members: [{ agent_slug: "desk-editor", source_agent_slug: "editor", name: "Editor", in_library: false }],
      automations: [
        {
          name: "Morning digest",
          agent_slug: "desk-editor",
          trigger_kind: "cron",
          cron_expr: "0 7 * * 1-5",
          status: "paused",
        },
      ],
      project_connectors: ["wire-service"],
      skills: [{ source: "embedded" }],
    });
    expect(preview.body.connectors.map((connector: Json) => [connector.slug, connector.already_present])).toEqual([
      ["github", false],
      ["wire-service", false],
    ]);
    // Looking changed nothing.
    expect((await call(carol, "GET", "/v1/projects")).body.projects.filter((p: Json) => p.kind !== "chat")).toEqual([]);

    const done = await call(carol, "POST", "/v1/projects/import/confirm", { preview_id: preview.body.preview_id });
    expect(done.body).toMatchObject({
      status: "created",
      project_name: "Newsroom",
      members_created: 1,
      agents_created: 1,
      automations_created: 1,
      automation_errors: [],
      members: [{ agent_slug: "desk-editor" }],
    });
    expect(done.body.connectors_to_configure.map((connector: Json) => connector.slug)).toEqual([
      "github",
      "wire-service",
    ]);
    const landed = done.body.project_id as string;
    expect(landed).not.toBe(project.id);
    expect((await call(carol, "GET", `/v1/projects/${landed}`)).body).toMatchObject({
      name: "Newsroom",
      instructions_md: "Write for a general reader.",
      owner_id: carol.userId,
    });
    const team = (await call(carol, "GET", `/v1/projects/${landed}/agents`)).body.agents as Json[];
    expect(team.map((entry) => entry.member.agent_slug)).toEqual(["desk-editor"]);
    expect((await call(carol, "GET", `/v1/projects/${landed}/connectors`)).body).toEqual({ slugs: ["wire-service"] });
    // An imported automation waits to be switched on: nothing runs because a file was opened.
    const groups = (await call(carol, "GET", `/v1/automations?project_id=${landed}`)).body.groups as Json[];
    expect(groups[0].automations).toMatchObject([{ name: "Morning digest", status: "paused" }]);

    // The preview is spent; the same pack again finds the project already there and makes no second one.
    expect(
      (await call(carol, "POST", "/v1/projects/import/confirm", { preview_id: preview.body.preview_id })).body.code,
    ).toBe("preview_expired");
    const again = await upload(carol, exported.rawPayload);
    expect(again.body.name_conflict).toBe(true);
    expect(
      (await call(carol, "POST", "/v1/projects/import/confirm", { preview_id: again.body.preview_id })).body,
    ).toMatchObject({
      status: "skipped_name_conflict",
      project: null,
    });
    // An agent pack is not a project pack, and the other way round.
    expect((await upload(carol, new TextEncoder().encode("nope"))).body.code).toBe("invalid_pack");
    expect((await upload(carol, exported.rawPayload, "/v1/agent-packs/import")).body.code).toBe("invalid_pack");
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
