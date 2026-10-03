/**
 * DeviceHub — the server end of the device link.
 *
 * Holds the WebSocket of every host connected to this instance, routes RPCs to
 * them (through Redis when the device is linked to another replica), and
 * ingests the state they stream back: events get a global `seq` in Postgres,
 * then fan out over Redis to every SSE listener on any replica.
 */
import {
  type Actor,
  DeviceInfo,
  HostFrame,
  type Message,
  type RpcMethod,
  type RpcParams,
  type ServerFrame,
  type SessionPatch,
  type StoredEvent,
} from "@agent-base/protocol";
import type { WebSocket } from "ws";
import type { Db } from "./db.ts";
import { json } from "./db.ts";
import { HttpError } from "./http.ts";
import type { PubSub } from "./pubsub.ts";

const PRESENCE_TTL_S = 45;
export const sessionChannel = (sessionId: string): string => `sess:${sessionId}`;
export const orgChannel = (orgId: string): string => `org:${orgId}`;

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

type RelayMessage =
  | { k: "rpc"; id: string; deviceId: string; method: string; params: unknown; actor: Actor; replyTo: string }
  | { k: "result"; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } };

export type TurnEnd = Pick<Message, "id" | "session_id" | "status" | "assistant_message" | "error_message">;

export class DeviceOfflineError extends HttpError {
  constructor() {
    super(503, "device_offline", "the device is offline");
  }
}

