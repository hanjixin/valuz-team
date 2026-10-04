/**
 * DeviceHub — the server end of the device link (the WebSocket between a
 * desktop host and the server; see `@agent-base/protocol`).
 *
 * It is transport only: it holds the socket of every host connected to this
 * replica, tracks presence in Redis, and routes RPCs to a device — through
 * Redis when the device is linked to another replica. What a hello or a state
 * frame *means* is decided by the modules that subscribe to it.
 */
import {
  type Actor,
  type DeviceInfo,
  HostFrame,
  type RpcMethod,
  type RpcParams,
  type ServerFrame,
} from "@agent-base/protocol";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import { HttpError } from "./errors.ts";
import type { PubSub } from "./pubsub.ts";

const PRESENCE_TTL_S = 45;
const presenceKey = (deviceId: string): string => `dev:on:${deviceId}`;

export type StateFrame = Extract<HostFrame, { uid: string }>;

export interface HubListener {
  /** A host (re)connected. `running` are the sessions it is still working on. */
  hello?(device: { id: string; orgId: string }, info: DeviceInfo, running: string[]): Promise<void>;
  /**
   * A state frame arrived. It is acked — and so never sent again — only once
   * every listener resolved, so handling must be idempotent on `frame.uid`.
   */
  state?(device: { id: string; orgId: string }, frame: StateFrame): Promise<void>;
  /** The device's link closed. */
  closed?(device: { id: string; orgId: string }): Promise<void>;
}

interface Link {
  socket: WebSocket;
  orgId: string;
  /** Frames are applied strictly in arrival order. */
  chain: Promise<void>;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcError {
  code: string;
  message: string;
}

type RelayMessage =
  | { k: "rpc"; id: string; deviceId: string; method: string; params: unknown; actor: Actor; replyTo: string }
  | { k: "result"; id: string; ok: boolean; result?: unknown; error?: RpcError };

const OFFLINE: RpcError = { code: "device_offline", message: "the device is offline" };

export class DeviceOfflineError extends HttpError {
  constructor() {
    super(503, OFFLINE.code, OFFLINE.message);
  }
}

export class DeviceHub {
  private readonly links = new Map<string, Link>();
  private readonly pending = new Map<string, PendingRpc>();
  /** RPCs relayed for another replica: rpc id → that replica's instance id. */
  private readonly relayed = new Map<string, string>();
  private readonly listeners: HubListener[] = [];
  private unsubscribe: (() => void)[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly pubsub: PubSub,
    private readonly instanceId: string,
    private readonly logError: (err: unknown, message: string) => void,
  ) {}

  listen(listener: HubListener): void {
    this.listeners.push(listener);
  }

  async start(): Promise<void> {
    this.unsubscribe = [
      await this.pubsub.subscribe("dev:drop", (raw) => {
        this.links.get((raw as { deviceId: string }).deviceId)?.socket.close(4403, "device revoked");
      }),
      await this.pubsub.subscribe(`inst:${this.instanceId}`, (raw) => {
        const msg = raw as RelayMessage;
        if (msg.k === "result") return this.settle(msg.id, msg.ok, msg.result, msg.error);
        const link = this.links.get(msg.deviceId);
        if (!link) return void this.relay(msg.replyTo, { k: "result", id: msg.id, ok: false, error: OFFLINE });
        this.relayed.set(msg.id, msg.replyTo);
        this.send(link, { t: "rpc", id: msg.id, method: msg.method, params: msg.params, actor: msg.actor });
      }),
    ];
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribe) off();
    const linked = [...this.links.keys()];
    for (const link of this.links.values()) link.socket.close(1001, "server shutting down");
    this.links.clear();
    if (linked.length) await this.redis.del(linked.map(presenceKey)).catch(() => undefined);
    for (const rpc of this.pending.values()) {
      clearTimeout(rpc.timer);
      rpc.reject(new DeviceOfflineError());
    }
    this.pending.clear();
  }

  private relay(instance: string, message: RelayMessage): Promise<void> {
    return this.pubsub.publish(`inst:${instance}`, message);
  }

  private send(link: Link, frame: ServerFrame): void {
    if (link.socket.readyState === link.socket.OPEN) link.socket.send(JSON.stringify(frame));
  }

