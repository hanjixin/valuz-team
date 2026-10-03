import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfig, type KernelEvent, Session, type SubmitAction, type UserMessage } from "@agent-base/protocol";
import {
  type EventSink,
  MemoryStore,
  PendingActionNotFoundError,
  type RuntimeDeps,
  type RuntimePort,
  SessionBusyError,
  SessionOrchestrator,
  buildUserPrompt,
  makeEvent,
  wrapForMode,
} from "../src/index.ts";

const user = (text: string): UserMessage => ({ text, attachments: [], additional_context: "" });

function newSession(overrides: Partial<Session> = {}): Session {
  return Session.parse({
    id: crypto.randomUUID(),
    agent_config: AgentConfig.parse({ name: "tester" }),
    cwd: "/tmp",
    user_id: "u1",
    ...overrides,
  });
}

/** A runtime driven by a script, so orchestration is tested without a model. */
class ScriptedRuntime implements RuntimePort {
  sink: EventSink;
  closed = false;
  interruptNow: (() => void) | null = null;
  decide: ((a: SubmitAction) => void) | null = null;
  constructor(
    deps: RuntimeDeps,
    private readonly script: (rt: ScriptedRuntime, s: Session, m: UserMessage) => Promise<void>,
  ) {
    this.sink = deps.sink;
  }
  updateSink(sink: EventSink): void {
    this.sink = sink;
  }
  async prepare(): Promise<void> {}
  run(session: Session, message: UserMessage): Promise<void> {
    return this.script(this, session, message);
  }
  async submitAction(action: SubmitAction): Promise<void> {
    this.decide?.(action);
  }
  async interrupt(): Promise<void> {
    this.interruptNow?.();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("SessionOrchestrator", () => {
  let dataDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "kernel-"));
    store = new MemoryStore();
  });
  afterEach(() => rm(dataDir, { recursive: true, force: true }));

  const make = (script: ConstructorParameters<typeof ScriptedRuntime>[1]) => {
    const created: ScriptedRuntime[] = [];
    const orch = new SessionOrchestrator(
      store,
      (_s, deps) => {
        const rt = new ScriptedRuntime(deps, script);
        created.push(rt);
        return rt;
      },
      { dataDir, coalesceWindowMs: 5 },
    );
    return { orch, created };
  };

  it("runs a turn: coalesces deltas, persists events in order, finalizes the message", async () => {
    const { orch } = make(async (rt, session) => {
      for (const t of ["Hel", "lo ", "world"]) await rt.sink.emit(makeEvent("text_delta", { text: t }));
      await rt.sink.emit(makeEvent("assistant_message", { text: "Hello world" }));
      await rt.sink.emit(makeEvent("todo_update", { todos: [{ content: "a", status: "completed" }] }));
      await rt.sink.emit(makeEvent("usage_update", { input_tokens: 10, output_tokens: 3, num_turns: 2 }));
      session.runtime_session_id = "native-1";
      session.stop_reason = { type: "end_turn" };
      await rt.sink.emit(makeEvent("session_idle", {}));
    });
    const session = newSession();
    await store.saveSession(session);
    const live: KernelEvent[] = [];
    orch.attachSessionTap(session.id, { emit: async (e) => void live.push(e) });

    const message = await orch.runTurn("u1", session.id, user("hi"));

    expect(message.status).toBe("completed");
    expect(message.assistant_message).toBe("Hello world");
    expect(message.input_tokens).toBe(10);
    expect(message.total_turns).toBe(2);
    expect(message.todos).toEqual([{ content: "a", status: "completed" }]);

    const types = store.events.map((e) => e.type);
    // Three deltas inside the window collapse into one row.
    expect(types).toEqual([
      "user_message",
      "text_delta",
      "assistant_message",
      "todo_update",
      "usage_update",
      "session_idle",
      "session_update",
    ]);
    expect(store.events[1]?.data["text"]).toBe("Hello world");
    expect(live.map((e) => e.type)).toEqual(types);
    expect(store.events.every((e) => e.message_id === message.id)).toBe(true);

    const saved = await store.loadSession("u1", session.id);
    expect(saved?.status).toBe("idle");
    expect(saved?.runtime_session_id).toBe("native-1");
    expect(saved?.todos).toHaveLength(1);
    // The message row is final before the terminal event is released.
    expect((await store.loadMessage("u1", message.id))?.status).toBe("completed");
  });

  it("turns a runtime crash into an errored message and evicts the runtime", async () => {
    const { orch, created } = make(async () => {
      throw new Error("boom");
    });
    const session = newSession();
    await store.saveSession(session);
    const message = await orch.runTurn("u1", session.id, user("hi"));
    expect(message.status).toBe("errored");
    expect(message.error_message).toMatchObject({ message: "boom" });
    expect(store.events.map((e) => e.type)).toContain("session_error");
    expect(created[0]?.closed).toBe(true);
    expect((await store.loadSession("u1", session.id))?.status).toBe("idle");
  });

  it("rejects a second turn while one is running, and reuses the warm runtime after", async () => {
    let release!: () => void;
    const { orch, created } = make(async (rt, session) => {
      await new Promise<void>((r) => (release = r));
      session.stop_reason = { type: "end_turn" };
      await rt.sink.emit(makeEvent("session_idle", {}));
    });
    const session = newSession();
    await store.saveSession(session);
    const first = orch.runTurn("u1", session.id, user("one"));
    await expect(orch.runTurn("u1", session.id, user("two"))).rejects.toBeInstanceOf(SessionBusyError);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await first;
    const second = orch.runTurn("u1", session.id, user("three"));
    await new Promise((r) => setTimeout(r, 20));
    release();
    await second;
    expect(created).toHaveLength(1);
  });

  it("routes an approval decision to the runtime and seals pendings left open by an interrupt", async () => {
    const { orch } = make(async (rt, session) => {
      await rt.sink.emit(makeEvent("requires_action", { pending_id: "p1", subject: "shell_command" }));
      const action = await new Promise<SubmitAction>((r) => (rt.decide = r));
      await rt.sink.emit(makeEvent("action_resolved", { pending_id: "p1", decision: action.decision }));
      await rt.sink.emit(makeEvent("requires_action", { pending_id: "p2", subject: "shell_command" }));
      await new Promise<void>((r) => (rt.interruptNow = r));
      session.stop_reason = { type: "user_interrupt" };
      await rt.sink.emit(makeEvent("session_idle", {}));
    });
    const session = newSession({ permission_mode: "default" });
    await store.saveSession(session);
    const turn = orch.runTurn("u1", session.id, user("rm -rf"));
    await new Promise((r) => setTimeout(r, 20));

    const act = (pending_id: string): SubmitAction => ({
      pending_id,
      decision: "approve",
      message: null,
      answers: null,
      modified_input: null,
    });
    await expect(orch.submitAction(session.id, act("nope"))).rejects.toBeInstanceOf(PendingActionNotFoundError);
    await orch.submitAction(session.id, act("p1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(await orch.interrupt(session.id)).toBe(true);

    const message = await turn;
    expect(message.status).toBe("cancelled");
    const resolved = store.events.filter((e) => e.type === "action_resolved").map((e) => e.data);
    expect(resolved).toMatchObject([
      { pending_id: "p1", decision: "approve" },
      { pending_id: "p2", decision: "interrupted" },
    ]);
  });

  it("materializes skill bundles as a plugin directory and refuses path escapes", async () => {
    let seen: RuntimeDeps | null = null;
    const orch = new SessionOrchestrator(
      store,
      (_s, deps) => {
        seen = deps;
        return new ScriptedRuntime(deps, async (rt, session) => {
          session.stop_reason = { type: "end_turn" };
          await rt.sink.emit(makeEvent("session_idle", {}));
        });
      },
      { dataDir },
    );
    const session = newSession();
    await store.saveSession(session);
    await orch.runTurn("u1", session.id, user("hi"), {
      skillBundles: [
        { slug: "report", version: 1, files: [{ path: "SKILL.md", content: "---\nname: Report\ndescription: Write reports\n---\nbody" }] },
      ],
    });
    const deps = seen as unknown as RuntimeDeps;
    expect(deps.skills).toMatchObject([{ slug: "report", name: "Report", description: "Write reports" }]);
    expect(await readFile(path.join(deps.skillsDir, "skills/report/SKILL.md"), "utf8")).toContain("body");

    const other = newSession();
    await store.saveSession(other);
    const bad = await orch.runTurn("u1", other.id, user("hi"), {
      skillBundles: [{ slug: "evil", version: 1, files: [{ path: "../../escape.txt", content: "x" }] }],
    });
    expect(bad.status).toBe("errored");
  });

  it("resets sessions stranded at running by a dead process", async () => {
    const { orch } = make(async () => undefined);
    const session = newSession({ status: "running" });
    await store.saveSession(session);
    expect(await orch.scanOrphanRuns()).toBe(1);
    expect((await store.loadSession("u1", session.id))?.status).toBe("idle");
  });
});

