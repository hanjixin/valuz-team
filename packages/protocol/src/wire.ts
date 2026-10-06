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
import { Message, RuntimeProvider, Session, SkillBundle, SubmitAction, UserMessage } from "./domain.ts";

export const DEVICE_LINK_PATH = "/v1/devices/link";
export const DEVICE_LINK_VERSION = 1;

/**
 * A session's `cwd` is normally a folder on the device. One that has no folder
 * of its own — a quick chat, a project not bound to a folder — is given a
 * workspace the host manages: `@managed/<name>` resolves to a directory under
 * the host's own data directory, created on first use.
 */
export const MANAGED_CWD_PREFIX = "@managed/";
export const managedCwd = (name: string): string => `${MANAGED_CWD_PREFIX}${name}`;
/** The workspace name in a managed cwd, or null for an ordinary path (or a malformed token). */
export function managedWorkspace(cwd: string): string | null {
  if (!cwd.startsWith(MANAGED_CWD_PREFIX)) return null;
  const name = cwd.slice(MANAGED_CWD_PREFIX.length);
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(name) ? name : null;
}

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

/**
 * A session may be given MCP servers that the server itself hosts (the task
 * toolkit). The server does not know the address a device reaches it by, so it
 * writes this prefix and the host puts its own configured server URL in.
 */
export const SERVER_URL_PLACEHOLDER = "agent-base-server:";

// -- RPC: server → host --

/** Who asked. Hosts log it and can enforce local policy on top of server ACL. */
export const Actor = z.object({ user_id: z.string(), name: z.string().default("") });
export type Actor = z.infer<typeof Actor>;

/** A chat-app bot as a device needs it to hold the bot's connection: its credentials go only to that device. */
export const ChannelBot = z.object({
  id: z.string(),
  platform: z.enum(["feishu", "wecom-aibot"]),
  app_id: z.string(),
  secret: z.string(),
  /** The platform's address, when it is not the public one. */
  endpoint: z.string().default(""),
});
export type ChannelBot = z.infer<typeof ChannelBot>;

/** A group a bot is in, as its platform describes it. */
export interface ChannelChat {
  chat_id: string;
  name: string;
  /** The bot made the group, so it owns it and may dissolve it. */
  bot_owned: boolean;
  /** Somebody besides the bot is in it. */
  has_people: boolean;
}

export interface ChannelBotStatus {
  connected: boolean;
  status: "connected" | "connecting" | "error";
  error: string | null;
}

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
  /**
   * Ask a model one question on this device, outside any conversation: a
   * throwaway session takes one turn and its answer comes back. Nothing of it
   * is stored anywhere.
   */
  "session.ask": z.object({ session: Session, prompt: z.string(), timeout_ms: z.number().int().default(120_000) }),
  /** Branch a session's thread into a new session's — all of it, or up to an anchor a turn recorded. */
  "session.fork": z.object({
    source_session_id: z.string(),
    session_id: z.string(),
    runtime_provider: RuntimeProvider,
    anchor: z.record(z.string(), z.unknown()).nullable().default(null),
  }),
  "fs.list": z.object({ path: z.string() }),
  "fs.stat": z.object({ path: z.string() }),
  "fs.read": z.object({ path: z.string(), max_bytes: z.number().int().default(1_048_576) }),
  "fs.write": z.object({
    path: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  }),
  "fs.mkdir": z.object({ path: z.string() }),
  /** A folder as a tree, to `depth` levels. Capped: a tree cut short says so with `truncated`. */
  "fs.tree": z.object({
    path: z.string(),
    depth: z.number().int().min(1).max(5).default(2),
    include_hidden: z.boolean().default(false),
  }),
  "exec.run": z.object({
    command: z.string(),
    cwd: z.string(),
    timeout_ms: z.number().int().max(600_000).default(60_000),
  }),
  "device.info": z.object({}),
  /**
   * The chat-app bots this device keeps connected: all of them, each time. The
   * device dials what is listed and enabled, and hangs up everything else.
   */
  "channels.sync": z.object({ bots: z.array(ChannelBot) }),
  /** Post text to one of a bot's chats. */
  "channels.send": z.object({ bot_id: z.string(), chat_id: z.string(), text: z.string() }),
  /**
   * The groups a bot is in, on its platform: list them, make one (the bot in it), ask for a
   * join link, dissolve one the bot made. Asked of the device that keeps the bot connected —
   * it is the one that speaks to the platform.
   */
  "channels.chats": z.object({
    bot_id: z.string(),
    op: z.enum(["list", "create", "link", "remove"]),
    /** create: the new group's name. */
    name: z.string().default(""),
    /** link / remove: the group. */
    chat_id: z.string().default(""),
  }),
  /** Which of these skill packages (by digest) the device does not hold yet. */
  "skills.missing": z.object({ hashes: z.array(z.string()) }),
  /** How each bot's connection stands. */
  "channels.status": z.object({}),
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

export interface FsTreeNode {
  name: string;
  type: "file" | "directory";
  size: number | null;
  /** ISO time of last modification. */
  modified: string | null;
  children?: FsTreeNode[];
  /** Set on a directory whose contents were cut short (depth or entry cap). */
  truncated?: boolean;
}

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
  // Something said to a bot this device keeps connected. Resent until acked, like all state.
  z.object({
    t: z.literal("channel.message"),
    uid: z.string(),
    bot_id: z.string(),
    /** The platform's own id for the message, so a redelivery is recognised. */
    event_id: z.string(),
    chat_id: z.string(),
    /** Null for what is not text (an image, a file). */
    text: z.string().nullable(),
  }),
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
