/**
 * DeviceLink — the host end of the device link. Reconnection and backoff are
 * partysocket's; on top of it this guarantees state delivery: every state
 * frame stays in the outbox until the server acks its uid, and the whole
 * outbox is replayed in order after a reconnect (the server dedupes by uid).
 */
import { type Actor, DEVICE_LINK_PATH, type HostFrame, ServerFrame } from "@agent-base/protocol";
import ReconnectingWebSocket from "partysocket/ws";
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
/** Close codes after which retrying can never succeed: bad token, revoked device. */
const REJECTED = new Set([4401, 4403]);

export class DeviceLink {
  private socket: ReconnectingWebSocket | null = null;
  private readonly outbox = new Map<string, StateFrame>();
  private readonly sentAt = new Map<string, number>();
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;
  private drained: (() => void)[] = [];

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly handlers: LinkHandlers,
  ) {}

  start(): void {
    const headers = { authorization: `Bearer ${this.token}` };
    // The device authenticates on the upgrade request itself.
    class AuthenticatedSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers });
      }
    }
    const url = this.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + DEVICE_LINK_PATH;
    const socket = new ReconnectingWebSocket(url, [], {
      WebSocket: AuthenticatedSocket,
      minReconnectionDelay: 500,
      maxReconnectionDelay: 30_000,
      // Nothing is queued by the socket: unacked state is replayed from the outbox instead.
      maxEnqueuedMessages: 0,
      shouldReconnectOnClose: (event) => !REJECTED.has(event.code),
    });
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.lastPong = Date.now();
      this.raw(this.handlers.hello());
      for (const frame of this.outbox.values()) this.transmit(frame);
      this.stopPinging();
      this.pingTimer = setInterval(() => {
        // A link that stopped answering is dead even if TCP has not noticed.
        if (Date.now() - this.lastPong > PING_MS * 2.5) return socket.reconnect();
        this.raw({ t: "ping" });
        // Anything still unacked after a full ping interval is sent again.
        const stale = Date.now() - PING_MS;
        for (const [uid, frame] of this.outbox) if ((this.sentAt.get(uid) ?? 0) < stale) this.transmit(frame);
      }, PING_MS);
      this.handlers.status?.("online");
    });
    socket.addEventListener("message", (event) => void this.onMessage(String(event.data)));
    socket.addEventListener("close", (event) => {
      this.stopPinging();
      if (REJECTED.has(event.code)) return this.reject(event.reason);
      this.handlers.status?.("offline", event.reason);
    });
    socket.addEventListener("error", (event) => {
      // The server refuses the upgrade itself (HTTP 401/403) for a bad or revoked token.
      const refused = /Unexpected server response: (401|403)/.exec(event.message ?? "");
      if (refused) this.reject(`HTTP ${refused[1]}`);
    });
  }

  private reject(detail: string): void {
    this.socket?.close();
    this.socket = null;
    this.handlers.status?.("rejected", detail);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  async stop(): Promise<void> {
    this.stopPinging();
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
          this.raw({
            t: "rpc.result",
            id: frame.id,
            ok: false,
            error: { code, message: err instanceof Error ? err.message : String(err) },
          });
        }
    }
  }
}
