/** Redis pub/sub with per-channel local fan-out, over one subscriber connection. */
import type { Redis } from "ioredis";

type Listener = (payload: unknown) => void;

export class PubSub {
  private readonly sub: Redis;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly redis: Redis,
    onError: (err: Error) => void,
  ) {
    // No ready check on the subscriber: its INFO probe races a queued SUBSCRIBE,
    // and Redis rejects INFO on a connection already in subscriber mode.
    this.sub = redis.duplicate({ enableReadyCheck: false });
    // A dropped connection is retried by ioredis; it must never take the process down.
    this.sub.on("error", onError);
    this.sub.on("message", (channel: string, raw: string) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      const payload: unknown = JSON.parse(raw);
      for (const listener of [...set]) listener(payload);
    });
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.redis.publish(channel, JSON.stringify(payload));
  }

  /** Resolves once the subscription is live, so nothing published afterwards is missed. */
  async subscribe(channel: string, listener: Listener): Promise<() => void> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(channel);
      if (!current?.delete(listener) || current.size > 0) return;
      this.listeners.delete(channel);
      void this.sub.unsubscribe(channel).catch(() => undefined);
    };
  }

  close(): void {
    this.sub.disconnect();
  }
}

/** Where changes inside one organization are announced (devices coming and going, session status…). */
export const orgChannel = (orgId: string): string => `org:${orgId}`;
