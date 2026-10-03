/**
 * IM channels. A Feishu bot is bound to an agent and a project; every chat the
 * bot is in becomes one session, and the agent's answers go back to the chat.
 * The Feishu side — tokens, event decryption, signature checks, sending — is
 * the official SDK (@larksuiteoapi/node-sdk); this module maps chats to sessions.
 */
import { createHash } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import type { Ctx } from "./context.ts";
import type { Row } from "./db.ts";
import type { TurnEnd } from "./device-hub.ts";
import { createSession, dispatchTurn } from "./dispatch.ts";
import { HttpError, forbidden, notFound } from "./http.ts";

export interface ChannelSecrets {
  app_secret: string;
  verification_token?: string;
  encrypt_key?: string;
}

interface ChannelMeta {
  channel_id: string;
  chat_id: string;
}

const REPLY_LIMIT = 28_000;

const SYNC_CHANNEL = "channels:sync";

export class ChannelService {
  private readonly clients = new Map<string, lark.Client>();
  /** Long connections held by this replica, by channel id. */
  private readonly links = new Map<string, lark.WSClient>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly ctx: Ctx) {}

  /** Open the long connections and follow channel changes made on any replica. */
  async start(): Promise<void> {
    this.unsubscribe = await this.ctx.pubsub.subscribe(SYNC_CHANNEL, (payload) => {
      void this.reconcile((payload as { id: string }).id).catch((err: unknown) => console.error("[channels]", err));
    });
    const rows = await this.ctx.db.query<{ id: string }>("SELECT id FROM channels WHERE enabled AND mode = 'websocket'");
    for (const { id } of rows) await this.reconcile(id).catch((err: unknown) => console.error(`[channel ${id}]`, err));
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    for (const id of [...this.links.keys()]) this.closeLink(id);
  }

  /** Tell every replica that a channel was created, changed, or removed. */
  sync(channelId: string): Promise<void> {
    return this.ctx.pubsub.publish(SYNC_CHANNEL, { id: channelId });
  }

  private closeLink(channelId: string): void {
    const link = this.links.get(channelId);
    this.links.delete(channelId);
    try {
      link?.close();
    } catch {
      // already closed
    }
  }

  /** Make this replica's long connection match the channel row. */
  private async reconcile(channelId: string): Promise<void> {
    this.closeLink(channelId);
    const channel = await this.ctx.db.one("SELECT * FROM channels WHERE id = $1 AND enabled AND mode = 'websocket'", [channelId]);
    if (!channel) return;
    // The connection is authenticated by the app credentials, so events on it need
    // no token or signature. With several replicas the platform delivers each event
    // to one connection; the event-id check below covers redelivery.
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
      "im.message.receive_v1": async (data: Record<string, any>) => {
        const fresh = await this.ctx.pubsub.redis.set(`channel-event:${channelId}:${String(data["event_id"] ?? data["message"]?.message_id)}`, "1", "EX", 3600, "NX");
        if (!fresh) return;
        const current = await this.ctx.db.one("SELECT * FROM channels WHERE id = $1 AND enabled", [channelId]);
        if (current) void this.onMessage(current, data).catch((err: unknown) => console.error(`[channel ${channelId}]`, err));
      },
    });
    const link = new lark.WSClient({
      appId: channel["app_id"] as string,
      appSecret: this.secrets(channel).app_secret,
      domain: (channel["api_base"] as string) || lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      onError: (err) => console.error(`[channel ${channelId}] long connection: ${err.message}`),
    });
    this.links.set(channelId, link);
    void link.start({ eventDispatcher: dispatcher });
  }

  /** This replica's view of a channel's long connection, for display. */
  linkStatus(channelId: string): unknown {
    const link = this.links.get(channelId);
    return link ? link.getConnectionStatus() : null;
  }

  secrets(channel: Row): ChannelSecrets {
    return JSON.parse(this.ctx.box.open("channel", channel["secret_enc"] as string)) as ChannelSecrets;
  }

  client(channel: Row): lark.Client {
    const key = `${String(channel["id"])}:${new Date(channel["updated_at"] as string).getTime()}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new lark.Client({
        appId: channel["app_id"] as string,
        appSecret: this.secrets(channel).app_secret,
        domain: (channel["api_base"] as string) || lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.error,
      });
      this.clients.set(key, client);
    }
    return client;
  }

  /** Prove the app credentials work by asking the platform for a token. */
  async test(channel: Row): Promise<void> {
    // The SDK throws when the platform refuses the credentials, and returns a code otherwise.
    let failure: string | null = null;
    try {
      const res = (await this.client(channel).auth.tenantAccessToken.internal({
        data: { app_id: channel["app_id"] as string, app_secret: this.secrets(channel).app_secret },
      })) as { code?: number; msg?: string };
      if (res.code !== 0) failure = res.msg ?? "unknown error";
    } catch (err) {
      failure = (err as Error).message;
    }
    if (failure) throw new HttpError(422, "channel_credentials_rejected", `the platform rejected the app credentials: ${failure}`);
  }

  private async send(channel: Row, chatId: string, text: string): Promise<void> {
    const body = text.length > REPLY_LIMIT ? `${text.slice(0, REPLY_LIMIT)}\n…（内容过长，已截断）` : text;
    await this.client(channel).im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: body }) },
    });
  }

  /**
   * One event-callback request. Returns the JSON to answer with; the platform
   * expects it within 3 seconds, so the turn itself is started in the background.
   */
  async callback(channelId: string, headers: Record<string, unknown>, body: Record<string, unknown>): Promise<unknown> {
    const channel = await this.ctx.db.one("SELECT * FROM channels WHERE id = $1 AND enabled", [channelId]);
    if (!channel) throw notFound("channel");
    if (channel["mode"] !== "webhook") throw new HttpError(409, "not_a_webhook_channel", "this channel receives events over a long connection, not this URL");
    const secrets = this.secrets(channel);

    // With an Encrypt Key the platform signs every request; check it before reading anything.
    if (secrets.encrypt_key) {
      const expected = createHash("sha256")
        .update(`${String(headers["x-lark-request-timestamp"])}${String(headers["x-lark-request-nonce"])}${secrets.encrypt_key}${JSON.stringify(body)}`)
        .digest("hex");
      if (expected !== headers["x-lark-signature"]) throw forbidden("event signature mismatch");
    }
    const plain = (typeof body["encrypt"] === "string"
      ? JSON.parse(new lark.AESCipher(secrets.encrypt_key ?? "").decrypt(body["encrypt"]))
      : body) as Record<string, any>;
    // The Verification Token is the only proof of origin when events are not encrypted.
    const token = plain["header"]?.token ?? plain["token"];
    if (secrets.verification_token && token !== secrets.verification_token) throw forbidden("verification token mismatch");

    if (plain["type"] === "url_verification") return { challenge: plain["challenge"] };
    if (plain["header"]?.event_type !== "im.message.receive_v1") return {};

    // The platform redelivers until it gets a 200: handle each event once.
    const fresh = await this.ctx.pubsub.redis.set(`channel-event:${channelId}:${String(plain["header"].event_id)}`, "1", "EX", 3600, "NX");
    if (fresh) {
      void this.onMessage(channel, plain["event"]).catch((err: unknown) => console.error(`[channel ${channelId}]`, err));
    }
    return {};
  }

  private async onMessage(channel: Row, event: Record<string, any>): Promise<void> {
    const message = event["message"] ?? {};
    const chatId = String(message.chat_id ?? "");
    if (!chatId) return;
    // In a group the bot answers only when it is addressed.
    if (message.chat_type !== "p2p" && !(Array.isArray(message.mentions) && message.mentions.length > 0)) return;
    if (message.message_type !== "text") return this.send(channel, chatId, "目前只支持文本消息。");
    let text = "";
    try {
      text = String((JSON.parse(message.content) as { text?: string }).text ?? "");
    } catch {
      return;
    }
    text = text.replace(/@_user_\d+/g, "").trim();
    if (!text) return;

    if (text === "/new") {
      await this.ctx.db.query("DELETE FROM channel_threads WHERE channel_id = $1 AND external_chat_id = $2", [channel["id"], chatId]);
      return this.send(channel, chatId, "已开始新会话。");
    }

    try {
      const session = await this.sessionFor(channel, chatId);
      const actor = { user_id: channel["owner_id"] as string, name: `飞书 · ${String(channel["name"])}` };
      if (session["status"] === "running") {
        // Mid-turn: it waits its turn like any message typed during a run.
        await this.ctx.db.query("INSERT INTO queued_inputs (id, session_id, actor_id, text) VALUES ($1, $2, $3, $4)", [
          crypto.randomUUID(), session["id"], channel["owner_id"], text,
        ]);
        return;
      }
      await dispatchTurn(this.ctx, session, { text, attachments: [], additional_context: "" }, actor);
    } catch (err) {
      const reason = err instanceof HttpError && err.code === "device_offline" ? "执行设备当前不在线，请稍后再试。" : `无法处理这条消息：${(err as Error).message}`;
      await this.send(channel, chatId, reason);
    }
  }

  /** The chat's session, created on first contact. */
  private async sessionFor(channel: Row, chatId: string): Promise<Row> {
    const existing = await this.ctx.db.one(
      "SELECT s.* FROM channel_threads t JOIN sessions s ON s.id = t.session_id WHERE t.channel_id = $1 AND t.external_chat_id = $2",
      [channel["id"], chatId],
    );
    if (existing) return existing;
    const project = await this.ctx.db.one("SELECT device_id, root_path FROM projects WHERE id = $1", [channel["project_id"]]);
    if (!project?.["device_id"] || !project["root_path"]) throw new Error("这个渠道绑定的项目没有绑定设备或文件夹");
    const agent = await this.ctx.db.one("SELECT * FROM agents WHERE org_id = $1 AND slug = $2", [channel["org_id"], channel["agent_slug"]]);
    if (!agent) throw new Error(`智能体 ${String(channel["agent_slug"])} 已不存在`);
    const meta: ChannelMeta = { channel_id: channel["id"] as string, chat_id: chatId };
    const session = await createSession(this.ctx, {
      orgId: channel["org_id"] as string,
      ownerId: channel["owner_id"] as string,
      agent,
      deviceId: project["device_id"] as string,
      projectId: channel["project_id"] as string,
      cwd: project["root_path"] as string,
      title: `飞书 · ${String(channel["name"])}`,
      metadata: { valuz: { channel: meta } },
    });
    await this.ctx.db.query("INSERT INTO channel_threads (channel_id, external_chat_id, session_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
      channel["id"], chatId, session["id"],
    ]);
    return session;
  }

  /** A turn ended on a device: if the session belongs to a chat, answer there. */
  async onTurnEnd(message: TurnEnd): Promise<void> {
    if (message.status === "running" || message.status === "cancelled") return;
    const row = await this.ctx.db.one(
      `SELECT c.*, s.metadata AS session_metadata FROM sessions s
         JOIN channels c ON c.id::text = s.metadata->'valuz'->'channel'->>'channel_id' WHERE s.id = $1`,
      [message.session_id],
    );
    if (!row) return;
    const meta = (row["session_metadata"] as { valuz: { channel: ChannelMeta } }).valuz.channel;
    const text =
      message.status === "completed"
        ? message.assistant_message?.trim() || "（已完成，没有文字回复）"
        : `运行出错：${String((message.error_message as Row | null)?.["message"] ?? "未知错误")}`;
    try {
      await this.send(row, meta.chat_id, text);
    } catch (err) {
      await this.ctx.notify(row["owner_id"] as string, row["org_id"] as string, {
        kind: "channel_send_failed", title: `飞书回复发送失败：${String(row["name"])}`, body: (err as Error).message.slice(0, 300), link: `/sessions/${message.session_id}`,
      });
    }
  }
}
