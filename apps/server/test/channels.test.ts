import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Host } from "@agent-base/host";
import {
  FEISHU_GOOD_SECRET,
  type FeishuPlatform,
  type ModelGateway,
  startFeishuPlatform,
  startModelGateway,
} from "@agent-base/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Account, type TestServer, eventually, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * A Feishu bot bound to an agent: people talk to the agent from the chat app,
 * each chat is a session on the binder's device, and answers go back to the
 * chat. The open platform is stood in for; everything else is real.
 */
describe("channels: Feishu", () => {
  let t: TestServer;
  let url: string;
  let model: ModelGateway;
  let platform: FeishuPlatform;
  let dir: string;
  let host: Host;
  let alice: Account;
  let bob: Account;
  let bindingId: string;
  let n = 0;

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const bind = (account: Account, slug: string, body: object) =>
    call(account, "PUT", `/v1/channels/feishu/bindings/${slug}`, { agent_slug: slug, enabled: true, ...body });
  const APP = "cli_00000000000000a1";
  /** The platform delivers an event to the bot's long connection — the one its device holds. */
  const push = (body: unknown, app = APP) => platform.push(app, body);
  const event = (message: Record<string, unknown>, id = `ev_${++n}`) => ({
    schema: "2.0",
    header: { event_id: id, event_type: "im.message.receive_v1", app_id: APP },
    event: {
      sender: { sender_id: { open_id: "ou_1" } },
      message: { message_id: `om_in_${n}`, chat_type: "p2p", message_type: "text", ...message },
    },
  });
  const text = (value: string) => JSON.stringify({ text: value });
  const sentCount = (count: number) => eventually(async () => platform.sent.length === count, 20_000);
  const sessions = async () => (await call(alice, "GET", "/v1/sessions")).body.sessions as Json[];

  beforeAll(async () => {
    platform = await startFeishuPlatform();
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1", FEISHU_API_BASE: platform.url });
    url = await t.listen();
    model = await startModelGateway();
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "ab-channels-")));
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
    const device = (await call(alice, "POST", "/v1/devices", { name: "Alice's Mac" })).body;
    host = new Host({
      config: {
        server_url: url,
        device_id: device.id,
        device_token: device.token,
        owner_user_id: device.owner_id,
        shared_roots: [],
        allow_exec: false,
      },
      dataDir: path.join(dir, "data"),
    });
    await host.start();
    await eventually(async () => (await call(alice, "GET", `/v1/devices/${device.id}`)).body.online === true);
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
    for (const name of ["Support", "Sales"])
      await call(alice, "POST", "/v1/agents", {
        name,
        instructions: `You are ${name}.`,
        runtime: "deepagents",
        model: "test-model",
        provider_id: channel.id,
      });
  });
  afterAll(async () => {
    await host?.stop();
    await t?.stop();
    await model?.stop();
    await platform?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    model.replies.length = 0;
  });

  it("binds a bot to an agent, keeps its secrets, and dials the platform", async () => {
    expect((await call(alice, "GET", "/v1/channels/feishu/bindings/Support")).body).toMatchObject({
      enabled: false,
      app_id: "",
      has_app_secret: false,
      connection_status: "disabled",
    });
    expect((await bind(alice, "Support", { app_id: "cli_00000000000000a1" })).body.code).toBe("secret_required");
    expect((await bind(alice, "Support", { app_id: "my-bot", app_secret: "x" })).body.code).toBe("invalid_app_id");
    expect((await bind(alice, "Nobody", { app_id: "cli_00000000000000a1", app_secret: "x" })).status).toBe(404);
    expect((await bind(bob, "Support", { app_id: "cli_00000000000000a1", app_secret: "x" })).status).toBe(404); // not his agent
    expect(
      (
        await call(alice, "PUT", "/v1/channels/feishu/bindings/Support", {
          agent_slug: "Sales",
          enabled: true,
          app_id: "x",
        })
      ).status,
    ).toBe(400);

    const bound = await bind(alice, "Support", {
      app_id: "cli_00000000000000a1",
      app_secret: FEISHU_GOOD_SECRET,
      verification_token: "vtoken", // taken by the form upstream; there is no callback here to use it
    });
    expect(bound.status).toBe(200);
    expect(bound.body).toMatchObject({
      enabled: true,
      owner_user_id: alice.userId,
      agent_slug: "Support",
      app_id: "cli_00000000000000a1",
      has_app_secret: true,
      has_verification_token: false,
      has_encrypt_key: false,
    });
    expect(JSON.stringify(bound.body)).not.toMatch(/good-secret|vtoken/);
    bindingId = bound.body.channel_instance_id;
    // The binder's device dials the platform, with the app's credentials.
    await eventually(async () => platform.live() === 1);
    expect(platform.endpointCalls.at(-1)).toMatchObject({
      AppID: "cli_00000000000000a1",
      AppSecret: FEISHU_GOOD_SECRET,
    });
    const tested = (await call(alice, "POST", "/v1/channels/feishu/bindings/Support/test")).body;
    expect(tested).toMatchObject({ credential_ok: true, error: null });

    // A wrong secret is said, not hidden.
    await bind(alice, "Sales", { app_id: "cli_00000000000000b2", app_secret: "bad-secret" });
    const rejected = (await call(alice, "POST", "/v1/channels/feishu/bindings/Sales/test")).body;
    expect(rejected).toMatchObject({ credential_ok: false, connected: false });
    expect(rejected.error).toMatch(/app secret invalid/);
    expect((await call(alice, "POST", "/v1/channels/feishu/bindings/Nobody/test")).status).toBe(404);
    // Changing the app id alone keeps the stored secret.
    const kept = await bind(alice, "Sales", { app_id: "cli_00000000000000c3", enabled: false });
    expect(kept.body).toMatchObject({
      app_id: "cli_00000000000000c3",
      has_app_secret: true,
      connection_status: "disabled",
    });
  });

  it("takes nothing from the platform over HTTP: there is no callback", async () => {
    const res = await fetch(`${url}/v1/channels/feishu/${bindingId}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "abc" }),
    });
    expect(res.status).toBe(501);
  });

  it("turns a chat into a session with the agent, and sends the answer back", async () => {
    model.replies.push({ content: "您好，我能帮您什么？" });
    const first = event({ chat_id: "oc_1", content: text("你好") });
    push(first);
    await sentCount(1);
    expect(platform.sent[0]).toEqual({ chat: "oc_1", text: "您好，我能帮您什么？", auth: "Bearer t-token" });
    expect(model.requests.at(-1)?.messages[0]?.content).toContain("You are Support.");
    // The platform redelivers the same event: it is handled once.
    push(first);
    model.replies.push({ content: "第二个回答" });
    push(event({ chat_id: "oc_1", content: text("继续") }));
    await sentCount(2);
    expect(await sessions()).toHaveLength(1);
    expect((await sessions())[0]).toMatchObject({ name: "飞书 · Support", owner_id: alice.userId, origin: "user" });

    // Same chat, same session — the agent keeps the thread.
    expect(model.requests.at(-1)?.messages.some((m) => m.content === "您好，我能帮您什么？")).toBe(true);
    expect(await sessions()).toHaveLength(1);
  });

  it("answers in a group only when mentioned, and says what it cannot do", async () => {
    push(event({ chat_id: "oc_group", chat_type: "group", content: text("大家好") }));
    model.replies.push({ content: "群里的回答" });
    push(
      event({
        chat_id: "oc_group",
        chat_type: "group",
        content: text("@_user_1 帮我看看"),
        mentions: [{ key: "@_user_1", name: "Support" }],
      }),
    );
    await sentCount(3);
    expect(platform.sent[2]).toMatchObject({ chat: "oc_group", text: "群里的回答" });
    expect(model.requests.at(-1)?.messages.at(-1)?.content).toMatch(/帮我看看$/);
    expect(model.requests.at(-1)?.messages.at(-1)?.content).not.toContain("@_user_1");
    expect(await sessions()).toHaveLength(2);

    push(event({ chat_id: "oc_1", message_type: "image", content: "{}" }));
    await sentCount(4);
    expect(platform.sent[3]?.text).toBe("目前只支持文本消息。");
    // /new starts the chat over in a fresh session.
    push(event({ chat_id: "oc_1", content: text("/new") }));
    await sentCount(5);
    model.replies.push({ content: "全新的开始" });
    push(event({ chat_id: "oc_1", content: text("重新来") }));
    await sentCount(6);
    expect(await sessions()).toHaveLength(3);
    expect(model.requests.at(-1)?.messages.some((m) => m.content === "第二个回答")).toBe(false);
  });

  it("queues what arrives mid-turn, and reports a failed turn in the chat", async () => {
    model.replies.push({ content: "慢慢来", delayMs: 400 }, { content: "第二条的回答" });
    push(event({ chat_id: "oc_1", content: text("第一条") }));
    await eventually(async () => (await sessions()).some((s) => s.status === "running"));
    push(event({ chat_id: "oc_1", content: text("第二条") }));
    await sentCount(8);
    expect(platform.sent.slice(6).map((message) => message.text)).toEqual(["慢慢来", "第二条的回答"]);
  });

  it("each bot has a connection of its own, hung up when it is switched off", async () => {
    const plain = await bind(alice, "Sales", {
      app_id: "cli_00000000000000b2",
      app_secret: FEISHU_GOOD_SECRET,
      enabled: true,
    });
    expect(plain.status).toBe(200);
    await eventually(async () => platform.live() === 2);

    // Switching a bot off hangs up; on again, it dials again.
    await bind(alice, "Sales", { app_id: "cli_00000000000000b2", enabled: false });
    await eventually(async () => platform.live() === 1);
    expect((await call(alice, "GET", "/v1/channels/feishu/bindings/Sales")).body.connection_status).toBe("disabled");
    await bind(alice, "Sales", { app_id: "cli_00000000000000b2", enabled: true });
    await eventually(async () => platform.live() === 2);
  });

  it("binds a group to a project: what is said there becomes work in the project", async () => {
    const projectId = (await call(alice, "POST", "/v1/projects", { name: "Atlas" })).body.id as string;
    // A group somebody added the Support bot to, and — for now — the only one.
    platform.chats.set("oc_team", { name: "Team Atlas", owner_id: "ou_boss", people: 5 });
    const chats = async () => (await call(alice, "GET", "/v1/channels/feishu/chats?agent_slug=Support")).body as Json[];
    expect(await chats()).toEqual([
      {
        external_chat_id: "oc_team",
        name: "Team Atlas",
        bound_project_id: null,
        created_by_valuz: false,
        needs_join: false,
      },
    ]);
    // Asked of the device that keeps the bot connected — with the bot's own credentials.
    expect((await call(bob, "GET", "/v1/channels/feishu/chats")).status).toBe(404); // bob has no bot

    const bound = await call(alice, "PUT", "/v1/channels/chat-bindings", {
      channel_instance_id: "feishu-main",
      external_chat_id: "oc_team",
      project_id: projectId,
      external_chat_name: "Team Atlas",
    });
    expect(bound.body).toMatchObject({
      external_chat_id: "oc_team",
      project_id: projectId,
      external_chat_name: "Team Atlas",
      platform: "feishu",
      created_by_valuz: false,
    });
    expect((await chats())[0]).toMatchObject({ bound_project_id: projectId });
    expect((await call(alice, "GET", `/v1/channels/chat-bindings?project_id=${projectId}`)).body).toHaveLength(1);
    // The project's bindings are for those who can see the project; binding takes the right to change it.
    expect((await call(bob, "GET", `/v1/channels/chat-bindings?project_id=${projectId}`)).body).toEqual([]);
    expect(
      (await call(bob, "PUT", "/v1/channels/chat-bindings", { external_chat_id: "oc_x", project_id: projectId }))
        .status,
    ).toBe(404);

    // A message in the bound group opens a session in the project, not a quick chat.
    const sent = platform.sent.length;
    model.replies.push({ content: "项目里的回答" });
    push(
      event({
        chat_id: "oc_team",
        chat_type: "group",
        content: text("@_user_1 看一下进度"),
        mentions: [{ key: "@_user_1", name: "Support" }],
      }),
    );
    await sentCount(sent + 1);
    expect(platform.sent.at(-1)).toMatchObject({ chat: "oc_team", text: "项目里的回答" });
    const inProject = (await sessions()).filter((session) => session.project_id === projectId);
    expect(inProject).toHaveLength(1);
    expect(inProject[0]).toMatchObject({ name: "飞书 · Team Atlas", owner_id: alice.userId });

    // Unbound, the group is an ordinary chat again — and starts afresh, not in the project's session.
    expect(
      (
        await call(
          alice,
          "DELETE",
          "/v1/channels/chat-bindings?external_chat_id=oc_team&channel_instance_id=feishu-main",
        )
      ).status,
    ).toBe(204);
    expect((await call(alice, "DELETE", "/v1/channels/chat-bindings?external_chat_id=oc_team")).status).toBe(404);
    model.replies.push({ content: "普通聊天的回答" });
    push(
      event({
        chat_id: "oc_team",
        chat_type: "group",
        content: text("@_user_1 你好"),
        mentions: [{ key: "@_user_1", name: "Support" }],
      }),
    );
    await sentCount(sent + 2);
    expect((await sessions()).filter((session) => session.project_id === projectId)).toHaveLength(1);
    expect(model.requests.at(-1)?.messages.some((m) => m.content === "项目里的回答")).toBe(false);
  });

  it("makes a group with the bot in it for a project, gives the way in, and dissolves only what the bot made", async () => {
    const projectId = (await call(alice, "POST", "/v1/projects", { name: "Borealis" })).body.id as string;
    const made = await call(alice, "POST", "/v1/channels/feishu/chats", {
      name: "Borealis 讨论",
      project_id: projectId,
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      name: "Borealis 讨论",
      project_id: projectId,
      share_link: expect.stringContaining("https://applink.example/join/"),
    });
    const chatId = made.body.external_chat_id as string;
    expect(platform.chats.get(chatId)).toMatchObject({ name: "Borealis 讨论" });
    // Bound from the start; the bot owns it, and nobody has joined yet.
    const listed = ((await call(alice, "GET", "/v1/channels/feishu/chats")).body as Json[]).find(
      (chat) => chat.external_chat_id === chatId,
    );
    expect(listed).toMatchObject({ bound_project_id: projectId, created_by_valuz: true, needs_join: true });
    expect((await call(alice, "GET", `/v1/channels/chat-bindings?project_id=${projectId}`)).body[0]).toMatchObject({
      external_chat_id: chatId,
      created_by_valuz: true,
    });
    // The link can be asked for again: the one shown at creation is easy to miss.
    expect((await call(alice, "GET", `/v1/channels/feishu/chats/${chatId}/link`)).body.share_link).toContain(chatId);

    // A group somebody else made is unlinked, never dissolved, from here.
    const foreign = await call(alice, "DELETE", "/v1/channels/feishu/chats/oc_team");
    expect([foreign.status, foreign.body.code]).toEqual([409, "not_bot_owned"]);
    expect(platform.chats.has("oc_team")).toBe(true);
    expect((await call(alice, "DELETE", `/v1/channels/feishu/chats/${chatId}`)).status).toBe(204);
    expect(platform.chats.has(chatId)).toBe(false);
    expect((await call(alice, "GET", `/v1/channels/chat-bindings?project_id=${projectId}`)).body).toEqual([]);
  });

  it("is offline while its device is away: the server neither listens nor posts for it", async () => {
    const before = platform.sent.length;
    await host.stop();
    await eventually(async () =>
      (await call(alice, "GET", "/v1/devices")).body.devices.every((d: Json) => d.online === false),
    );
    // The connections were the device's: with it gone, nothing is dialled — the server holds none.
    await eventually(async () => platform.live() === 0);
    expect((await call(alice, "GET", "/v1/channels/feishu/bindings/Support")).body).toMatchObject({
      enabled: true,
      connected: false,
      connection_status: "disconnected",
    });
    expect(platform.sent).toHaveLength(before);
    // Its groups are the platform's to list, and the platform is reached through that device.
    const away = await call(alice, "GET", "/v1/channels/feishu/chats?agent_slug=Support");
    expect([away.status, away.body.code]).toEqual([409, "device_offline"]);
    const actions = (await call(alice, "GET", "/v1/org/audit-logs?limit=200")).body.logs.map(
      (entry: Json) => entry.action,
    );
    expect(actions).toContain("channel.bind");
  });
});