export class DeviceHub {
  private readonly links = new Map<string, Link>();
  private readonly pending = new Map<string, PendingRpc>();
  /** RPCs relayed for another replica: rpc id → that replica's instance id. */
  private readonly relayed = new Map<string, string>();
  /** Notified when a turn reaches its final state (drives task orchestration). */
  onTurnEnd: ((message: TurnEnd) => Promise<void>) | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDrop: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly pubsub: PubSub,
    private readonly instanceId: string,
  ) {}

  async start(): Promise<void> {
    this.unsubscribeDrop = await this.pubsub.subscribe("dev:drop", (raw) => {
      this.links.get((raw as { deviceId: string }).deviceId)?.socket.close(4403, "device revoked");
    });
    this.unsubscribe = await this.pubsub.subscribe(`inst:${this.instanceId}`, (raw) => {
      const msg = raw as RelayMessage;
      if (msg.k === "result") return this.settle(msg.id, msg.ok, msg.result, msg.error);
      const link = this.links.get(msg.deviceId);
      if (!link) {
        void this.pubsub.publish(`inst:${msg.replyTo}`, {
          k: "result", id: msg.id, ok: false, error: { code: "device_offline", message: "the device is offline" },
        } satisfies RelayMessage);
        return;
      }
      this.relayed.set(msg.id, msg.replyTo);
      this.send(link, { t: "rpc", id: msg.id, method: msg.method, params: msg.params, actor: msg.actor });
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribeDrop?.();
    for (const [deviceId, link] of this.links) {
      link.socket.close(1001, "server shutting down");
      await this.pubsub.redis.del(`dev:on:${deviceId}`);
    }
    this.links.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DeviceOfflineError());
    }
    this.pending.clear();
  }

  private send(link: Link, frame: ServerFrame): void {
    if (link.socket.readyState === link.socket.OPEN) link.socket.send(JSON.stringify(frame));
  }

  async isOnline(deviceId: string): Promise<boolean> {
    return this.links.has(deviceId) || (await this.pubsub.redis.exists(`dev:on:${deviceId}`)) === 1;
  }

  async onlineSet(deviceIds: string[]): Promise<Set<string>> {
    if (deviceIds.length === 0) return new Set();
    const hits = await this.pubsub.redis.mget(deviceIds.map((id) => `dev:on:${id}`));
    return new Set(deviceIds.filter((_, i) => hits[i] !== null));
  }

  private touch(deviceId: string): Promise<unknown> {
    return this.pubsub.redis.set(`dev:on:${deviceId}`, this.instanceId, "EX", PRESENCE_TTL_S);
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
      const instance = await this.pubsub.redis.get(`dev:on:${deviceId}`);
      if (!instance || instance === this.instanceId) {
        this.settle(id, false, undefined, { code: "device_offline", message: "the device is offline" });
      } else {
        await this.pubsub.publish(`inst:${instance}`, {
          k: "rpc", id, deviceId, method, params, actor, replyTo: this.instanceId,
        } satisfies RelayMessage);
      }
    }
    return result;
  }

  private settle(id: string, ok: boolean, result: unknown, error?: { code: string; message: string }): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(result);
    else if (error?.code === "device_offline") p.reject(new DeviceOfflineError());
    else p.reject(new HttpError(error?.code === "forbidden" ? 403 : 502, error?.code ?? "device_error", error?.message ?? "device error"));
  }

  /** Close a device's link (revoked). Its socket may live on another replica. */
  drop(deviceId: string): Promise<void> {
    return this.pubsub.publish("dev:drop", { deviceId });
  }

  /** Adopt an authenticated device socket. */
  attach(deviceId: string, orgId: string, socket: WebSocket): void {
    this.links.get(deviceId)?.socket.close(4000, "replaced by a newer connection");
    const link: Link = { socket, orgId, chain: Promise.resolve() };
    this.links.set(deviceId, link);
    void this.touch(deviceId);
    this.send(link, { t: "welcome", device_id: deviceId, server_time: Date.now() });

    socket.on("message", (raw) => {
      link.chain = link.chain
        .then(() => this.onFrame(deviceId, link, raw.toString()))
        .catch((err: unknown) => console.error(`[device ${deviceId}] frame failed:`, err));
    });
    socket.on("close", () => {
      if (this.links.get(deviceId) !== link) return;
      this.links.delete(deviceId);
      void this.pubsub.redis.del(`dev:on:${deviceId}`);
      void this.db.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [deviceId]);
      void this.pubsub.publish(orgChannel(orgId), { type: "device.offline", device_id: deviceId });
    });
  }

  private async onFrame(deviceId: string, link: Link, raw: string): Promise<void> {
    const parsed = HostFrame.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.t) {
      case "ping":
        await this.touch(deviceId);
        return this.send(link, { t: "pong" });
      case "hello":
        return this.onHello(deviceId, link, frame.info, frame.running);
      case "rpc.result": {
        const origin = this.relayed.get(frame.id);
        if (origin) {
          this.relayed.delete(frame.id);
          await this.pubsub.publish(`inst:${origin}`, { k: "result", id: frame.id, ok: frame.ok, result: frame.result, error: frame.error } satisfies RelayMessage);
        } else {
          this.settle(frame.id, frame.ok, frame.result, frame.error);
        }
        return;
      }
      case "event":
        if (await this.owns(deviceId, frame.session_id)) await this.ingestEvent(frame);
        return this.send(link, { t: "ack", uids: [frame.uid] });
      case "session.patch":
        if (await this.owns(deviceId, frame.session_id)) await this.applyPatch(link.orgId, frame.session_id, frame.patch);
        return this.send(link, { t: "ack", uids: [frame.uid] });
      case "message.upsert":
        if (await this.owns(deviceId, frame.message.session_id)) {
          await this.upsertMessage(frame.message);
          this.turnEnded(frame.message);
        }
        return this.send(link, { t: "ack", uids: [frame.uid] });
    }
  }

  private turnEnded(message: TurnEnd): void {
    if (message.status === "running" || !this.onTurnEnd) return;
    // Never hold the device's frame queue hostage to orchestration work.
    void this.onTurnEnd(message).catch((err: unknown) => console.error(`[turn-end ${message.session_id}]`, err));
  }

  /** A device may only write state for sessions bound to it. */
  private async owns(deviceId: string, sessionId: string): Promise<boolean> {
    return (await this.db.one("SELECT 1 FROM sessions WHERE id = $1 AND device_id = $2", [sessionId, deviceId])) !== null;
  }

  private async onHello(deviceId: string, link: Link, info: DeviceInfo, running: string[]): Promise<void> {
    await this.db.query("UPDATE devices SET info = $2, last_seen_at = now() WHERE id = $1", [deviceId, json(DeviceInfo.parse(info))]);
    // Anything the server believes is running but the host does not know about
    // died with the host's previous process.
    const stranded = await this.db.query<{ id: string }>(
      `UPDATE sessions SET status = 'idle', updated_at = now(),
              stop_reason = '{"type":"error","category":"interrupted","retry_status":"terminal","message":"device restarted mid-turn"}'
        WHERE device_id = $1 AND status = 'running' AND NOT (id = ANY($2::uuid[])) RETURNING id`,
      [deviceId, running],
    );
    for (const { id } of stranded) {
      const died = await this.db.query<{ id: string }>(
        "UPDATE messages SET status = 'errored', ended_at = $2 WHERE session_id = $1 AND status = 'running' RETURNING id",
        [id, Date.now()],
      );
      for (const m of died) {
        this.turnEnded({ id: m.id, session_id: id, status: "errored", assistant_message: null, error_message: { message: "device restarted mid-turn" } });
      }
      await this.pubsub.publish(orgChannel(link.orgId), { type: "session.updated", session_id: id, status: "idle" });
    }
    await this.pubsub.publish(orgChannel(link.orgId), { type: "device.online", device_id: deviceId });
  }

  private async ingestEvent(frame: Extract<HostFrame, { t: "event" }>): Promise<void> {
    const row = await this.db.one<{ seq: number }>(
      `INSERT INTO events (session_id, message_id, type, data, ts, event_uid) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_uid) DO NOTHING RETURNING seq`,
      [frame.session_id, frame.message_id, frame.type, json(frame.data), frame.timestamp, frame.uid],
    );
    if (!row) return; // a retry of a frame already stored
    const stored: StoredEvent = {
      seq: row.seq,
      session_id: frame.session_id,
      message_id: frame.message_id,
      type: frame.type,
      data: frame.data,
      timestamp: frame.timestamp,
      event_uid: frame.uid,
    };
    await this.pubsub.publish(sessionChannel(frame.session_id), stored);
  }

  private async applyPatch(orgId: string, sessionId: string, patch: SessionPatch): Promise<void> {
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [sessionId];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.stop_reason !== undefined) set("stop_reason", json(patch.stop_reason));
    if (patch.runtime_session_id !== undefined) set("runtime_session_id", patch.runtime_session_id);
    if (patch.todos !== undefined) set("todos", json(patch.todos));
    if (patch.mode !== undefined) set("mode", patch.mode);
    await this.db.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $1`, params);
    if (patch.status !== undefined) {
      await this.pubsub.publish(orgChannel(orgId), { type: "session.updated", session_id: sessionId, status: patch.status });
    }
  }

  private async upsertMessage(m: Message): Promise<void> {
    await this.db.query(
      `INSERT INTO messages (id, session_id, user_message, status, assistant_message, error_message, stop_reason, total_turns,
                             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model_usage, metadata, todos, started_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status, assistant_message = EXCLUDED.assistant_message, error_message = EXCLUDED.error_message,
         stop_reason = EXCLUDED.stop_reason, total_turns = EXCLUDED.total_turns, input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens, cache_read_tokens = EXCLUDED.cache_read_tokens,
         cache_write_tokens = EXCLUDED.cache_write_tokens, model_usage = EXCLUDED.model_usage,
         metadata = EXCLUDED.metadata, todos = EXCLUDED.todos, ended_at = EXCLUDED.ended_at`,
      [
        m.id, m.session_id, json(m.user_message), m.status, m.assistant_message, json(m.error_message), json(m.stop_reason),
        m.total_turns, m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_write_tokens, json(m.model_usage),
        json(m.metadata), json(m.todos), m.started_at, m.ended_at,
      ],
    );
  }
}
