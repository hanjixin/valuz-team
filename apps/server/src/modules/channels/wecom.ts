/**
 * WeCom (企业微信) smart bots. Like a Feishu bot, one is bound to an agent and
 * each chat becomes a session; the server dials WeCom's long connection with
 * the bot's id and secret, so no public URL is needed. The WeCom side is the
 * official SDK (`@wecom/aibot-node-sdk`).
 */
import { type WsFrame, WSClient } from "@wecom/aibot-node-sdk";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../infra/context.ts";
import * as chat from "./chat.ts";
import * as repo from "./repo.ts";

export const PLATFORM = "wecom-aibot";
const SECRET_PURPOSE = "channel";
const REPLY_LIMIT = 18_000;
const SYNC = "channels:wecom:sync";

export const seal = (ctx: Ctx, secret: string): string => ctx.box.seal(SECRET_PURPOSE, JSON.stringify({ secret }));
export const secretOf = (ctx: Ctx, binding: { secret_enc: string }): string =>
  (JSON.parse(ctx.box.open(SECRET_PURPOSE, binding.secret_enc)) as { secret?: string }).secret ?? "";

interface Link {
  client: WSClient;
  authenticated: boolean;
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
    link?.client.disconnect();
  } catch {
    // already closed
  }
}

interface Incoming {
  msgid?: string;
  chatid?: string;
  chattype?: string;
  msgtype?: string;
  from?: { userid?: string };
  text?: { content?: string };
}

/** Make this replica's long connection match the binding: dialled while enabled, hung up otherwise. */
async function reconcile(app: FastifyInstance, bindingId: string): Promise<void> {
  const ctx = app.ctx;
  hangUp(ctx, bindingId);
  const binding = await repo.byId(ctx.db, bindingId);
  if (!binding?.enabled || binding.platform !== PLATFORM) return;
  const quiet = (): void => undefined;
  const link: Link = {
    client: new WSClient({
      botId: binding.app_id,
      secret: secretOf(ctx, binding),
      ...(ctx.config.WECOM_WS_URL ? { wsUrl: ctx.config.WECOM_WS_URL } : {}),
      logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    }),
    authenticated: false,
    error: null,
  };
  link.client.on("authenticated", () => {
    link.authenticated = true;
    link.error = null;
  });
  link.client.on("disconnected", () => {
    link.authenticated = false;
  });
  link.client.on("error", (err: Error) => {
    link.error = err.message;
  });
  link.client.on("message", (frame: WsFrame<Incoming>) => {
    void receive(ctx, bindingId, frame.body ?? {}).catch((err: unknown) =>
      ctx.log(err, `channel ${bindingId}: message failed`),
    );
  });
  linksOf(ctx).set(bindingId, link);
  link.client.connect();
}

async function receive(ctx: Ctx, bindingId: string, message: Incoming): Promise<void> {
  // A single chat is addressed by the person; a group by its own id.
  const chatId = message.chatid || message.from?.userid || "";
  if (!chatId || !(await chat.firstTime(ctx, bindingId, message.msgid ?? ""))) return;
  const binding = await repo.byId(ctx.db, bindingId);
  if (!binding?.enabled) return;
  if (message.msgtype !== "text") return chat.decline(ctx, binding, chatId);
  // In a group the platform delivers only what mentions the bot, mention included.
  const text = (message.text?.content ?? "").replace(/^@\S+\s*/, "").trim();
  if (text) await chat.hear(ctx, binding, chatId, text);
}

async function send(ctx: Ctx, binding: repo.BindingRow, chatId: string, text: string): Promise<void> {
  const link = linksOf(ctx).get(binding.id);
  if (!link) throw new Error("this server holds no connection for the bot");
  const content = text.length > REPLY_LIMIT ? `${text.slice(0, REPLY_LIMIT)}\n…（内容过长，已截断）` : text;
  await link.client.sendMessage(chatId, { msgtype: "markdown", markdown: { content } });
}

chat.registerPlatform(PLATFORM, "企业微信", send);

/** The long connection as this replica sees it, in the words the app shows. */
export function connection(
  ctx: Ctx,
  binding: Pick<repo.BindingRow, "id" | "enabled">,
): { connected: boolean; connection_status: string; connection_error: string | null } {
  if (!binding.enabled) return { connected: false, connection_status: "disabled", connection_error: null };
  const link = linksOf(ctx).get(binding.id);
  if (!link) return { connected: false, connection_status: "disconnected", connection_error: null };
  return {
    connected: link.authenticated,
    connection_status: link.authenticated ? "connected" : link.error ? "error" : "connecting",
    connection_error: link.authenticated ? null : link.error,
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
  app.addHook("onReady", async () => {
    for (const { id } of await repo.listEnabled(ctx.db, PLATFORM)) follow(id);
  });
}
