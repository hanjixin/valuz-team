import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Host } from "@agent-base/host";
import {
  type ModelGateway,
  WECOM_GOOD_SECRET,
  type WeComGateway,
  startModelGateway,
  startWeComGateway,
} from "@agent-base/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Account, type TestServer, eventually, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * A WeCom smart bot bound to an agent, over the long connection the server
 * dials. WeCom's gateway is stood in for; the SDK, the server, the device and
 * the runtime are real.
 */
describe("channels: WeCom", () => {
  let t: TestServer;
  let model: ModelGateway;
  let wecom: WeComGateway;
  let dir: string;
  let host: Host;
  let alice: Account;
  let bob: Account;

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const bind = (account: Account, slug: string, body: object) =>
    call(account, "PUT", `/v1/channels/wecom-aibot/bindings/${slug}`, { agent_slug: slug, enabled: true, ...body });
  const sentCount = (count: number) => eventually(async () => wecom.sent.length === count, 20_000);
  const sessions = async () => (await call(alice, "GET", "/v1/sessions")).body.sessions as Json[];

  beforeAll(async () => {
    wecom = await startWeComGateway();
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1", WECOM_WS_URL: wecom.url });
    const url = await t.listen();
    model = await startModelGateway();
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "ab-wecom-")));
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
    await call(alice, "POST", "/v1/agents", {
      name: "Support",
      instructions: "You are Support.",
      runtime: "deepagents",
      model: "test-model",
      provider_id: channel.id,
    });
  });
  afterAll(async () => {
    await host?.stop();
    await t?.stop();
    await model?.stop();
    await wecom?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    model.replies.length = 0;
  });

  it("binds a bot to an agent and subscribes to the gateway with its secret", async () => {
    expect((await call(alice, "GET", "/v1/channels/wecom-aibot/bindings/Support")).body).toMatchObject({
      enabled: false,
      bot_id: "",
      has_secret: false,
      connection_status: "disabled",
    });
    expect((await bind(alice, "Support", { bot_id: "bot-1" })).body.code).toBe("secret_required");
    expect((await bind(bob, "Support", { bot_id: "bot-1", secret: "x" })).status).toBe(404); // not his agent

    // A wrong secret is refused by the gateway, and the binding says so.
    await bind(alice, "Support", { bot_id: "bot-1", secret: "wrong" });
    const refused = await eventually(async () => {
      const binding = (await call(alice, "GET", "/v1/channels/wecom-aibot/bindings/Support")).body;
      return binding.connection_status === "error" && binding;
    });
    expect(refused).toMatchObject({ connected: false });
    expect(refused.connection_error).toMatch(/invalid secret/);

    const bound = await bind(alice, "Support", { bot_id: "bot-1", secret: WECOM_GOOD_SECRET });
    expect(bound.body).toMatchObject({ enabled: true, bot_id: "bot-1", has_secret: true, owner_user_id: alice.userId });
    expect(JSON.stringify(bound.body)).not.toContain(WECOM_GOOD_SECRET);
    await eventually(async () => wecom.live() === 1);
    await eventually(
      async () => (await call(alice, "GET", "/v1/channels/wecom-aibot/bindings/Support")).body.connected === true,
    );
  });

  it("turns a chat into a session with the agent, and posts the answer back", async () => {
    model.replies.push({ content: "您好，请讲。" });
    wecom.push("bot-1", { text: { content: "你好" } });
    await sentCount(1);
    expect(wecom.sent[0]).toEqual({ bot: "bot-1", chat: "zhangsan", text: "您好，请讲。" });
    expect(model.requests.at(-1)?.messages[0]?.content).toContain("You are Support.");
    expect((await sessions())[0]).toMatchObject({ name: "企业微信 · Support", owner_id: alice.userId });

    // Same person, same session; a group is a chat of its own, the mention stripped.
    model.replies.push({ content: "第二个回答" }, { content: "群里的回答" });
    wecom.push("bot-1", { text: { content: "继续" } });
    await sentCount(2);
    expect(model.requests.at(-1)?.messages.some((m) => m.content === "您好，请讲。")).toBe(true);
    wecom.push("bot-1", { chattype: "group", chatid: "group-9", text: { content: "@Support 帮我看看" } });
    await sentCount(3);
    expect(wecom.sent[2]).toMatchObject({ chat: "group-9", text: "群里的回答" });
    expect(model.requests.at(-1)?.messages.at(-1)?.content).toMatch(/帮我看看$/);
    expect(model.requests.at(-1)?.messages.at(-1)?.content).not.toContain("@Support");
    expect(await sessions()).toHaveLength(2);
  });

  it("takes a redelivered message once, and says what it cannot do", async () => {
    model.replies.push({ content: "只回答一次" });
    wecom.push("bot-1", { msgid: "dup", text: { content: "重复的消息" } });
    wecom.push("bot-1", { msgid: "dup", text: { content: "重复的消息" } });
    await sentCount(4);
    wecom.push("bot-1", { msgtype: "image", image: { url: "https://example.com/a.png" } });
    await sentCount(5);
    expect(wecom.sent[4]?.text).toBe("目前只支持文本消息。");
    wecom.push("bot-1", { text: { content: "/new" } });
    await sentCount(6);
    expect(wecom.sent[5]?.text).toBe("已开始新会话。");
  });

  it("hangs up when switched off, and dials again when switched on", async () => {
    await bind(alice, "Support", { bot_id: "bot-1", enabled: false });
    await eventually(async () => wecom.live() === 0);
    expect((await call(alice, "GET", "/v1/channels/wecom-aibot/bindings/Support")).body).toMatchObject({
      enabled: false,
      has_secret: true,
      connection_status: "disabled",
    });
    await bind(alice, "Support", { bot_id: "bot-1", enabled: true });
    await eventually(async () => wecom.live() === 1);
  });
});
