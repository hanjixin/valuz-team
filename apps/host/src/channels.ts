/**
 * The chat-app bots this device keeps connected. A member binds a bot to an
 * agent on the server; the server hands the bot's credentials to that member's
 * device, and the device — which is where the agent runs anyway — dials the
 * platform's long connection, passes on what people say, and posts the answers.
 * The server holds no connection to any chat platform.
 *
 * The platform sides are the official SDKs.
 */
import * as lark from "@larksuiteoapi/node-sdk";
import type { ChannelBot, ChannelBotStatus, ChannelChat } from "@agent-base/protocol";
import { type WsFrame, WSClient as WeComClient } from "@wecom/aibot-node-sdk";

const REPLY_LIMIT = 18_000;

/** What a person said to a bot, as the server is told of it. */
export interface Heard {
  bot_id: string;
  event_id: string;
  chat_id: string;
  text: string | null;
}

/** What can be asked about a bot's groups, and what comes back. */
export type ChatsRequest = { op: "list" | "create" | "link" | "remove"; name: string; chat_id: string };

interface Line {
  bot: ChannelBot;
  send(chatId: string, text: string): Promise<void>;
  /** The bot's groups on its platform; absent where the platform offers no such thing. */
  chats?(request: ChatsRequest): Promise<unknown>;
  status(): ChannelBotStatus;
  close(): void;
}

const clip = (text: string): string =>
  text.length > REPLY_LIMIT ? `${text.slice(0, REPLY_LIMIT)}\n…（内容过长，已截断）` : text;

function feishu(bot: ChannelBot, heard: (message: Heard) => void): Line {
  const domain = bot.endpoint || lark.Domain.Feishu;
  const options = { appId: bot.app_id, appSecret: bot.secret, domain, loggerLevel: lark.LoggerLevel.error };
  const api = new lark.Client(options);
  let error: string | null = null;
  // The connection is authenticated by the app credentials, so events on it need no token or signature.
  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
    "im.message.receive_v1": async (data: Record<string, unknown>) => {
      const message = (data["message"] ?? {}) as {
        message_id?: string;
        chat_id?: string;
        chat_type?: string;
        message_type?: string;
        content?: string;
        mentions?: unknown[];
      };
      if (!message.chat_id) return;
      // In a group the bot answers only when it is addressed.
      if (message.chat_type !== "p2p" && !(Array.isArray(message.mentions) && message.mentions.length > 0)) return;
      let text: string | null = null;
      if (message.message_type === "text") {
        try {
          text = String((JSON.parse(message.content ?? "") as { text?: string }).text ?? "")
            .replace(/@_user_\d+/g, "")
            .trim();
        } catch {
          return;
        }
        if (!text) return;
      }
      heard({
        bot_id: bot.id,
        event_id: String(data["event_id"] ?? message.message_id ?? ""),
        chat_id: message.chat_id,
        text,
      });
    },
  });
  const socket = new lark.WSClient({ ...options, onError: (err: Error) => void (error = err.message) });
  void socket.start({ eventDispatcher: dispatcher }).catch((err: unknown) => void (error = (err as Error).message));
  return {
    bot,
    async send(chatId, text) {
      await api.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: clip(text) }) },
      });
    },
    async chats({ op, name, chat_id }) {
      // The platform answers `{code, msg, data}`; anything but code 0 is a refusal with its reason.
      const ok = <T extends { code?: number; msg?: string }>(res: T, what: string): T => {
        if (res.code !== 0) throw new Error(`Feishu ${what} failed: ${res.code ?? ""} ${res.msg ?? ""}`.trim());
        return res;
      };
      const linkOf = async (chatId: string): Promise<string | null> =>
        ok(await api.im.chat.link({ path: { chat_id: chatId }, data: { validity_period: "permanently" } }), "chat link")
          .data?.share_link ?? null;
      if (op === "create") {
        const chatId = ok(await api.im.chat.create({ data: { name } }), "chat create").data?.chat_id;
        if (!chatId) throw new Error("Feishu chat create failed: no chat id came back");
        // The bot is the creator, so nobody else is in yet: the link is how a person joins.
        // Best effort — the group exists either way, and the link can be asked for again.
        return { chat_id: chatId, share_link: await linkOf(chatId).catch(() => null) };
      }
      if (op === "link") return { share_link: await linkOf(chat_id) };
      if (op === "remove") {
        ok(await api.im.chat.delete({ path: { chat_id } }), "chat delete");
        return { removed: true };
      }
      const chats: ChannelChat[] = [];
      let pageToken: string | undefined;
      // Bounded: a bot in more than a few hundred groups is not a picker problem.
      for (let page = 0; page < 10; page++) {
        const { data } = ok(
          await api.im.chat.list({ params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } }),
          "chat list",
        );
        for (const item of data?.items ?? [])
          if (item.chat_id)
            // A group the bot made comes back with no owner: the app owns it.
            chats.push({
              chat_id: item.chat_id,
              name: item.name || item.chat_id,
              bot_owned: !item.owner_id,
              has_people: true,
            });
        pageToken = data?.has_more ? data.page_token : undefined;
        if (!pageToken) break;
      }
      // The list carries no member count; only for the bot's own groups does "is anyone in it" matter.
      await Promise.all(
        chats
          .filter((chat) => chat.bot_owned)
          .map(async (chat) => {
            const detail = await api.im.chat.get({ path: { chat_id: chat.chat_id } }).catch(() => null);
            if (detail?.code === 0) chat.has_people = Number(detail.data?.user_count ?? 1) > 0;
          }),
      );
      return { chats };
    },
    status() {
      const connected = socket.getConnectionStatus?.().state === "connected";
      return {
        connected,
        status: connected ? "connected" : error ? "error" : "connecting",
        error: connected ? null : error,
      };
    },
    close: () => socket.close(),
  };
}

