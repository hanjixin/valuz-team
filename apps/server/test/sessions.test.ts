import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Host } from "@agent-base/host";
import { type ModelGateway, startMcpServer, startModelGateway } from "@agent-base/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Account, type TestServer, eventually, joinOrg, signUp, startTestServer } from "./harness.ts";

interface Frame {
  seq: number;
  event_type?: string;
  payload?: Record<string, string>;
}

describe("sessions", () => {
  let t: TestServer;
  let url: string;
  let model: ModelGateway;
  let dir: string;
  let alice: Account; // owns the device (and the organization)
  let bob: Account;
  let device: { id: string; token: string; owner_id: string };
  let host: Host;
  let channelId: string;

  const call = (account: Account, method: string, path_: string, body?: object) =>
    t.call(method, path_, { token: account.token, ...(body ? { body } : {}) });
  const startHost = async () => {
    const started = new Host({
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
    await started.start();
    await eventually(async () => (await call(alice, "GET", `/v1/devices/${device.id}`)).body.online === true);
    return started;
  };
  const newChat = async (account: Account, extra: object = {}) =>
    (await call(account, "POST", "/v1/sessions", { project_id: "chat-default", ...extra })).body;
  const status = async (id: string) => (await call(alice, "GET", `/v1/sessions/${id}`)).body.status;
  const idle = (id: string) => eventually(async () => (await status(id)) === "idle");
  const history = async (id: string, account = alice) =>
    (await call(account, "GET", `/v1/sessions/${id}/events`)).body.items as {
      seq: number;
      event: { event_type: string; payload: Record<string, string> };
    }[];
  const types = async (id: string) => (await history(id)).map((item) => item.event.event_type);
  /** Say something and wait for the turn to finish. */
  const say = async (account: Account, id: string, prompt: string) => {
    const res = await call(account, "POST", `/v1/sessions/${id}/messages`, { prompt });
    expect(res.status).toBe(200);
    await idle(id);
  };

  beforeAll(async () => {
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    url = await t.listen();
    model = await startModelGateway();
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "ab-sessions-")));
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
  });
  // A reply one test queued but never used (its turn was cancelled) must not answer the next test.
  beforeEach(() => {
    model.replies.length = 0;
  });
  afterAll(async () => {
    await host?.stop();
    await model?.stop();
    await t?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("needs somewhere to run and something to think with", async () => {
    const noDevice = await call(alice, "POST", "/v1/sessions", {
      project_id: "chat-default",
      runtime_id: "deepagents",
    });
    expect([noDevice.status, noDevice.body.code]).toEqual([409, "no_device"]);

    device = (await call(alice, "POST", "/v1/devices", { name: "Alice's Mac" })).body;
    host = await startHost();
    const noChannel = await call(alice, "POST", "/v1/sessions", {
      project_id: "chat-default",
      runtime_id: "deepagents",
    });
    expect([noChannel.status, noChannel.body.code]).toEqual([400, "provider_required"]);

    const channel = await call(alice, "POST", "/v1/providers", {
      name: "Test gateway",
      provider_kind: "compatible",
      api_key: "sk-test",
      base_url: model.url,
      models: ["test-model"],
    });
    expect(channel.status).toBe(201);
    channelId = channel.body.id;
    await call(alice, "POST", "/v1/providers/default", { provider_id: channelId });

    // A chat-completions channel cannot drive the Claude runtime.
    const mismatch = await call(alice, "POST", "/v1/sessions", {
      project_id: "chat-default",
      runtime_id: "claude_agent",
    });
    expect([mismatch.status, mismatch.body.code]).toEqual([400, "protocol_mismatch"]);
  });

  it("starts a quick chat from the member's defaults, in a project and a workspace of its own", async () => {
    const session = await newChat(alice);
    expect(session).toMatchObject({
      status: "created",
      origin: "user",
      name: null,
      runtime_provider: "deepagents", // setting the default channel moved the default runtime to one it can drive
      locked_provider_id: channelId,
      locked_model_id: "test-model",
      permission_mode: "full_access",
      mode: "default",
      device_id: device.id,
      owner_id: alice.userId,
      permission: "admin",
      total_tokens: 0,
    });
    const project = (await call(alice, "GET", `/v1/projects/${session.project_id}`)).body;
    expect(project).toMatchObject({ kind: "chat", root_path: null });

    model.replies.push({ content: "Hello, Alice." });
    await say(alice, session.id, "Say hello\nand nothing else");

    const after = (await call(alice, "GET", `/v1/sessions/${session.id}`)).body;
    expect(after).toMatchObject({
      status: "idle",
      name: "Say hello",
      last_user_message_text: "Say hello\nand nothing else",
    });
    // The turn's own record (its usage) and the session going idle arrive separately, in either order.
    await eventually(async () => (await call(alice, "GET", `/v1/sessions/${session.id}`)).body.total_tokens === 55);
    // The device ran it in a workspace it created for this chat.
    expect((await stat(path.join(dir, "data", "workspaces", `chat-${session.id}`))).isDirectory()).toBe(true);
    // The model was called with the channel's key, which the browser never saw.
    expect(model.requests.at(-1)?.auth).toBe("Bearer sk-test");
    expect(model.requests.at(-1)?.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("records a turn as the frames the conversation UI renders, every value a string", async () => {
    const session = await newChat(alice);
    model.replies.push({ content: "Fine, thanks." });
    await say(alice, session.id, "How are you?");

    const events = await history(session.id);
    const seen = events.map((e) => e.event.event_type);
    expect(seen[0]).toBe("message.user");
    expect(seen).toEqual(expect.arrayContaining(["message.assistant.delta", "runtime.engine.usage", "session.idle"]));
    // The turn ends with the session going idle and its status being announced.
    expect(seen.slice(-2)).toEqual(["session.idle", "session.update"]);
    const user = events[0]?.event.payload;
    expect(user).toMatchObject({ text: "How are you?", attachments: "[]" });
    const answer = events.find((e) => e.event.event_type === "message.assistant.delta")?.event.payload;
    expect(answer).toMatchObject({ text: "Fine, thanks.", message_id: user?.["message_id"] });
    const usage = events.find((e) => e.event.event_type === "runtime.engine.usage")?.event.payload;
    expect(usage).toMatchObject({ input_tokens: "50", output_tokens: "5" });
    for (const event of events)
      for (const value of Object.values(event.event.payload)) expect(typeof value).toBe("string");
    // Seqs only grow, and paging after one returns what follows it.
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const tail = (await call(alice, "GET", `/v1/sessions/${session.id}/events?after_seq=${seqs[1]}`)).body.items;
    expect(tail.map((e: { seq: number }) => e.seq)).toEqual(seqs.slice(2));
  });

  it("shows tool calls as they start and finish", async () => {
    const session = await newChat(alice);
    model.replies.push({ tool: { name: "write_file", args: { path: "note.txt", content: "written by the agent" } } });
    model.replies.push({ content: "Saved." });
    await say(alice, session.id, "Write a note");

    const events = await history(session.id);
    const started = events.find((e) => e.event.event_type === "tool.call.started")?.event.payload;
    const completed = events.find((e) => e.event.event_type === "tool.call.completed")?.event.payload;
    expect(started).toMatchObject({ name: "write_file" });
    expect(JSON.parse(started?.["input"] ?? "{}")).toMatchObject({ path: "note.txt" });
    expect(completed).toMatchObject({ tool_use_id: started?.["tool_use_id"], is_error: "false" });
    const written = path.join(dir, "data", "workspaces", `chat-${session.id}`, "note.txt");
    expect(await readFile(written, "utf8")).toBe("written by the agent");
  });

  it("streams a turn live: stored history first, then what arrives, then a cursor to resume from", async () => {
    const session = await newChat(alice);
    model.replies.push({ content: "First." });
    await say(alice, session.id, "one");
    // A turn's last event is the status announcement that follows going idle; wait for it to be stored.
    await eventually(async () => (await types(session.id)).at(-1) === "session.update");
    const before = await history(session.id);

    const controller = new AbortController();
    const res = await fetch(`${url}/v1/sessions/${session.id}/events/stream?after_seq=${before[0]?.seq}`, {
      headers: { authorization: `Bearer ${alice.token}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames: Frame[] = [];
    const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const pump = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.startsWith("data:")) frames.push(JSON.parse(line.slice(5)) as Frame);
      }
    })();

    // History after the cursor arrives first, closed by a heartbeat carrying where it ends.
    await eventually(async () => frames.some((f) => !f.event_type));
    expect(frames.filter((f) => f.event_type).map((f) => f.seq)).toEqual(before.slice(1).map((e) => e.seq));
    expect(frames.find((f) => !f.event_type)).toEqual({ seq: before.at(-1)?.seq });

    model.replies.push({ content: "Second.", delayMs: 50 });
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "two" });
    // A turn's last event is the status announcement that follows going idle: one replayed, one live.
    await eventually(async () => frames.filter((f) => f.event_type === "session.update").length === 2);
    controller.abort();
    await pump;

    const live = frames.slice(frames.findIndex((f) => !f.event_type) + 1);
    expect(live[0]).toMatchObject({ event_type: "message.user", payload: { text: "two" } });
    expect(live.some((f) => f.event_type === "message.assistant.text_delta")).toBe(true);
    expect(live.find((f) => f.event_type === "message.assistant.delta")?.payload?.["text"]).toBe("Second.");
    // Nothing was delivered twice, and the stream agrees with what was stored.
    const delivered = frames.filter((f) => f.event_type).map((f) => f.seq);
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered).toEqual((await history(session.id)).slice(1).map((e) => e.seq));

    // The last turns of a conversation, whole turns at a time.
    const recent = (await call(alice, "GET", `/v1/sessions/${session.id}/events/window?turn_limit=1`)).body;
    expect(recent.has_more).toBe(true);
    expect(recent.items[0].event).toMatchObject({ event_type: "message.user", payload: { text: "two" } });
    const earlier = (
      await call(
        alice,
        "GET",
        `/v1/sessions/${session.id}/events/window?turn_limit=1&before_seq=${recent.items[0].seq}`,
      )
    ).body;
    expect(earlier.has_more).toBe(false);
    expect(earlier.items[0].event.payload.text).toBe("one");
  });

  it("holds what is typed during a turn and sends it when the turn ends", async () => {
    const session = await newChat(alice);
    model.replies.push({ content: "Slow answer.", delayMs: 400 });
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "first" });
    expect(await status(session.id)).toBe("running");

    const busy = await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "second" });
    expect([busy.status, busy.body.code]).toEqual([409, "session_busy"]);
    const queued = await call(alice, "POST", `/v1/sessions/${session.id}/queue`, { prompt: "second" });
    expect(queued.body).toMatchObject({ paused: false, items: [{ text: "second", status: "queued", position: 0 }] });
    const edited = await call(alice, "PATCH", `/v1/sessions/${session.id}/queue/${queued.body.items[0].id}`, {
      prompt: "second, revised",
    });
    expect(edited.body.items[0].text).toBe("second, revised");

    model.replies.push({ content: "Second answer." });
    await eventually(async () => (await types(session.id)).filter((type) => type === "session.idle").length === 2);
    const texts = (await history(session.id))
      .filter((e) => e.event.event_type === "message.user")
      .map((e) => e.event.payload["text"]);
    expect(texts).toEqual(["first", "second, revised"]);
    expect((await call(alice, "GET", `/v1/sessions/${session.id}/queue`)).body.items).toEqual([]);
  });

  it("interrupting stops the turn and pauses the queue until someone sends again", async () => {
    const session = await newChat(alice);
    model.replies.push({ hang: true });
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "think forever" });
    await call(alice, "POST", `/v1/sessions/${session.id}/queue`, { prompt: "after that" });

    const interrupted = await call(alice, "POST", `/v1/sessions/${session.id}/interrupt`);
    expect(interrupted.status).toBe(200);
    await idle(session.id);
    const queue = (await call(alice, "GET", `/v1/sessions/${session.id}/queue`)).body;
    expect(queue).toMatchObject({ paused: true, items: [{ text: "after that" }] });

    // The next message by hand resumes; the held one follows it.
    model.replies.push({ content: "Resumed." }, { content: "And the held one." });
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "go on" });
    await eventually(
      async () => (await call(alice, "GET", `/v1/sessions/${session.id}/queue`)).body.items.length === 0,
    );
    await eventually(async () => (await types(session.id)).filter((type) => type === "message.user").length === 3);
    await idle(session.id);
  });

  it("is private until shared; `edit` on its project lets a teammate drive it, and the turn is theirs", async () => {
    const project = (await call(alice, "POST", "/v1/projects", { name: "Launch", root_path: dir })).body;
    await call(
      alice,
      "PUT",
      `/v1/projects/${project.id}/instructions?instructions_md=${encodeURIComponent("Answer in haiku.")}`,
    );
    const session = (await call(alice, "POST", "/v1/sessions", { project_id: project.id })).body;
    expect((await call(bob, "GET", `/v1/sessions/${session.id}`)).status).toBe(404);
    expect((await call(bob, "GET", "/v1/sessions")).body.sessions).toEqual([]);

    const share = (permission: string) =>
      call(alice, "PUT", `/v1/shares/project/${project.id}`, {
        principal_type: "user",
        principal_id: bob.userId,
        permission,
      });
    await share("use");
    expect((await call(bob, "GET", `/v1/sessions/${session.id}`)).body.permission).toBe("view");
    expect((await call(bob, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "hi" })).status).toBe(403);
    expect((await call(bob, "GET", `/v1/sessions?project_id=${project.id}`)).body.sessions).toHaveLength(1);

    await share("edit");
    // The device's owner decides what others reach on it: the server allowing it is not enough.
    const blocked = await call(bob, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "hi" });
    expect([blocked.status, blocked.body.code]).toEqual([403, "forbidden"]);
    expect(await status(session.id)).toBe("created"); // the refused turn left nothing behind
    await host.stop();
    host = new Host({
      config: {
        server_url: url,
        device_id: device.id,
        device_token: device.token,
        owner_user_id: device.owner_id,
        shared_roots: [dir],
        allow_exec: false,
      },
      dataDir: path.join(dir, "data"),
    });
    await host.start();
    await eventually(async () => (await call(alice, "GET", `/v1/devices/${device.id}`)).body.online === true);

    model.replies.push({ content: "Petals on the wind." });
    await say(bob, session.id, "A line about spring");
    // The turn carries the project's instructions, and is recorded as bob's.
    const system = model.requests.at(-1)?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("## Project: Launch\nAnswer in haiku.");
    const turn = await t.server.ctx.db
      .selectFrom("messages")
      .select("actor_id")
      .where("session_id", "=", session.id)
      .executeTakeFirstOrThrow();
    expect(turn.actor_id).toBe(bob.userId);
    expect((await history(session.id, bob)).map((e) => e.event.event_type)).toContain("session.idle");
    // Driving is not owning.
    expect((await call(bob, "DELETE", `/v1/sessions/${session.id}`)).status).toBe(403);
  });

  it("runs as an agent: its instructions as they are now, not as they were when the session began", async () => {
    await call(alice, "POST", "/v1/agents", {
      name: "Poet",
      instructions: "You are a poet.",
      runtime: "deepagents",
      model: "test-model",
      provider_id: channelId,
    });
    const session = await newChat(alice, { agent_slug: "Poet" });
    expect(session).toMatchObject({ agent_slug: "Poet", runtime_provider: "deepagents" });
    await call(alice, "PATCH", "/v1/agents/Poet", { instructions: "You are a poet who only writes limericks." });
    model.replies.push({ content: "There once was…" });
    await say(alice, session.id, "Write");
    const system = model.requests.at(-1)?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("only writes limericks");
  });

  it("puts an agent's skills on the device for the turn, each in its current version", async () => {
    await call(alice, "POST", "/v1/skills", {
      name: "Rhyme Check",
      description: "Check that lines rhyme",
      instructions_markdown: "v1",
    });
    await call(alice, "PATCH", "/v1/agents/Poet", { skills: ["rhyme-check", "a-skill-that-was-deleted"] });
    const session = await newChat(alice, { agent_slug: "Poet" });
    await call(alice, "PATCH", "/v1/skills/rhyme-check", { instructions_markdown: "v2: read it aloud" });
    model.replies.push({ content: "Done." });
    await say(alice, session.id, "Write");

    const manifest = path.join(dir, "data", "skills", session.id, "skills", "rhyme-check", "SKILL.md");
    expect(await readFile(manifest, "utf8")).toContain("v2: read it aloud");
    // The runtime tells the model which skills it has.
    const system = model.requests.at(-1)?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("rhyme-check");
  });

  it("lets an agent call the tools of its connectors, from the device, with the connector's sealed credentials", async () => {
    const mcp = await startMcpServer();
    mcp.token = "catalogue-key";
    try {
      await call(alice, "POST", "/v1/connectors", {
        display_name: "Catalogue",
        transport: "http",
        url: mcp.url,
        headers: [{ key: "Authorization", secret: true, value: "Bearer catalogue-key" }],
      });
      await call(alice, "PATCH", "/v1/agents/Poet", { connector_types: ["catalogue"], skills: [] });
      const session = await newChat(alice, { agent_slug: "Poet" });
      model.replies.push(
        { tool: { name: "mcp__catalogue__lookup", args: { term: "sonnet" } } },
        { content: "Looked it up." },
      );
      await say(alice, session.id, "What is a sonnet?");

      expect(mcp.calls).toEqual(["sonnet"]);
      const offered = model.requests.at(-1)?.tools?.map((tool) => tool.function.name) ?? [];
      expect(offered).toEqual(expect.arrayContaining(["mcp__catalogue__lookup", "mcp__catalogue__ping"]));
      const result = (await history(session.id)).find((e) => e.event.event_type === "tool.call.completed")?.event
        .payload;
      expect(result).toMatchObject({ is_error: "false" });
      expect(result?.["content"]).toContain("sonnet: found in the catalogue");
    } finally {
      await mcp.stop();
    }
  });

  it("asks before acting when the session says so: approve lets the tool run, reject tells the agent no", async () => {
    const session = await newChat(alice, { permission_mode: "default" });
    const pending = async (nth: number) =>
      eventually(
        async () => (await history(session.id)).filter((e) => e.event.event_type === "session.requires_action")[nth],
      );
    const answer = (account: Account, body: object) =>
      call(account, "POST", `/v1/sessions/${session.id}/actions`, body);
    const workspace = path.join(dir, "data", "workspaces", `chat-${session.id}`);

    model.replies.push(
      { tool: { name: "write_file", args: { path: "approved.txt", content: "yes" } } },
      { content: "Written." },
    );
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "write it" });
    const request = (await pending(0)).event.payload;
    expect(request).toMatchObject({ subject: "file_change" });
    expect(JSON.parse(request["payload"] ?? "{}")).toMatchObject({ tool_name: "write_file", path: "approved.txt" });
    expect(JSON.parse(request["available_decisions"] ?? "[]")).toEqual(["approve", "approve_with_changes", "reject"]);
    await expect(stat(path.join(workspace, "approved.txt"))).rejects.toThrow(); // nothing happens until someone decides

    // bob cannot see this session, let alone answer for it.
    expect((await answer(bob, { pending_id: request["pending_id"], decision: "approve" })).status).toBe(404);
    const approved = await answer(alice, { pending_id: request["pending_id"], decision: "approve" });
    expect(approved.body).toMatchObject({ session_id: session.id, decision: "approve", idempotent: false });
    await idle(session.id);
    expect(await readFile(path.join(workspace, "approved.txt"), "utf8")).toBe("yes");

    // Saying it again is harmless; changing the answer afterwards is refused.
    const again = await answer(alice, { pending_id: request["pending_id"], decision: "approve" });
    expect(again.body).toMatchObject({ idempotent: true, accepted_at: approved.body.accepted_at });
    const flip = await answer(alice, { pending_id: request["pending_id"], decision: "reject" });
    expect([flip.status, flip.body.code]).toEqual([409, "already_resolved"]);

    model.replies.push(
      { tool: { name: "write_file", args: { path: "refused.txt", content: "no" } } },
      { content: "Understood." },
    );
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "write another" });
    const second = (await pending(1)).event.payload;
    await answer(alice, { pending_id: second["pending_id"], decision: "reject", message: "not that file" });
    await idle(session.id);
    await expect(stat(path.join(workspace, "refused.txt"))).rejects.toThrow();
    const refusal = (await history(session.id)).filter((e) => e.event.event_type === "tool.call.completed").at(-1);
    expect(refusal?.event.payload["content"]).toContain("not that file");

    // A request nobody is waiting on any more.
    const stale = await answer(alice, { pending_id: crypto.randomUUID(), decision: "approve" });
    expect([stale.status, stale.body.code]).toEqual([410, "action_expired"]);
    const actions = (await call(alice, "GET", "/v1/org/audit-logs?limit=200")).body.logs.filter(
      (log: { action: string }) => log.action === "session.action",
    );
    expect(actions.map((log: { detail: { decision: string } }) => log.detail.decision).sort()).toEqual([
      "approve",
      "reject",
    ]);
  });

  it("changes how a session runs from its next turn, within what its runtime can do", async () => {
    const session = await newChat(alice);
    const patch = (what: string, body: object) => call(alice, "PATCH", `/v1/sessions/${session.id}/${what}`, body);
    expect((await patch("permission-mode", { permission_mode: "default" })).body.permission_mode).toBe("default");
    expect((await patch("effort", { effort: "max" })).body.effort).toBe("max");
    expect((await patch("effort", { effort: null })).body.effort).toBeNull();
    // The native runtime neither plans nor reviews tool calls on its own.
    expect((await patch("mode", { mode: "plan" })).body.code).toBe("unsupported_mode");
    expect((await patch("permission-mode", { permission_mode: "auto_review" })).body.code).toBe("unsupported_mode");
    expect((await patch("mode", { mode: "default" })).body.mode).toBe("default");
    expect((await call(bob, "PATCH", `/v1/sessions/${session.id}/effort`, { effort: "low" })).status).toBe(404);
    expect((await call(alice, "POST", `/v1/sessions/${session.id}/prepare`)).body).toEqual({ ready: true });

    // The approval mode set above holds for the next turn.
    model.replies.push({ tool: { name: "write_file", args: { path: "x.txt", content: "x" } } }, { content: "ok" });
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "write" });
    await eventually(async () => (await types(session.id)).includes("session.requires_action"));
    await call(alice, "POST", `/v1/sessions/${session.id}/cancel`);
    await idle(session.id);
  });

  it("lets a queued message jump the queue, stopping the running turn to make way", async () => {
    const session = await newChat(alice);
    model.replies.push({ hang: true });
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "a long task" });
    await call(alice, "POST", `/v1/sessions/${session.id}/queue`, { prompt: "later" });
    const queue = (await call(alice, "POST", `/v1/sessions/${session.id}/queue`, { prompt: "urgent" })).body;
    const urgent = queue.items.find((item: { text: string }) => item.text === "urgent");

    model.replies.push({ content: "On it." }, { content: "And the other." });
    const steered = await call(alice, "POST", `/v1/sessions/${session.id}/queue/${urgent.id}/steer`);
    expect(steered.status).toBe(200);
    await eventually(async () => (await types(session.id)).filter((type) => type === "message.user").length === 3);
    await idle(session.id);
    const said = (await history(session.id))
      .filter((e) => e.event.event_type === "message.user")
      .map((e) => e.event.payload["text"]);
    expect(said).toEqual(["a long task", "urgent", "later"]);

    // After an interrupt the queue waits for "go on".
    model.replies.push({ hang: true });
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "another long one" });
    await call(alice, "POST", `/v1/sessions/${session.id}/queue`, { prompt: "held" });
    await call(alice, "POST", `/v1/sessions/${session.id}/interrupt`);
    await idle(session.id);
    model.replies.push({ content: "Resumed." });
    const resumed = await call(alice, "POST", `/v1/sessions/${session.id}/queue/resume`);
    expect(resumed.body).toMatchObject({ paused: false, items: [] });
    await eventually(async () => (await history(session.id)).some((e) => e.event.payload["text"] === "held"));
    await idle(session.id);
  });

  it("closes a turn on the device's behalf when the device restarts in the middle of it", async () => {
    const session = await newChat(alice);
    model.replies.push({ hang: true });
    const asked = model.requests.length;
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "this will be cut off" });
    // Mid-turn: the model has been asked and has not answered.
    await eventually(async () => model.requests.length > asked);

    await host.stop();
    host = await startHost(); // a new process: it knows nothing of the turn
    await idle(session.id);
    const events = await history(session.id);
    expect(events.map((e) => e.event.event_type).slice(-2)).toEqual(["run.failed", "session.idle"]);
    expect(events.at(-2)?.event.payload).toMatchObject({
      message: "the device restarted mid-turn",
      category: "interrupted",
    });
    // The conversation goes on.
    model.replies.push({ content: "Back." });
    await say(alice, session.id, "still there?");
  });

  it("forks a conversation — whole, or from one of its turns — and leaves the source alone", async () => {
    const source = await newChat(alice);
    expect((await call(alice, "POST", `/v1/sessions/${source.id}/fork`, {})).body.code).toBe("nothing_to_fork");
    model.replies.push({ content: "One." });
    await say(alice, source.id, "first question");
    model.replies.push({ content: "Two." });
    await say(alice, source.id, "second question");
    // Each finished turn says it can be forked from.
    const updates = (await history(source.id)).filter((e) => e.event.event_type === "session.update");
    expect(updates.map((e) => e.event.payload["fork_anchor"])).toEqual(["true", "true"]);
    const turns = (await history(source.id))
      .filter((item) => item.event.event_type === "message.user")
      .map((item) => item.event.payload["message_id"] as string);
    const sourceEvents = (await history(source.id)).length;
    /** What the model is shown of the conversation, on the session's next turn. */
    const heard = async (id: string, prompt: string) => {
      model.replies.push({ content: "Fork answer." });
      await say(alice, id, prompt);
      return (model.requests.at(-1)?.messages ?? [])
        .filter((m) => m.role !== "system")
        .map((m) => (m.content ?? "").replace(/^[\s\S]*\n/, ""));
    };

    // From the first turn: the fork knows the first exchange and nothing after it.
    const early = await call(alice, "POST", `/v1/sessions/${source.id}/fork`, { message_id: turns[0] });
    expect(early.status).toBe(201);
    expect(early.body).toMatchObject({ status: "idle", owner_id: alice.userId, device_id: source.device_id });
    expect(early.body.name).toBe("first question（分叉）");
    expect(early.body.project_id).not.toBe(source.project_id); // a quick chat has a project to itself
    expect((await types(early.body.id)).filter((type) => type === "message.user")).toHaveLength(1);
    expect(await heard(early.body.id, "third question")).toEqual(["first question", "One.", "third question"]);

    // Whole: everything so far.
    const whole = await call(alice, "POST", `/v1/sessions/${source.id}/fork`, {});
    expect(whole.status).toBe(201);
    expect((await history(whole.body.id)).length).toBe(sourceEvents);
    expect(await heard(whole.body.id, "another")).toEqual([
      "first question",
      "One.",
      "second question",
      "Two.",
      "another",
    ]);

    // The source went nowhere, and still continues from its own tail.
    expect((await history(source.id)).length).toBe(sourceEvents);
    expect(await heard(source.id, "back here")).toHaveLength(5);

    // What cannot be forked: someone else's message, an unfinished turn, a session one cannot drive.
    const other = await call(alice, "POST", `/v1/sessions/${whole.body.id}/fork`, { message_id: turns[0] });
    expect(other.status).toBe(404);
    expect((await call(alice, "POST", `/v1/sessions/${source.id}/fork`, { message_id: "nope" })).status).toBe(404);
    expect((await call(bob, "POST", `/v1/sessions/${source.id}/fork`, {})).status).toBe(404);
    model.replies.push({ hang: true });
    await call(alice, "POST", `/v1/sessions/${source.id}/messages`, { prompt: "long one" });
    const busy = await call(alice, "POST", `/v1/sessions/${source.id}/fork`, {});
    expect([busy.status, busy.body.code]).toEqual([409, "session_busy"]);
    // …though an earlier turn of a busy session still can be.
    expect((await call(alice, "POST", `/v1/sessions/${source.id}/fork`, { message_id: turns[1] })).status).toBe(201);
    await call(alice, "POST", `/v1/sessions/${source.id}/interrupt`);
    await idle(source.id);
  });

  it("tells each member, on one stream, when the sessions they can see start and finish — and nothing else", async () => {
    const follow = async (account: Account, afterSeq = 0) => {
      const controller = new AbortController();
      const res = await fetch(`${url}/v1/stream?after_seq=${afterSeq}`, {
        headers: { authorization: `Bearer ${account.token}` },
        signal: controller.signal,
      });
      const seen: { event: string; data: { seq: number; session_id?: string; payload?: Record<string, string> } }[] =
        [];
      const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        let event = "";
        for (;;) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) seen.push({ event, data: JSON.parse(line.slice(5)) });
          }
        }
      })();
      // Everything stored so far has been replayed once the first heartbeat arrives.
      await eventually(async () => seen.some((frame) => frame.event === "heartbeat"));
      return { seen, stop: () => controller.abort() };
    };

    const cursor = Number(
      (
        await t.server.ctx.db
          .selectFrom("events")
          .select((eb) => eb.fn.max("seq").as("seq"))
          .executeTakeFirst()
      )?.seq ?? 0,
    );
    const [forAlice, forBob] = await Promise.all([follow(alice, cursor), follow(bob, cursor)]);
    const session = await newChat(alice);
    model.replies.push({ content: "Noted." });
    await say(alice, session.id, "a private thought");
    await eventually(async () => forAlice.seen.some((frame) => frame.event === "run.finished"));

    const mine = forAlice.seen.filter((frame) => frame.event !== "heartbeat");
    expect(mine.map((frame) => frame.event)).toEqual(["run.started", "run.finished", "run.status"]);
    expect(mine.every((frame) => frame.data.session_id === session.id)).toBe(true);
    expect(mine[1]?.data.payload).toMatchObject({ status: "idle" });
    // Lifecycle only: what was said never travels on this stream.
    expect(JSON.stringify(forAlice.seen)).not.toContain("a private thought");
    // bob cannot see alice's chat, so his stream stays quiet.
    expect(forBob.seen.filter((frame) => frame.event !== "heartbeat")).toEqual([]);
    forAlice.stop();
    forBob.stop();

    // Reconnecting from an earlier cursor replays what was missed.
    const replay = await follow(alice, cursor);
    expect(replay.seen.filter((frame) => frame.event !== "heartbeat").map((frame) => frame.event)).toEqual([
      "run.started",
      "run.finished",
      "run.status",
    ]);
    expect(replay.seen.at(-1)).toMatchObject({ event: "heartbeat", data: { seq: mine.at(-1)?.data.seq } });
    replay.stop();
  });

  it("keeps each member's feedback on a turn: a rating can be changed or withdrawn, a copy is counted", async () => {
    const session = await newChat(alice);
    model.replies.push({ content: "An answer worth rating." });
    await say(alice, session.id, "rate me");
    const messageId = (await history(session.id))[0]?.event.payload["message_id"];
    const feedback = (body: object) => call(alice, "POST", `/v1/sessions/${session.id}/feedback`, body);

    const up = await feedback({
      message_id: messageId,
      action: "rating",
      value: "up",
      reason_codes: ["solved", "fast"],
    });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({
      action: "rating",
      value: "up",
      reason_code: "solved",
      occurrences: 1,
      block_ref: "",
      target: { type: "message", id: messageId },
      metadata: { reason_codes: ["solved", "fast"] },
    });
    // Changing your mind replaces the rating; it does not add a second one.
    const down = await feedback({ message_id: messageId, action: "rating", value: "down", reason: "too long" });
    expect(down.body).toMatchObject({ id: up.body.id, value: "down", reason: "too long", occurrences: 2 });
    await feedback({ message_id: messageId, action: "copy" });
    await feedback({ message_id: messageId, action: "copy" });
    const items = (await call(alice, "GET", `/v1/sessions/${session.id}/feedback`)).body.items;
    expect(items.map((i: { action: string; occurrences: number }) => [i.action, i.occurrences])).toEqual([
      ["rating", 2],
      ["copy", 2],
    ]);

    expect((await feedback({ message_id: messageId, action: "rating" })).status).toBe(422);
    expect((await feedback({ message_id: messageId, action: "copy", value: "up" })).status).toBe(422);
    expect((await feedback({ message_id: crypto.randomUUID(), action: "copy" })).status).toBe(404);
    expect((await call(bob, "GET", `/v1/sessions/${session.id}/feedback`)).status).toBe(404); // not his session

    const withdraw = await call(
      alice,
      "DELETE",
      `/v1/sessions/${session.id}/feedback?message_id=${messageId}&action=rating`,
    );
    expect(withdraw.status).toBe(204);
    expect(
      (await call(alice, "DELETE", `/v1/sessions/${session.id}/feedback?message_id=${messageId}&action=rating`)).status,
    ).toBe(404);
    expect((await call(alice, "GET", `/v1/sessions/${session.id}/feedback`)).body.items).toHaveLength(1);
  });

  it("renames, and deletes with everything it held — but not mid-turn", async () => {
    const session = await newChat(alice);
    const renamed = await call(
      alice,
      "PATCH",
      `/v1/sessions/${session.id}?name=${encodeURIComponent("Budget review")}`,
    );
    expect(renamed.body.name).toBe("Budget review");
    expect((await call(alice, "GET", "/v1/sessions?q=budget")).body.sessions.map((s: { id: string }) => s.id)).toEqual([
      session.id,
    ]);

    model.replies.push({ content: "Done.", delayMs: 300 });
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "work" });
    const busy = await call(alice, "DELETE", `/v1/sessions/${session.id}`);
    expect([busy.status, busy.body.code]).toEqual([409, "session_busy"]);
    await idle(session.id);
    expect((await call(alice, "DELETE", `/v1/sessions/${session.id}`)).status).toBe(204);
    expect((await call(alice, "GET", `/v1/sessions/${session.id}`)).status).toBe(404);
    const left = await t.server.ctx.db
      .selectFrom("events")
      .select("seq")
      .where("session_id", "=", session.id)
      .execute();
    expect(left).toEqual([]);
  });
});
