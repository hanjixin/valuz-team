/** Event sinks — the pipeline every runtime event flows through. */
import { type KernelEvent, nowMs } from "@agent-base/protocol";
import type { StorePort } from "./store.ts";

export interface EventSink {
  emit(event: KernelEvent): Promise<void>;
}

export const makeEvent = (type: KernelEvent["type"], data: Record<string, unknown> = {}): KernelEvent => ({
  type,
  data,
  timestamp: nowMs(),
});

/** Fan-out to whichever live listeners are attached to one session. */
export class SessionEventBus implements EventSink {
  private readonly taps = new Set<EventSink>();

  attach(sink: EventSink): () => void {
    this.taps.add(sink);
    return () => this.taps.delete(sink);
  }

  async emit(event: KernelEvent): Promise<void> {
    for (const tap of this.taps) {
      // A broken listener must never take the turn down with it.
      await tap.emit(event).catch(() => undefined);
    }
  }
}

/**
 * Persist first, then broadcast — a live listener never sees an event that a
 * reconnect-with-replay could not also read back.
 */
export class PersistThenBroadcastSink implements EventSink {
  constructor(
    private readonly store: StorePort,
    private readonly userId: string,
    private readonly sessionId: string,
    private readonly messageId: string,
    private readonly live: EventSink,
  ) {}

  async emit(event: KernelEvent): Promise<void> {
    const stamped: KernelEvent = { ...event, data: { ...event.data, message_id: this.messageId } };
    await this.store.appendEvent(this.userId, this.sessionId, this.messageId, stamped, {
      requestId: crypto.randomUUID(),
    });
    await this.live.emit(stamped);
  }
}

const COALESCED: Record<string, string> = {
  text_delta: "text",
  thinking_delta: "text",
  tool_output_delta: "output",
};

/**
 * Merge bursts of streaming deltas into one event per flush window, so a
 * token-by-token model stream costs a handful of rows instead of thousands.
 * Any non-delta event (or a delta of another kind / another tool) flushes
 * first, which keeps ordering exact.
 */
export class DeltaCoalescingSink implements EventSink {
  private pending: KernelEvent | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: EventSink,
    private readonly windowMs = 60,
  ) {}

  emit(event: KernelEvent): Promise<void> {
    this.chain = this.chain.then(() => this.handle(event));
    return this.chain;
  }

  /** Drain anything buffered. Call before finalizing a turn. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.flushPending());
    return this.chain;
  }

  private async handle(event: KernelEvent): Promise<void> {
    const field = COALESCED[event.type];
    if (!field || typeof event.data[field] !== "string") {
      await this.flushPending();
      await this.inner.emit(event);
      return;
    }
    const p = this.pending;
    if (p && p.type === event.type && p.data["tool_use_id"] === event.data["tool_use_id"]) {
      p.data[field] = (p.data[field] as string) + (event.data[field] as string);
      return;
    }
    await this.flushPending();
    this.pending = { ...event, data: { ...event.data } };
    this.timer = setTimeout(() => void this.flush(), this.windowMs);
  }

  private async flushPending(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    if (p) await this.inner.emit(p);
  }
}
