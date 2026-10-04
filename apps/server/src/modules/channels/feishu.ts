/**
 * Feishu bots. One is bound to an agent; every chat the bot is in becomes a
 * session with that agent, and the agent's answers go back to the chat. The
 * Feishu side — tokens, the long connection, event decryption, sending — is the
 * official SDK; this maps chats to sessions.
 *
 * Events arrive over a long connection the server dials itself (no public URL
 * needed), and, for a binding given a Verification Token or Encrypt Key, at an
 * HTTP callback as well. Either way an event is handled once.
 */
import { createHash } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import type { FastifyInstance } from "fastify";
import { authFor } from "../../infra/auth.ts";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, forbidden, notFound } from "../../infra/errors.ts";
import * as notifications from "../notifications/service.ts";
import { type TurnEnd, dispatchTurn, enqueue } from "../sessions/dispatch.ts";
import * as sessions from "../sessions/service.ts";
import * as repo from "./repo.ts";

export const PLATFORM = "feishu";
const SECRET_PURPOSE = "channel";
const REPLY_LIMIT = 28_000;
const SYNC = "channels:sync";

export interface Secrets {
  app_secret: string;
  verification_token?: string;
  encrypt_key?: string;
}

export const seal = (ctx: Ctx, secrets: Secrets): string => ctx.box.seal(SECRET_PURPOSE, JSON.stringify(secrets));
export const secretsOf = (ctx: Ctx, binding: { secret_enc: string }): Secrets =>
  JSON.parse(ctx.box.open(SECRET_PURPOSE, binding.secret_enc)) as Secrets;

const domainOf = (ctx: Ctx): string | lark.Domain => ctx.config.FEISHU_API_BASE || lark.Domain.Feishu;

const clientFor = (ctx: Ctx, binding: repo.BindingRow): lark.Client =>
  new lark.Client({
    appId: binding.app_id,
    appSecret: secretsOf(ctx, binding).app_secret,
    domain: domainOf(ctx),
    loggerLevel: lark.LoggerLevel.error,
  });

/** Whether the platform accepts these app credentials; the reason when it does not. */
export async function checkCredentials(ctx: Ctx, binding: repo.BindingRow): Promise<string | null> {
  try {
    const res = (await clientFor(ctx, binding).auth.tenantAccessToken.internal({
      data: { app_id: binding.app_id, app_secret: secretsOf(ctx, binding).app_secret },
    })) as { code?: number; msg?: string };
    return res.code === 0 ? null : (res.msg ?? "unknown error");
  } catch (err) {
    return (err as Error).message;
  }
}

async function send(ctx: Ctx, binding: repo.BindingRow, chatId: string, text: string): Promise<void> {
  const body = text.length > REPLY_LIMIT ? `${text.slice(0, REPLY_LIMIT)}\n…（内容过长，已截断）` : text;
  await clientFor(ctx, binding).im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: body }) },
  });
}

// ------------------------------------------------------------------ long connections

interface Link {
  client: lark.WSClient;
  error: string | null;
}

/** The long connections this replica holds, by binding. */
const links = new WeakMap<Ctx, Map<string, Link>>();
const linksOf = (ctx: Ctx): Map<string, Link> => {
  let mine = links.get(ctx);
  if (!mine) links.set(ctx, (mine = new Map()));
  return mine;
};

function hangUp(ctx: Ctx, bindingId: string): void {
  const link = linksOf(ctx).get(bindingId);
  linksOf(ctx).delete(bindingId);
  try {
    link?.client.close();
  } catch {
    // already closed
  }
}

/** Make this replica's long connection match the binding: dialled while enabled, hung up otherwise. */
async function reconcile(app: FastifyInstance, bindingId: string): Promise<void> {
  const ctx = app.ctx;
  hangUp(ctx, bindingId);
  const binding = await repo.byId(ctx.db, bindingId);
  if (!binding?.enabled || binding.platform !== PLATFORM) return;
  // The connection is authenticated by the app credentials, so events on it need no
  // token or signature. With several replicas the platform delivers each event to
  // one connection; the event-id check in `receive` covers redelivery.
  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
    "im.message.receive_v1": async (data: Record<string, unknown>) => {
      const message = data["message"] as { message_id?: string } | undefined;
      await receive(app, bindingId, String(data["event_id"] ?? message?.message_id ?? ""), data);
    },
  });
  const link: Link = {
    client: new lark.WSClient({
      appId: binding.app_id,
      appSecret: secretsOf(ctx, binding).app_secret,
      domain: domainOf(ctx),
      loggerLevel: lark.LoggerLevel.error,
      onError: (err: Error) => {
        link.error = err.message;
      },
    }),
    error: null,
  };
  linksOf(ctx).set(bindingId, link);
  void link.client.start({ eventDispatcher: dispatcher }).catch((err: unknown) => {
    link.error = (err as Error).message;
  });
}