describe("prompt builder", () => {
  const now = new Date(2026, 9, 3, 9, 5);

  it("wraps a turn with reminder, context, and attachments", () => {
    const prompt = buildUserPrompt(
      {
        text: "summarize",
        additional_context: "kb: a.md",
        attachments: [
          { source_path: "/w/a.pdf", parsed_path: "/w/a.md" },
          { source_path: "/w/b.png", parsed_path: null },
        ],
      },
      "/w",
      now,
      { modelRejectsImages: true },
    );
    expect(prompt).toContain("current_datetime: Saturday 2026-10-03 09:05");
    expect(prompt).toContain("workspace_cwd: /w");
    expect(prompt).toContain("<additional-context>\nkb: a.md\n</additional-context>");
    expect(prompt).toContain("- /w/a.pdf  (extracted text: /w/a.md)");
    expect(prompt).toContain("- /w/b.png  [this model cannot read it");
    expect(prompt.endsWith("summarize")).toBe(true);
  });

  it("sends slash commands verbatim and wraps goal mode only where native", () => {
    expect(buildUserPrompt(user("/clear"), "/w", now)).toBe("/clear");
    expect(wrapForMode("ship it", "goal", "claude_agent")).toBe("/goal ship it");
    expect(wrapForMode("ship it", "goal", "valuz_agent")).toBe("ship it");
    expect(wrapForMode("ship it", "plan", "codex")).toBe("ship it");
    expect(wrapForMode("/goal clear", "goal", "codex")).toBe("/goal clear");
  });
});