function wecom(bot: ChannelBot, heard: (message: Heard) => void): Line {
  const quiet = (): void => undefined;
  const client = new WeComClient({
    botId: bot.app_id,
    secret: bot.secret,
    ...(bot.endpoint ? { wsUrl: bot.endpoint } : {}),
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
  });
  let authenticated = false;
  let error: string | null = null;
  client.on("authenticated", () => {
    authenticated = true;
    error = null;
  });
  client.on("disconnected", () => void (authenticated = false));
  client.on("error", (err: Error) => void (error = err.message));
  client.on(
    "message",
    (
      frame: WsFrame<{
        msgid?: string;
        chatid?: string;
        msgtype?: string;
        from?: { userid?: string };
        text?: { content?: string };
      }>,
    ) => {
      const message = frame.body ?? {};
      // A single chat is addressed by the person; a group by its own id.
      const chatId = message.chatid || message.from?.userid || "";
      if (!chatId) return;
      // In a group the platform delivers only what mentions the bot, mention included.
      const text = message.msgtype === "text" ? (message.text?.content ?? "").replace(/^@\S+\s*/, "").trim() : null;
      if (text === "") return;
      heard({ bot_id: bot.id, event_id: message.msgid ?? "", chat_id: chatId, text });
    },
  );
  client.connect();
  return {
    bot,
    async send(chatId, text) {
      await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: clip(text) } });
    },
    status: () => ({
      connected: authenticated,
      status: authenticated ? "connected" : error ? "error" : "connecting",
      error: authenticated ? null : error,
    }),
    close: () => client.disconnect(),
  };
}

export class ChannelLines {
  private readonly lines = new Map<string, Line>();

  constructor(private readonly heard: (message: Heard) => void) {}

  /** Make the open connections match the list: dial what is new or changed, hang up what is gone. */
  sync(bots: ChannelBot[]): void {
    const wanted = new Map(bots.map((bot) => [bot.id, bot]));
    for (const [id, line] of this.lines) {
      const bot = wanted.get(id);
      if (bot && JSON.stringify(bot) === JSON.stringify(line.bot)) {
        wanted.delete(id); // unchanged: keep the connection
        continue;
      }
      this.hangUp(id);
    }
    for (const bot of wanted.values())
      this.lines.set(bot.id, bot.platform === "feishu" ? feishu(bot, this.heard) : wecom(bot, this.heard));
  }

  async send(botId: string, chatId: string, text: string): Promise<void> {
    const line = this.lines.get(botId);
    if (!line) throw new Error("this device holds no connection for that bot");
    await line.send(chatId, text);
  }

  async chats(botId: string, request: ChatsRequest): Promise<unknown> {
    const line = this.lines.get(botId);
    if (!line) throw new Error("this device holds no connection for that bot");
    if (!line.chats) throw new Error("this platform's groups cannot be managed from here");
    return line.chats(request);
  }

  status(): Record<string, ChannelBotStatus> {
    return Object.fromEntries([...this.lines].map(([id, line]) => [id, line.status()]));
  }

  close(): void {
    for (const id of [...this.lines.keys()]) this.hangUp(id);
  }

  private hangUp(id: string): void {
    const line = this.lines.get(id);
    this.lines.delete(id);
    try {
      line?.close();
    } catch {
      // already closed
    }
  }
}
