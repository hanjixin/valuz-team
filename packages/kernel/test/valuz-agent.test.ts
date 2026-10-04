/**
 * The native runtime against a fake OpenAI-compatible gateway: a real HTTP
 * server streaming real SSE, so the tool loop, checkpointing, approvals, and
 * interruption are exercised over the actual wire format.
 */
import { type Server, createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfig, Session, type UserMessage } from "@agent-base/protocol";
import { MemoryStore, SessionOrchestrator, createRuntime } from "../src/index.ts";

type Reply = { content?: string; tool?: { name: string; args: unknown }; hang?: boolean };

const user = (text: string): UserMessage => ({ text, attachments: [], additional_context: "" });

describe("ValuzAgentRuntime", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  let store: MemoryStore;
  let orch: SessionOrchestrator;
  let replies: Reply[];
  let requests: { messages: { role: string; content: string | null }[]; tools?: unknown[] }[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "valuz-"));
    replies = [];
    requests = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        requests.push(JSON.parse(body));
        const reply = replies.shift() ?? { content: "done" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (reply.hang) return; // never finishes — the test interrupts it
        if (reply.tool) {
          // Arguments arrive split across chunks, as real gateways send them.
          const args = JSON.stringify(reply.tool.args);
          send({
            choices: [
              {
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
          send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } }] });
        }
        for (const piece of (reply.content ?? "").match(/.{1,4}/g) ?? [])
          send({ choices: [{ delta: { content: piece } }] });
        send({
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } },
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
      agent_config: AgentConfig.parse({ name: "native", runtime_provider: "valuz_agent" }),
      runtime_provider: "valuz_agent",
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

  it("runs a tool loop end to end and resumes from its checkpoint", async () => {
    await writeFile(path.join(dir, "notes.txt"), "alpha\nbeta\n");
    replies.push(
      { tool: { name: "read_file", args: { path: "notes.txt" } } },
      { tool: { name: "write_file", args: { path: "out/result.txt", content: "beta!" } } },
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

    const results = store.events.filter((e) => e.type === "tool_result");
    expect(results[0]?.data["content"]).toBe("1\talpha\n2\tbeta\n3\t");
    expect(results.every((e) => e.data["is_error"] === false)).toBe(true);
    // The tool result was fed back to the model on the next request.
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "1\talpha\n2\tbeta\n3\t" });
    expect(requests[0]?.messages[0]?.content).toContain("Be terse.");
    expect(requests[0]?.messages[1]?.content).toContain("<system-reminder>");

    // A fresh orchestrator (process restart) picks the thread back up from disk.
    const reborn = new SessionOrchestrator(store, createRuntime, { dataDir: path.join(dir, "data") });
    replies.push({ content: "Second answer." });
    await reborn.runTurn("u1", session.id, user("and then?"));
    const roles = requests.at(-1)?.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "user"]);
    await reborn.shutdown();
  });

  it("parks a mutating tool on approval and honors a rejection", async () => {
    replies.push(
      { tool: { name: "bash", args: { command: "echo hacked > pwned.txt" } } },
      { content: "Okay, I will not." },
    );
    const session = await newSession({ permission_mode: "default" });
    const turn = orch.runTurn("u1", session.id, user("do it"));

    let pending: string | undefined;
    for (let i = 0; i < 100 && !pending; i++) {
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
      tool_name: "bash",
    });
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
      model_provider: { api_key: "x", base_url: baseUrl, api_protocol: "anthropic" },
    });
    const message = await orch.runTurn("u1", session.id, user("hi"));
    expect(message.status).toBe("errored");
    expect(JSON.stringify(message.error_message)).toContain("not supported for runtime_provider=valuz_agent");
  });
});
