/**
 * Device link — the WebSocket protocol between a desktop host and the server.
 *
 * The server is the system of record; a host is an execution node. The server
 * sends `rpc` frames (run a turn, interrupt, browse files, …) and the host
 * streams back kernel state (`event`, `session.patch`, `message.upsert`). Every
 * host→server state frame carries a `uid` and is retried until `ack`ed, so a
 * dropped connection never loses or duplicates an event.
 */
import { z } from "zod";
import { Message, Session, SkillBundle, SubmitAction, UserMessage } from "./domain.ts";

export const DEVICE_LINK_PATH = "/v1/devices/link";
export const DEVICE_LINK_VERSION = 1;

export const RuntimeAvailability = z.object({
  runtime: z.string(),
  available: z.boolean(),
  detail: z.string().default(""),
});
export type RuntimeAvailability = z.infer<typeof RuntimeAvailability>;

export const DeviceInfo = z.object({
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  host_version: z.string(),
  runtimes: z.array(RuntimeAvailability).default([]),
  /** Absolute folders the owner exposes to remote file browsing / sessions. */
  shared_roots: z.array(z.string()).default([]),
  /** Whether the owner allows remote `exec.run`. */
  allow_exec: z.boolean().default(false),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

// -- RPC: server → host --

/** Who asked. Hosts log it and can enforce local policy on top of server ACL. */
export const Actor = z.object({ user_id: z.string(), name: z.string().default("") });
export type Actor = z.infer<typeof Actor>;

export const RpcMethods = {
  "session.run": z.object({
    session: Session,
    message_id: z.string(),
    user_message: UserMessage,
    skill_bundles: z.array(SkillBundle).default([]),
  }),
  "session.interrupt": z.object({ session_id: z.string() }),
  "session.action": z.object({ session_id: z.string(), action: SubmitAction }),
  "session.close": z.object({ session_id: z.string() }),
  "fs.list": z.object({ path: z.string() }),
  "fs.stat": z.object({ path: z.string() }),
  "fs.read": z.object({ path: z.string(), max_bytes: z.number().int().default(1_048_576) }),
  "fs.write": z.object({
    path: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  }),
  "fs.mkdir": z.object({ path: z.string() }),
  "exec.run": z.object({
    command: z.string(),
    cwd: z.string(),
    timeout_ms: z.number().int().max(600_000).default(60_000),
  }),
  "device.info": z.object({}),
} as const;
export type RpcMethod = keyof typeof RpcMethods;
export type RpcParams<M extends RpcMethod> = z.input<(typeof RpcMethods)[M]>;

export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "dir", "symlink", "other"]),
  size: z.number().default(0),
  mtime_ms: z.number().default(0),
});
export type FsEntry = z.infer<typeof FsEntry>;

export const ServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("welcome"), device_id: z.string(), server_time: z.number() }),
  z.object({ t: z.literal("ack"), uids: z.array(z.string()) }),
  z.object({
    t: z.literal("rpc"),
    id: z.string(),
    method: z.string(),
    params: z.unknown(),
    actor: Actor,
  }),
  z.object({ t: z.literal("pong") }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// -- State: host → server --

export const SessionPatch = Session.pick({
  status: true,
  stop_reason: true,
  runtime_session_id: true,
  todos: true,
  mode: true,
  metadata: true,
}).partial();
export type SessionPatch = z.infer<typeof SessionPatch>;

export const HostFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), v: z.number(), info: DeviceInfo, running: z.array(z.string()) }),
  z.object({
    t: z.literal("event"),
    uid: z.string(),
    session_id: z.string(),
    message_id: z.string(),
    type: z.string(),
    data: z.record(z.unknown()),
    timestamp: z.number(),
  }),
  z.object({
    t: z.literal("session.patch"),
    uid: z.string(),
    session_id: z.string(),
    patch: SessionPatch,
  }),
  z.object({ t: z.literal("message.upsert"), uid: z.string(), message: Message }),
  z.object({
    t: z.literal("rpc.result"),
    id: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({ t: z.literal("ping") }),
]);
export type HostFrame = z.infer<typeof HostFrame>;