/** The long connection as this replica sees it, in the words the app shows. */
export function connection(
  ctx: Ctx,
  binding: Pick<repo.BindingRow, "id" | "enabled">,
): { connected: boolean; connection_status: string; connection_error: string | null } {
  if (!binding.enabled) return { connected: false, connection_status: "disabled", connection_error: null };
  const link = linksOf(ctx).get(binding.id);
  if (!link) return { connected: false, connection_status: "disconnected", connection_error: null };
  const connected = link.client.getConnectionStatus?.().state === "connected";
  return {
    connected,
    connection_status: connected ? "connected" : link.error ? "error" : "connecting",
    connection_error: connected ? null : link.error,
  };
}

/** Tell every replica that a binding was made, changed or switched off. */
export const sync = (ctx: Ctx, bindingId: string): Promise<void> => ctx.pubsub.publish(SYNC, { id: bindingId });

/** Dial the enabled bindings, and follow changes made on any replica. */
export async function start(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const follow = (id: string): void =>
    void reconcile(app, id).catch((err: unknown) => ctx.log(err, `channel ${id}: could not connect`));
  const unsubscribe = await ctx.pubsub.subscribe(SYNC, (payload) => follow((payload as { id: string }).id));
  app.addHook("onClose", async () => {
    unsubscribe();
    for (const id of [...linksOf(ctx).keys()]) hangUp(ctx, id);
  });
  // Once the server is ready (and its database migrated), not while it is being put together.
  app.addHook("onReady", async () => {
    for (const { id } of await repo.listEnabled(ctx.db, PLATFORM)) follow(id);
  });
}

// ------------------------------------------------------------------ events in

/**
 * One request to a binding's HTTP callback. Returns the JSON to answer with;
 * the platform expects it within three seconds, so the turn itself is started
 * in the background.
 */
