/**
 * Feishu bots. One is bound to an agent; every chat the bot is in becomes a
 * session with that agent, and the agent's answers go back to the chat.
 *
 * The bot's long connection is dialled by the binder's device (`lines.ts`), not
 * here. What the server does itself: check the app's credentials when asked,
 * and — for a binding given a Verification Token or Encrypt Key — take events
 * at an HTTP callback as well. Either way an event is handled once.
 */
import { createHash } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../infra/context.ts";
import { HttpError, forbidden, notFound } from "../../infra/errors.ts";
import * as chat from "./chat.ts";
import * as repo from "./repo.ts";

export const PLATFORM = "feishu";
const SECRET_PURPOSE = "channel";

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

const REPLY_LIMIT = 18_000;

/** Posting needs no connection, so the server can still answer a chat while the bot's device is away. */
chat.registerDirectSend(PLATFORM, async (ctx, binding, chatId, text) => {
  const body = text.length > REPLY_LIMIT ? `${text.slice(0, REPLY_LIMIT)}\n…（内容过长，已截断）` : text;
  await clientFor(ctx, binding).im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: body }) },
  });
});

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
  if (!(await chat.firstTime(ctx, bindingId, eventId))) return;
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
  if (message.message_type !== "text") return chat.decline(ctx, binding, chatId);
  let text = "";
  try {
    text = String((JSON.parse(message.content ?? "") as { text?: string }).text ?? "");
  } catch {
    return;
  }
  text = text.replace(/@_user_\d+/g, "").trim();
  if (text) await chat.hear(ctx, binding, chatId, text);
}
