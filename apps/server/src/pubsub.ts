/** Redis pub/sub with per-channel local fan-out (one subscriber connection). */
import { Redis } from "ioredis";

type Handler = (payload: unknown) => void;

export class PubSub {
  readonly redis: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: null });
    // No ready check on the subscriber: its INFO probe races a queued SUBSCRIBE
    // and Redis rejects INFO on a connection already in subscriber mode.
    this.sub = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
    // A dropped connection is retried by ioredis; it must never take the process down.
    for (const [name, client] of [["redis", this.redis], ["redis-sub", this.sub]] as const) {
      client.on("error", (err: Error) => console.error(`[${name}] ${err.message}`));
    }
    this.sub.on("message", (channel: string, raw: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      const payload: unknown = JSON.parse(raw);
      for (const handler of [...set]) handler(payload);
    });
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.redis.publish(channel, JSON.stringify(payload));
  }

  /** Resolves once the subscription is live, so nothing published after is missed. */
  async subscribe(channel: string, handler: Handler): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(handler);
    return () => {
      const current = this.handlers.get(channel);
      if (!current?.delete(handler) || current.size > 0) return;
      this.handlers.delete(channel);
      void this.sub.unsubscribe(channel).catch(() => undefined);
    };
  }

  async close(): Promise<void> {
    this.sub.disconnect();
    this.redis.disconnect();
  }
}