  /** Which of these devices are linked right now, to any replica. */
  async online(deviceIds: string[]): Promise<Set<string>> {
    if (deviceIds.length === 0) return new Set();
    const hits = await this.redis.mget(deviceIds.map(presenceKey));
    return new Set(deviceIds.filter((id, i) => hits[i] !== null || this.links.has(id)));
  }

  private touch(deviceId: string): Promise<unknown> {
    return this.redis.set(presenceKey(deviceId), this.instanceId, "EX", PRESENCE_TTL_S);
  }

  /** Call a method on a device and await its result. */
  async call<M extends RpcMethod>(
    deviceId: string,
    method: M,
    params: RpcParams<M>,
    actor: Actor,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const id = crypto.randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HttpError(504, "device_timeout", `the device did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    const link = this.links.get(deviceId);
    if (link) {
      this.send(link, { t: "rpc", id, method, params, actor });
    } else {
      const instance = await this.redis.get(presenceKey(deviceId));
      if (!instance || instance === this.instanceId) this.settle(id, false, undefined, OFFLINE);
      else await this.relay(instance, { k: "rpc", id, deviceId, method, params, actor, replyTo: this.instanceId });
    }
    return result;
  }

  private settle(id: string, ok: boolean, result: unknown, error?: RpcError): void {
    const rpc = this.pending.get(id);
    if (!rpc) return;
    this.pending.delete(id);
    clearTimeout(rpc.timer);
    if (ok) return rpc.resolve(result);
    if (error?.code === OFFLINE.code) return rpc.reject(new DeviceOfflineError());
    // The device's own refusals keep their meaning; anything else is the device failing.
    const status = { forbidden: 403, bad_request: 400, not_found: 404, too_large: 413 }[error?.code ?? ""] ?? 502;
    rpc.reject(new HttpError(status, error?.code ?? "device_error", error?.message ?? "device error"));
  }

  /** Close a device's link wherever it is connected (its token was revoked). */
  drop(deviceId: string): Promise<void> {
    return this.pubsub.publish("dev:drop", { deviceId });
  }

  /** Adopt an authenticated device socket. */
  attach(deviceId: string, orgId: string, socket: WebSocket): void {
    this.links.get(deviceId)?.socket.close(4000, "replaced by a newer connection");
    const link: Link = { socket, orgId, chain: Promise.resolve() };
    const device = { id: deviceId, orgId };
    this.links.set(deviceId, link);
    void this.touch(deviceId);
    this.send(link, { t: "welcome", device_id: deviceId, server_time: Date.now() });

    socket.on("message", (raw) => {
      link.chain = link.chain
        .then(() => this.onFrame(device, link, raw.toString()))
        .catch((err: unknown) => this.logError(err, `device ${deviceId}: frame failed`));
    });
    socket.on("close", () => {
      if (this.links.get(deviceId) !== link) return; // replaced by a newer connection
      this.links.delete(deviceId);
      void this.redis
        .del(presenceKey(deviceId))
        .then(() => Promise.all(this.listeners.map((l) => l.closed?.(device))))
        .catch((err: unknown) => this.logError(err, `device ${deviceId}: close handling failed`));
    });
  }

  private async onFrame(device: { id: string; orgId: string }, link: Link, raw: string): Promise<void> {
    const parsed = HostFrame.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.t) {
      case "ping":
        await this.touch(device.id);
        return this.send(link, { t: "pong" });
      case "hello":
        for (const listener of this.listeners) await listener.hello?.(device, frame.info, frame.running);
        return;
      case "rpc.result": {
        const origin = this.relayed.get(frame.id);
        if (!origin) return this.settle(frame.id, frame.ok, frame.result, frame.error);
        this.relayed.delete(frame.id);
        return this.relay(origin, {
          k: "result",
          id: frame.id,
          ok: frame.ok,
          result: frame.result,
          ...(frame.error ? { error: frame.error } : {}),
        });
      }
      default:
        // A listener that fails leaves the frame unacked: the host sends it again.
        for (const listener of this.listeners) await listener.state?.(device, frame);
        return this.send(link, { t: "ack", uids: [frame.uid] });
    }
  }
}
