/**
 * SessionOrchestrator — runs turns. Node port of `core/orchestrator.py`.
 *
 * One turn = one Message. Events flow runtime → observer → coalescer →
 * persist-then-broadcast → session bus. The observer holds the runtime's
 * terminal event until the Message row is finalized, so a client that sees
 * `session_idle` can always read the finished message back.
 */
import path from "node:path";
import {
  type KernelEvent,
  type Message,
  type Session,
  type SkillBundle,
  type StopReason,
  type SubmitAction,
  type TodoItem,
  type UserMessage,
  nowMs,
} from "@agent-base/protocol";
import { wrapForMode } from "./prompt-builder.ts";
import type { RuntimeFactory, RuntimePort } from "./runtime.ts";
import { DeltaCoalescingSink, type EventSink, PersistThenBroadcastSink, SessionEventBus, makeEvent } from "./sinks.ts";
import { materializeSkills } from "./skills.ts";
import type { StorePort } from "./store.ts";

export class SessionNotFoundError extends Error {}
export class SessionBusyError extends Error {}
export class PendingActionNotFoundError extends Error {}
export class RuntimeUnavailableError extends Error {}

export interface GlobalEventTap {
  emitSession(sessionId: string, event: KernelEvent): Promise<void>;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Watches one turn's event stream and accumulates what the Message row needs. */
class MessageObserverSink implements EventSink {
  private readonly segments: string[] = [];
  private partial = "";
  private held: KernelEvent | null = null;
  readonly pending = new Map<string, Record<string, unknown>>();
  usage: Usage | null = null;
  modelUsage: Record<string, unknown> | null = null;
  numTurns = 0;
  lastTodos: TodoItem[] | null = null;
  errorPayload: Record<string, unknown> | null = null;
  sawTerminal = false;

  constructor(private readonly inner: EventSink) {}

  get assistantText(): string | null {
    if (this.segments.length > 0) return this.segments.join("\n\n");
    return this.partial ? this.partial : null;
  }

  async emit(event: KernelEvent): Promise<void> {
    const d = event.data;
    switch (event.type) {
      case "text_delta":
        if (typeof d["text"] === "string") this.partial += d["text"];
        break;
      case "assistant_message":
        if (typeof d["text"] === "string" && d["text"]) this.segments.push(d["text"]);
        this.partial = "";
        break;
      case "usage_update":
        this.usage = {
          input_tokens: num(d["input_tokens"]),
          output_tokens: num(d["output_tokens"]),
          cache_read_tokens: num(d["cache_read_tokens"]),
          cache_write_tokens: num(d["cache_write_tokens"]),
        };
        if (d["model_usage"] && typeof d["model_usage"] === "object") {
          this.modelUsage = d["model_usage"] as Record<string, unknown>;
        }
        if (typeof d["num_turns"] === "number") this.numTurns = d["num_turns"];
        break;
      case "todo_update":
        if (Array.isArray(d["todos"])) this.lastTodos = d["todos"] as TodoItem[];
        break;
      case "requires_action":
        if (typeof d["pending_id"] === "string") this.pending.set(d["pending_id"], d);
        break;
      case "action_resolved":
        if (typeof d["pending_id"] === "string") this.pending.delete(d["pending_id"]);
        break;
      case "session_error":
        this.errorPayload = d;
        this.sawTerminal = true;
        this.held = event;
        return;
      case "session_idle":
        this.sawTerminal = true;
        this.held = event;
        return;
      default:
        break;
    }
    await this.inner.emit(event);
  }

  /** Pass an orchestrator-authored event straight through. */
  forward(event: KernelEvent): Promise<void> {
    return this.inner.emit(event);
  }

  /** A turn that ends with approvals still open seals them, so no UI hangs on them. */
  async sealPending(decision: string): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      this.pending.delete(id);
      await this.inner.emit(makeEvent("action_resolved", { pending_id: id, decision }));
    }
  }

  async releaseTerminal(fallback: KernelEvent): Promise<void> {
    await this.inner.emit(this.held ?? fallback);
    this.held = null;
  }
}

interface WarmRuntime {
  runtime: RuntimePort;
  lastUsed: number;
}

export interface OrchestratorOptions {
  dataDir: string;
  /** Evict a warm runtime after this long idle. */
  idleTtlMs?: number;
  maxWarmRuntimes?: number;
  coalesceWindowMs?: number;
}

export class SessionOrchestrator {
  private readonly buses = new Map<string, SessionEventBus>();
  private readonly runtimes = new Map<string, WarmRuntime>();
  private readonly active = new Map<
    string,
    { runtime: RuntimePort; message: Message; observer: MessageObserverSink }
  >();
  private readonly globalTaps = new Set<GlobalEventTap>();
  private readonly starting = new Set<string>();
  private sweeper: NodeJS.Timeout | null = null;
  private readonly idleTtlMs: number;
  private readonly maxWarm: number;

