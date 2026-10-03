/**
 * DeviceLink — the host end of the device link. Reconnects with backoff and
 * guarantees state delivery: every state frame stays in the outbox until the
 * server acks its uid, and the whole outbox is replayed in order after a
 * reconnect (the server dedupes by uid).
 */
import { DEVICE_LINK_PATH, type Actor, type HostFrame, ServerFrame } from "@agent-base/protocol";
import WebSocket from "ws";

type StateFrame = Extract<HostFrame, { uid: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type StateInput = DistributiveOmit<StateFrame, "uid"> & { uid?: string };

export interface LinkHandlers {
  hello(): Extract<HostFrame, { t: "hello" }>;
  rpc(method: string, params: unknown, actor: Actor): Promise<unknown>;
  status?(state: "online" | "offline" | "rejected", detail?: string): void;
}

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const PING_MS = 20_000;

export class DeviceLink {
  private socket: WebSocket | null = null;
  private readonly outbox = new Map<string, StateFrame>();
  private readonly sentAt = new Map<string, number>();
  private stopped = false;
  private attempt = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;
  private drained: (() => void)[] = [];

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly handlers: LinkHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.socket?.close(1000);
    this.socket = null;
  }

  get online(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Queue a state frame; it is delivered at least once, in order. */
  sendState(frame: StateInput): void {
    const full = { ...frame, uid: frame.uid ?? crypto.randomUUID() } as StateFrame;
    this.outbox.set(full.uid, full);
    this.transmit(full);
  }

  private transmit(frame: StateFrame): void {
    this.sentAt.set(frame.uid, Date.now());
    this.raw(frame);
  }

  /** Sessions with state still waiting to be acked — not stranded, just in flight. */
  pendingSessionIds(): string[] {
    const ids = new Set<string>();
    for (const f of this.outbox.values()) ids.add(f.t === "message.upsert" ? f.message.session_id : f.session_id);
    return [...ids];
  }

  /** Resolves once every queued state frame has been acked. */
  flushed(): Promise<void> {
    if (this.outbox.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.drained.push(resolve));
  }

  private raw(frame: HostFrame): void {
    if (this.online) this.socket?.send(JSON.stringify(frame));
  }

  private connect(): void {
    const url = this.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + DEVICE_LINK_PATH;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } });
    this.socket = socket;

    socket.on("open", () => {
      this.attempt = 0;
      this.lastPong = Date.now();
      this.raw(this.handlers.hello());
      for (const frame of this.outbox.values()) this.transmit(frame);
      this.pingTimer = setInterval(() => {
        // A link that stopped answering is dead even if TCP has not noticed.
        if (Date.now() - this.lastPong > PING_MS * 2.5) return socket.terminate();
        this.raw({ t: "ping" });
        // Anything still unacked after a full ping interval is sent again.
        const stale = Date.now() - PING_MS;
        for (const [uid, frame] of this.outbox) if ((this.sentAt.get(uid) ?? 0) < stale) this.transmit(frame);
      }, PING_MS);
      this.handlers.status?.("online");
    });

    socket.on("message", (raw) => void this.onMessage(raw.toString()));

    socket.on("close", (code, reason) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.socket === socket) this.socket = null;
      // 4401 bad token / 4403 revoked: retrying can never succeed.
      if (code === 4401 || code === 4403) {
        this.stopped = true;
        return this.handlers.status?.("rejected", reason.toString());
      }
      this.handlers.status?.("offline", reason.toString());
      if (this.stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });

    // The server refuses the upgrade itself (HTTP 401) for a bad or revoked token.
    socket.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.stopped = true;
        this.handlers.status?.("rejected", `HTTP ${res.statusCode}`);
      }
      socket.terminate();
    });

    socket.on("error", () => undefined); // `close` follows and drives the retry
  }

  private async onMessage(raw: string): Promise<void> {
    const parsed = ServerFrame.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.t) {
      case "pong":
      case "welcome":
        this.lastPong = Date.now();
        return;
      case "ack":
        for (const uid of frame.uids) {
          this.outbox.delete(uid);
          this.sentAt.delete(uid);
        }
        if (this.outbox.size === 0) for (const resolve of this.drained.splice(0)) resolve();
        return;
      case "rpc":
        try {
          const result = await this.handlers.rpc(frame.method, frame.params, frame.actor);
          this.raw({ t: "rpc.result", id: frame.id, ok: true, result });
        } catch (err) {
          const code = err instanceof RpcError ? err.code : "device_error";
          this.raw({ t: "rpc.result", id: frame.id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
        }
    }
  }
}