export async function callback(
  app: FastifyInstance,
  bindingId: string,
  headers: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<unknown> {
  const ctx = app.ctx;
  const binding = /^[0-9a-f-]{36}$/i.test(bindingId) ? await repo.byId(ctx.db, bindingId) : undefined;
  if (!binding?.enabled || binding.platform !== PLATFORM) throw notFound("channel");
  const secrets = secretsOf(ctx, binding);
  // Without a token or a key nothing proves a request came from the platform: such a
  // binding hears events over its long connection only.
  if (!secrets.verification_token && !secrets.encrypt_key)
    throw new HttpError(409, "callback_not_configured", "this bot receives events over its long connection");

  // With an Encrypt Key the platform signs every request; check it before reading anything.
  if (secrets.encrypt_key) {
    const expected = createHash("sha256")
      .update(
        `${String(headers["x-lark-request-timestamp"])}${String(headers["x-lark-request-nonce"])}${secrets.encrypt_key}${JSON.stringify(body)}`,
      )
      .digest("hex");
    if (expected !== headers["x-lark-signature"]) throw forbidden("event signature mismatch");
  }
  const plain = (
    typeof body["encrypt"] === "string"
      ? JSON.parse(new lark.AESCipher(secrets.encrypt_key ?? "").decrypt(body["encrypt"]))
      : body
  ) as { type?: string; challenge?: string; token?: string; header?: Record<string, string>; event?: object };
  // The Verification Token is the only proof of origin when events are not encrypted.
  if (secrets.verification_token && (plain.header?.["token"] ?? plain.token) !== secrets.verification_token)
    throw forbidden("verification token mismatch");

  if (plain.type === "url_verification") return { challenge: plain.challenge };
  if (plain.header?.["event_type"] === "im.message.receive_v1")
    await receive(app, binding.id, String(plain.header["event_id"]), plain.event as Record<string, unknown>);
  return { code: 0 };
}

/** Take one message event, once: the platform redelivers until it is acknowledged. */
async function receive(app: FastifyInstance, bindingId: string, eventId: string, event: Record<string, unknown>) {
  const ctx = app.ctx;
  if (eventId && !(await ctx.redis.set(`channel-event:${bindingId}:${eventId}`, "1", "EX", 3600, "NX"))) return;
  const binding = await repo.byId(ctx.db, bindingId);
  if (!binding?.enabled) return;
  void onMessage(ctx, binding, event).catch((err: unknown) => ctx.log(err, `channel ${bindingId}: message failed`));
}

interface Incoming {
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: unknown[];
}

async function onMessage(ctx: Ctx, binding: repo.BindingRow, event: Record<string, unknown>): Promise<void> {
  const message = (event["message"] ?? {}) as Incoming;
  const chatId = message.chat_id ?? "";
  if (!chatId) return;
  // In a group the bot answers only when it is addressed.
  if (message.chat_type !== "p2p" && !(Array.isArray(message.mentions) && message.mentions.length > 0)) return;
  if (message.message_type !== "text") return send(ctx, binding, chatId, "目前只支持文本消息。");
  let text = "";
  try {
    text = String((JSON.parse(message.content ?? "") as { text?: string }).text ?? "");
  } catch {
    return;
  }
  text = text.replace(/@_user_\d+/g, "").trim();
  if (!text) return;

  if (text === "/new") {
    await repo.closeThread(ctx.db, binding.id, chatId);
    return send(ctx, binding, chatId, "已开始新会话。");
  }

  try {
    const owner = await authFor(ctx, binding.org_id, binding.owner_id);
    if (!owner) throw new Error("绑定这个机器人的成员已不在组织中");
    const sessionId = await sessionFor(ctx, binding, owner, chatId);
    try {
      await dispatchTurn(ctx, sessionId, text, { user_id: owner.userId, name: "飞书" });
    } catch (err) {
      if (!(err instanceof HttpError) || err.code !== "session_busy") throw err;
      // Mid-turn: it waits its turn like any message typed during a run.
      await enqueue(ctx, owner, sessionId, text);
    }
  } catch (err) {
    const offline = err instanceof HttpError && (err.code === "device_offline" || err.code === "no_device");
    await send(
      ctx,
      binding,
      chatId,
      offline ? "执行设备当前不在线，请稍后再试。" : `无法处理这条消息：${(err as Error).message}`,
    );
  }
}

/** The chat's session, created on first contact: the binding owner's, with the bound agent. */
async function sessionFor(ctx: Ctx, binding: repo.BindingRow, owner: Auth, chatId: string): Promise<string> {
  const existing = await repo.threadSession(ctx.db, binding.id, chatId);
  if (existing) return existing;
  const session = await sessions.create(
    ctx,
    owner,
    { project_id: "chat-default", agent_slug: binding.agent_slug, title: `飞书 · ${binding.agent_slug}` },
    { origin: "user", metadata: { valuz: { channel: { binding_id: binding.id, chat_id: chatId } } } },
  );
  return repo.openThread(ctx.db, binding.id, chatId, session.id);
}

// ------------------------------------------------------------------ answers out

/** A turn ended on a device: if the session belongs to a chat, answer there. */
export async function handleTurnEnd(ctx: Ctx, turn: TurnEnd): Promise<void> {
  if (turn.status === "running" || turn.status === "cancelled") return;
  const session = await sessions.byId(ctx, turn.session_id);
  const meta = (session?.metadata as { valuz?: { channel?: { binding_id?: string; chat_id?: string } } } | undefined)
    ?.valuz?.channel;
  if (!session || !meta?.binding_id || !meta.chat_id) return;
  const binding = await repo.byId(ctx.db, meta.binding_id);
  if (!binding) return;
  const text =
    turn.status === "completed"
      ? turn.assistant_message?.trim() || "（已完成，没有文字回复）"
      : `运行出错：${String((turn.error_message as { message?: unknown } | null)?.message ?? "未知错误")}`;
  try {
    await send(ctx, binding, meta.chat_id, text);
  } catch (err) {
    await notifications.notify(
      ctx,
      { orgId: binding.org_id, userId: binding.owner_id },
      {
        kind: "channel_send_failed",
        title: `飞书回复发送失败：${binding.agent_slug}`,
        body: (err as Error).message.slice(0, 300),
        route: `/conversation/${turn.session_id}`,
        sessionId: turn.session_id,
      },
    );
  }
}
