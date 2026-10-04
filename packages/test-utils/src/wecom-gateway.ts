/**
 * A stand-in for WeCom's long-connection gateway for smart bots: it takes a
 * bot's subscription (secret `good-secret` is real), acknowledges what the bot
 * sends, records the messages it posts to chats, and lets a test push a
 * message to the bot as a person in a chat would.
 */
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

export const WECOM_GOOD_SECRET = "good-secret";

export interface WeComGateway {
  /** What to configure as the gateway's address. */
  url: string;
  /** Every message a bot posted to a chat, in order. */
  sent: { bot: string; chat: string; text: string }[];
  /** How many bots are subscribed right now. */
  live(): number;
  /** Deliver a message to a subscribed bot. `message` is merged over a text message from `userid`. */
  push(botId: string, message: Record<string, unknown>): void;
  stop(): Promise<void>;
}

export async function startWeComGateway(): Promise<WeComGateway> {
  const sent: WeComGateway["sent"] = [];
  const bots = new Map<string, WebSocket>();
  let pushed = 0;
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    let botId = "";
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as {
        cmd?: string;
        headers: { req_id: string };
        body?: { bot_id?: string; secret?: string; chatid?: string; markdown?: { content?: string } };
      };
      const ack = (errcode = 0, errmsg = "ok"): void =>
        socket.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode, errmsg }));
      if (frame.cmd === "aibot_subscribe") {
        if (frame.body?.secret !== WECOM_GOOD_SECRET) return ack(40014, "invalid secret");
        botId = frame.body.bot_id ?? "";
        bots.set(botId, socket);
        return ack();
      }
      if (frame.cmd === "aibot_send_msg")
        sent.push({ bot: botId, chat: frame.body?.chatid ?? "", text: frame.body?.markdown?.content ?? "" });
      ack();
    });
    socket.on("close", () => {
      if (bots.get(botId) === socket) bots.delete(botId);
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent,
    live: () => bots.size,
    push(botId, message) {
      const n = ++pushed;
      bots.get(botId)?.send(
        JSON.stringify({
          cmd: "aibot_msg_callback",
          headers: { req_id: `push-${n}` },
          body: {
            msgid: `msg-${n}`,
            aibotid: botId,
            chattype: "single",
            from: { userid: "zhangsan" },
            msgtype: "text",
            ...message,
          },
        }),
      );
    },
    async stop() {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