  constructor(
    private readonly store: StorePort,
    private readonly createRuntime: RuntimeFactory,
    private readonly options: OrchestratorOptions,
  ) {
    this.idleTtlMs = options.idleTtlMs ?? 15 * 60_000;
    this.maxWarm = options.maxWarmRuntimes ?? 8;
  }

  start(): void {
    this.sweeper ??= setInterval(() => void this.sweepIdleRuntimes(), 60_000);
    this.sweeper.unref();
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.active.values()].map((a) => a.runtime.interrupt().catch(() => undefined)));
    await Promise.all([...this.runtimes.keys()].map((id) => this.evictRuntime(id)));
  }

  activeSessions(): string[] {
    return [...this.active.keys()];
  }

  activeMessageId(sessionId: string): string | null {
    return this.active.get(sessionId)?.message.id ?? null;
  }

  attachSessionTap(sessionId: string, sink: EventSink): () => void {
    return this.bus(sessionId).attach(sink);
  }

  attachGlobalTap(tap: GlobalEventTap): () => void {
    this.globalTaps.add(tap);
    return () => this.globalTaps.delete(tap);
  }

  private bus(sessionId: string): SessionEventBus {
    let bus = this.buses.get(sessionId);
    if (!bus) {
      bus = new SessionEventBus();
      const forward: EventSink = {
        emit: async (event) => {
          for (const tap of this.globalTaps) await tap.emitSession(sessionId, event).catch(() => undefined);
        },
      };
      bus.attach(forward);
      this.buses.set(sessionId, bus);
    }
    return bus;
  }

  async runTurn(
    userId: string,
    sessionId: string,
    userMessage: UserMessage,
    extras: { messageId?: string; skillBundles?: SkillBundle[] } = {},
  ): Promise<Message> {
    // Claim the session synchronously — before the first await — so two racing
    // sends cannot both start.
    if (this.active.has(sessionId) || this.starting.has(sessionId)) {
      throw new SessionBusyError(`session ${sessionId} is already running a turn`);
    }
    this.starting.add(sessionId);
    try {
      return await this.runClaimedTurn(userId, sessionId, userMessage, extras);
    } finally {
      this.starting.delete(sessionId);
    }
  }

  private async runClaimedTurn(
    userId: string,
    sessionId: string,
    userMessage: UserMessage,
    extras: { messageId?: string; skillBundles?: SkillBundle[] },
  ): Promise<Message> {
    const session = await this.store.loadSession(userId, sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);

    const text = wrapForMode(userMessage.text, session.mode, session.runtime_provider);
    const wrapped: UserMessage = { ...userMessage, text };
    const message: Message = {
      id: extras.messageId ?? crypto.randomUUID(),
      session_id: sessionId,
      user_message: wrapped,
      started_at: nowMs(),
      status: "running",
      assistant_message: null,
      error_message: null,
      stop_reason: null,
      total_turns: 0,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      model_usage: null,
      ended_at: null,
      metadata: {},
      todos: null,
    };

    const persist = new PersistThenBroadcastSink(this.store, userId, sessionId, message.id, this.bus(sessionId));
    const coalesced = new DeltaCoalescingSink(persist, this.options.coalesceWindowMs);
    const observer = new MessageObserverSink(coalesced);

    const slot = { runtime: null as unknown as RuntimePort, message, observer };
    this.active.set(sessionId, slot);
    try {
      await this.store.saveMessage(userId, message);
      session.status = "running";
      session.stop_reason = null;
      await this.store.saveSession(session);
      await observer.forward(
        makeEvent("user_message", { text: userMessage.text, attachments: userMessage.attachments }),
      );

      try {
        const runtime = await this.ensureRuntime(session, observer, extras.skillBundles ?? []);
        slot.runtime = runtime;
        await runtime.run(session, wrapped);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        session.stop_reason = {
          type: "error",
          category: err instanceof RuntimeUnavailableError ? "runtime_unavailable" : "runtime_error",
          retry_status: "terminal",
          message: messageText,
        };
        if (!observer.sawTerminal) {
          await observer.emit(makeEvent("session_error", { category: "runtime_error", message: messageText }));
        }
        // A runtime that threw is in an unknown state — never reuse it.
        await this.evictRuntime(sessionId);
      }

      if (session.status === "running") session.status = "idle";
      // The runtime mutates `session` in place, so read the stop reason unnarrowed.
      const stop: StopReason = (session.stop_reason as StopReason | null) ?? { type: "end_turn" };
      session.stop_reason = stop;
      await observer.sealPending(stop.type === "user_interrupt" ? "interrupted" : "expired");
      await coalesced.flush();

      finalizeMessage(message, session, observer);
      await this.store.saveSession(session);
      await this.store.saveMessage(userId, message);

      await observer.releaseTerminal(makeEvent("session_idle", { stop_reason: session.stop_reason }));
      await observer.forward(
        makeEvent("session_update", {
          status: session.status,
          message_id: message.id,
          stop_reason: session.stop_reason,
        }),
      );
      await coalesced.flush();
      return message;
    } finally {
      this.active.delete(sessionId);
      const warm = this.runtimes.get(sessionId);
      if (warm) warm.lastUsed = Date.now();
    }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const slot = this.active.get(sessionId);
    if (!slot?.runtime) return false;
    await slot.runtime.interrupt();
    return true;
  }

  async submitAction(sessionId: string, action: SubmitAction): Promise<void> {
    const slot = this.active.get(sessionId);
    if (!slot?.runtime || !slot.observer.pending.has(action.pending_id)) {
      throw new PendingActionNotFoundError(action.pending_id);
    }
    await slot.runtime.submitAction(action);
  }

  /** Drop a session's warm runtime and bus (session deleted / closed). */
  async cleanup(sessionId: string): Promise<void> {
    await this.evictRuntime(sessionId);
    this.buses.delete(sessionId);
  }

  /**
   * A process that died mid-turn leaves rows stuck at `running`. Called once at
   * boot: nothing is running in a fresh process, so reset them to `idle`.
   */
  async scanOrphanRuns(): Promise<number> {
    const stranded = await this.store.listSessions(null, { status: "running" });
    for (const session of stranded) {
      if (this.active.has(session.id)) continue;
      session.status = "idle";
      session.stop_reason = {
        type: "error",
        category: "interrupted",
        retry_status: "terminal",
        message: "host restarted mid-turn",
      };
      await this.store.saveSession(session);
    }
    return stranded.length;
  }

  private async ensureRuntime(session: Session, sink: EventSink, bundles: SkillBundle[]): Promise<RuntimePort> {
    const warm = this.runtimes.get(session.id);
    if (warm) {
      warm.runtime.updateSink(sink);
      warm.lastUsed = Date.now();
      return warm.runtime;
    }
    await this.enforceRuntimeCap();
    const skillsDir = path.join(this.options.dataDir, "skills", session.id);
    const skills = await materializeSkills(skillsDir, bundles);
    let runtime: RuntimePort;
    try {
      runtime = this.createRuntime(session, { sink, dataDir: this.options.dataDir, skillsDir, skills });
    } catch (err) {
      throw new RuntimeUnavailableError(err instanceof Error ? err.message : String(err));
    }
    this.runtimes.set(session.id, { runtime, lastUsed: Date.now() });
    return runtime;
  }

  private async evictRuntime(sessionId: string): Promise<void> {
    const warm = this.runtimes.get(sessionId);
    if (!warm) return;
    this.runtimes.delete(sessionId);
    await warm.runtime.close().catch(() => undefined);
  }

  private async sweepIdleRuntimes(): Promise<void> {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [id, warm] of this.runtimes) {
      if (!this.active.has(id) && warm.lastUsed < cutoff) await this.evictRuntime(id);
    }
  }

  private async enforceRuntimeCap(): Promise<void> {
    while (this.runtimes.size >= this.maxWarm) {
      const idle = [...this.runtimes.entries()]
        .filter(([id]) => !this.active.has(id))
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) return; // every warm runtime is mid-turn; let the cap stretch
      await this.evictRuntime(idle[0]);
    }
  }
}

function finalizeMessage(message: Message, session: Session, observer: MessageObserverSink): void {
  const stop = session.stop_reason as StopReason;
  message.ended_at = nowMs();
  message.assistant_message = observer.assistantText;
  message.total_turns = observer.numTurns || 1;
  message.stop_reason = stop;
  if (observer.usage) Object.assign(message, observer.usage);
  if (observer.modelUsage) message.model_usage = observer.modelUsage;
  if (observer.lastTodos) {
    message.todos = [...observer.lastTodos];
    session.todos = [...observer.lastTodos];
  }
  if (stop.type === "user_interrupt") {
    message.status = "cancelled";
  } else if (stop.type === "error") {
    message.status = stop.category === "user_interrupt" ? "cancelled" : "errored";
    message.error_message = observer.errorPayload ?? { category: stop.category, message: stop.message };
  } else {
    message.status = "completed";
  }
}
