/**
 * The deepagents-built native runtime against a fake OpenAI-compatible gateway:
 * a real HTTP server streaming real SSE, so the tool loop, the thread kept on
 * disk, approvals, and interruption are exercised over the actual wire format.
 */
import { type Server, createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfig, Session, type UserMessage } from "@agent-base/protocol";
import { MemoryStore, SessionOrchestrator, createRuntime, forkThread } from "../src/index.ts";

type Reply = { content?: string; tool?: { name: string; args: unknown }; hang?: boolean };

const user = (text: string): UserMessage => ({ text, attachments: [], additional_context: "" });

describe("DeepAgentRuntime", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  let store: MemoryStore;
  let orch: SessionOrchestrator;
  let replies: Reply[];
  let requests: { messages: { role: string; content: string | null }[]; tools?: unknown[] }[];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "deep-")));
    replies = [];
    requests = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        requests.push(JSON.parse(body));
        const reply = replies.shift() ?? { content: "done" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o: object) =>
          res.write(
            `data: ${JSON.stringify({ id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", model: "test-model", ...o })}\n\n`,
          );
        if (reply.hang) return; // never finishes — the test interrupts it
        // As real gateways do, the first delta says who is speaking.
        send({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
        if (reply.tool) {
          // Arguments arrive split across chunks, as real gateways send them.
          const args = JSON.stringify(reply.tool.args);
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${requests.length}`,
                      function: { name: reply.tool.name, arguments: args.slice(0, 5) },
                    },
                  ],
                },
              },
            ],
          });
          send({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } }],
          });
        }
        for (const piece of (reply.content ?? "").match(/.{1,4}/g) ?? [])
          send({ choices: [{ index: 0, delta: { content: piece } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }] });
        send({
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 7,
            total_tokens: 107,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        });
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    store = new MemoryStore();
    orch = new SessionOrchestrator(store, createRuntime, { dataDir: path.join(dir, "data"), coalesceWindowMs: 5 });
  });

  afterEach(async () => {
    await orch.shutdown();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  const newSession = async (overrides: Partial<Session> = {}): Promise<Session> => {
    const session = Session.parse({
      id: crypto.randomUUID(),
      agent_config: AgentConfig.parse({ name: "native", runtime_provider: "deepagents" }),
      runtime_provider: "deepagents",
      cwd: dir,
      user_id: "u1",
      model: "test-model",
      model_provider: { api_key: "sk-test", base_url: baseUrl, api_protocol: "openai_completion" },
      instructions: "Be terse.",
      ...overrides,
    });
    await store.saveSession(session);
    return session;
  };

  it("runs a tool loop end to end and resumes its thread from disk", async () => {
    await writeFile(path.join(dir, "notes.txt"), "alpha\nbeta\n");
    replies.push(
      { tool: { name: "read_file", args: { file_path: path.join(dir, "notes.txt") } } },
      { tool: { name: "write_file", args: { file_path: path.join(dir, "out/result.txt"), content: "beta!" } } },
      { content: "Wrote the result." },
    );
    const session = await newSession();
    const message = await orch.runTurn("u1", session.id, user("process notes"));

    expect(message.status).toBe("completed");
    expect(message.assistant_message).toBe("Wrote the result.");
    expect(message.input_tokens).toBe(300);
    expect(message.cache_read_tokens).toBe(120);
    expect(message.total_turns).toBe(3);
    expect(await readFile(path.join(dir, "out/result.txt"), "utf8")).toBe("beta!");

    // The library's own tools are what the model is offered: files, shell, planning, sub-agents.
    const offered = (requests[0]?.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    expect(offered).toEqual(
      expect.arrayContaining(["read_file", "write_file", "edit_file", "execute", "write_todos", "task"]),
    );
    const uses = store.events.filter((e) => e.type === "tool_use").map((e) => e.data["name"]);
    expect(uses).toEqual(["read_file", "write_file"]);
    const results = store.events.filter((e) => e.type === "tool_result");
    expect(String(results[0]?.data["content"])).toContain("alpha");
    expect(results.every((e) => e.data["is_error"] === false)).toBe(true);
    // The tool result was fed back to the model on the next request.
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool" });
    // The system prompt goes out as one string, which every compatible gateway accepts.
    expect(requests[0]?.messages[0]?.content).toEqual(expect.stringContaining("Be terse."));
    expect(JSON.stringify(requests[0]?.messages.at(-1)?.content)).toContain("<system-reminder>");
    // What was streamed is what was said.
    const streamed = store.events.filter((e) => e.type === "text_delta").map((e) => e.data["text"]);
    expect(streamed.join("")).toBe("Wrote the result.");
    // Each finished turn records where the thread stood, for a later fork.
    expect(message.metadata["runtime_native"]).toMatchObject({ checkpoint_id: expect.any(String) });

    // A fresh orchestrator (process restart) picks the thread back up from disk.
    const reborn = new SessionOrchestrator(store, createRuntime, { dataDir: path.join(dir, "data") });
    replies.push({ content: "Second answer." });
    await reborn.runTurn("u1", session.id, user("and then?"));
    const roles = requests.at(-1)?.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "user"]);
    await reborn.shutdown();
  });

  it("forks a thread from one of its turns", async () => {
    replies.push({ content: "One." }, { content: "Two." });
    const session = await newSession();
    const first = await orch.runTurn("u1", session.id, user("first"));
    await orch.runTurn("u1", session.id, user("second"));
    const data = path.join(dir, "data");

    const fork = await newSession();
    const anchor = first.metadata["runtime_native"] as Record<string, unknown>;
    expect(
      await forkThread(data, { runtime: "deepagents", sourceSessionId: session.id, sessionId: fork.id, anchor }),
    ).toEqual({ runtime_session_id: fork.id });
    replies.push({ content: "Fork." });
    await orch.runTurn("u1", fork.id, user("third"));
    const said = requests.at(-1)?.messages.map((m) => [m.role, m.role === "assistant" ? m.content : ""]);
    expect(said).toEqual([
      ["system", ""],
      ["user", ""],
      ["assistant", "One."],
      ["user", ""],
    ]);
    // The fork's next turn continues its own thread, not the source's.
    replies.push({ content: "Again." });
    await orch.runTurn("u1", fork.id, user("fourth"));
    expect(
      requests
        .at(-1)
        ?.messages.filter((m) => m.role === "assistant")
        .map((m) => m.content),
    ).toEqual(["One.", "Fork."]);
    await expect(
      forkThread(data, {
        runtime: "deepagents",
        sourceSessionId: session.id,
        sessionId: "x",
        anchor: { checkpoint_id: "nope" },
      }),
    ).rejects.toThrow(/no longer kept/);
  });

  it("parks a mutating tool on approval and honors a rejection", async () => {
    replies.push(
      { tool: { name: "execute", args: { command: "echo hacked > pwned.txt" } } },
      { content: "Okay, I will not." },
    );
    const session = await newSession({ permission_mode: "default" });
    const turn = orch.runTurn("u1", session.id, user("do it"));

    let pending: string | undefined;
    for (let i = 0; i < 200 && !pending; i++) {
      await new Promise((r) => setTimeout(r, 10));
      pending = store.events.find((e) => e.type === "requires_action")?.data["pending_id"] as string | undefined;
    }
    expect(pending).toBeDefined();
    await orch.submitAction(session.id, {
      pending_id: pending as string,
      decision: "reject",
      message: "not allowed",
      answers: null,
      modified_input: null,
    });
    const message = await turn;

    expect(message.status).toBe("completed");
    await expect(readFile(path.join(dir, "pwned.txt"))).rejects.toThrow();
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "not allowed" });
    expect(store.events.find((e) => e.type === "requires_action")?.data).toMatchObject({
      subject: "shell_command",
      tool_name: "execute",
    });
  });

  it("runs a command in the session's folder when allowed to", async () => {
    replies.push(
      { tool: { name: "execute", args: { command: "echo made > made.txt && cat made.txt" } } },
      { content: "Done." },
    );
    const session = await newSession();
    await orch.runTurn("u1", session.id, user("make it"));
    expect(await readFile(path.join(dir, "made.txt"), "utf8")).toBe("made\n");
    expect(String(store.events.find((e) => e.type === "tool_result")?.data["content"])).toContain("made");
  });

  it("interrupts a streaming model call and leaves a resumable thread", async () => {
    replies.push({ hang: true });
    const session = await newSession();
    const turn = orch.runTurn("u1", session.id, user("long task"));
    await new Promise((r) => setTimeout(r, 100));
    expect(await orch.interrupt(session.id)).toBe(true);
    const message = await turn;
    expect(message.status).toBe("cancelled");
    expect((await store.loadSession("u1", session.id))?.stop_reason).toEqual({ type: "user_interrupt" });

    replies.push({ content: "resumed" });
    const next = await orch.runTurn("u1", session.id, user("continue"));
    expect(next.assistant_message).toBe("resumed");
  });

  it("surfaces a gateway failure as an errored message", async () => {
    const session = await newSession({
      model_provider: { api_key: "x", base_url: "http://127.0.0.1:1/v1", api_protocol: "openai_completion" },
    });
    const message = await orch.runTurn("u1", session.id, user("hi"));
    expect(message.status).toBe("errored");
  });

  it("refuses a protocol the runtime cannot speak", async () => {
    const session = await newSession({
      model_provider: { api_key: "x", base_url: baseUrl, api_protocol: "openai_response" },
    });
    const message = await orch.runTurn("u1", session.id, user("hi"));
    expect(message.status).toBe("errored");
    expect(JSON.stringify(message.error_message)).toContain("not supported for runtime_provider=deepagents");
  });
});

describe("DeepAgentRuntime over the Anthropic protocol", () => {
  let server: Server;
  let dir: string;
  let store: MemoryStore;
  let orch: SessionOrchestrator;
  let requests: {
    path: string;
    key: string;
    body: { system?: unknown; messages: { role: string }[]; tools?: { name: string }[] };
  }[];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "deep-claude-")));
    requests = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        requests.push({ path: req.url ?? "", key: String(req.headers["x-api-key"]), body: JSON.parse(raw) });
        const first = requests.length === 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type: string, data: object) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send("message_start", {
          message: {
            id: `msg_${requests.length}`,
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 20, output_tokens: 0 },
          },
        });
        if (first) {
          // The model reads a file first: a tool call, its input arriving in pieces.
          const input = JSON.stringify({ file_path: path.join(dir, "notes.txt") });
          send("content_block_start", {
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
          });
          for (const piece of [input.slice(0, 9), input.slice(9)])
            send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: piece } });
        } else {
          send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          for (const piece of ["The file says ", "alpha."])
            send("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
        }
        send("content_block_stop", { index: 0 });
        send("message_delta", { delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 6 } });
        send("message_stop", {});
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    store = new MemoryStore();
    orch = new SessionOrchestrator(store, createRuntime, { dataDir: path.join(dir, "data"), coalesceWindowMs: 5 });
  });
  afterEach(async () => {
    await orch.shutdown();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the same tool loop against an Anthropic-style channel", async () => {
    await writeFile(path.join(dir, "notes.txt"), "alpha\n");
    const session = Session.parse({
      id: crypto.randomUUID(),
      agent_config: AgentConfig.parse({ name: "native", runtime_provider: "deepagents" }),
      runtime_provider: "deepagents",
      cwd: dir,
      user_id: "u1",
      model: "claude-test",
      // A channel's address may or may not end in /v1; the request goes to /v1/messages either way.
      model_provider: {
        api_key: "sk-ant-test",
        base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        api_protocol: "anthropic",
      },
      instructions: "Be terse.",
    });
    await store.saveSession(session);
    const message = await orch.runTurn("u1", session.id, user("what does the file say?"));

    expect(message.status).toBe("completed");
    expect(message.assistant_message).toBe("The file says alpha.");
    expect(message.total_turns).toBe(2);
    expect(message.input_tokens).toBe(40);
    expect(requests.map((request) => [request.path, request.key])).toEqual([
      ["/v1/messages", "sk-ant-test"],
      ["/v1/messages", "sk-ant-test"],
    ]);
    expect(JSON.stringify(requests[0]?.body.system)).toContain("Be terse.");
    expect(requests[0]?.body.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read_file", "execute"]));
    expect(store.events.filter((e) => e.type === "tool_use").map((e) => e.data["name"])).toEqual(["read_file"]);
    expect(String(store.events.find((e) => e.type === "tool_result")?.data["content"])).toContain("alpha");
    const streamed = store.events.filter((e) => e.type === "text_delta").map((e) => e.data["text"]);
    expect(streamed.join("")).toBe("The file says alpha.");
  });
});
