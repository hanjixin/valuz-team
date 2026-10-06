/**
 * A stand-in for the Feishu open platform: it issues tenant tokens, accepts
 * messages sent to chats, and runs the long-connection gateway the SDK dials
 * after asking for an endpoint. Apps whose secret is `good-secret` are real.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

export const FEISHU_GOOD_SECRET = "good-secret";

export interface FeishuPlatform {
  /** What to configure as the platform's address. */
  url: string;
  /** Every message sent to a chat, in order. */
  sent: { chat: string; text: string; auth: string }[];
  /** The credentials each long connection was asked for with. */
  endpointCalls: { AppID?: string; AppSecret?: string }[];
  /** How many long connections are open right now. */
  live(): number;
  /**
   * The groups the bot is in. One it made has no `owner_id`; `people` are its members besides the bot.
   * Put a group here to stand for one somebody added the bot to.
   */
  chats: Map<string, { name: string; owner_id?: string; people: number }>;
  /** Deliver an event to an app over its long connection, as the platform does. */
  push(appId: string, event: unknown): void;
  stop(): Promise<void>;
}

const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  for (let rest = value; ; rest = Math.floor(rest / 128)) {
    if (rest < 128) return Buffer.from([...bytes, rest]);
    bytes.push((rest % 128) | 0x80);
  }
};
const delimited = (field: number, data: Buffer): Buffer =>
  Buffer.concat([varint((field << 3) | 2), varint(data.length), data]);

/** One data frame of the gateway's protobuf framing (`pbbp2.Frame`), carrying a whole event. */
function eventFrame(id: string, event: unknown): Buffer {
  const header = (key: string, value: string): Buffer =>
    delimited(5, Buffer.concat([delimited(1, Buffer.from(key)), delimited(2, Buffer.from(value))]));
  return Buffer.concat([
    ...[1, 2, 3].map((field) => Buffer.concat([varint(field << 3), varint(0)])), // SeqID, LogID, service
    Buffer.concat([varint(4 << 3), varint(1)]), // method: data
    header("type", "event"),
    header("message_id", id),
    header("sum", "1"),
    header("seq", "0"),
    header("trace_id", id),
    delimited(8, Buffer.from(JSON.stringify(event))),
  ]);
}

export async function startFeishuPlatform(): Promise<FeishuPlatform> {
  const sent: FeishuPlatform["sent"] = [];
  const endpointCalls: FeishuPlatform["endpointCalls"] = [];
  const chats: FeishuPlatform["chats"] = new Map();
  const port = (): number => (server.address() as AddressInfo).port;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, string>;
      const answer = (payload: unknown): void => void res.end(JSON.stringify(payload));
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/auth/v3/tenant_access_token/internal"))
        return answer(
          body["app_secret"] === FEISHU_GOOD_SECRET
            ? { code: 0, msg: "ok", tenant_access_token: "t-token", expire: 7200 }
            : { code: 10014, msg: "app secret invalid" },
        );
      if (req.url?.includes("/callback/ws/endpoint")) {
        endpointCalls.push(body);
        return answer(
          body["AppSecret"] === FEISHU_GOOD_SECRET
            ? {
                code: 0,
                msg: "ok",
                data: {
                  URL: `ws://127.0.0.1:${port()}/ws?device_id=d1&service_id=s1&app=${body["AppID"] ?? ""}`,
                  ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 },
                },
              }
            : { code: 1000040345, msg: "app secret invalid" },
        );
      }
      const chatRoute = /\/im\/v1\/chats(?:\/([^/?]+))?(\/link)?(?:\?|$)/.exec(req.url ?? "");
      if (chatRoute) {
        const [, chatId, link] = chatRoute;
        const found = chatId ? chats.get(decodeURIComponent(chatId)) : undefined;
        if (chatId && !found) return answer({ code: 232006, msg: "chat not found" });
        if (!chatId && req.method === "GET")
          return answer({
            code: 0,
            msg: "ok",
            data: {
              items: [...chats].map(([id, chat]) => ({
                chat_id: id,
                name: chat.name,
                ...(chat.owner_id ? { owner_id: chat.owner_id } : {}),
              })),
              has_more: false,
              page_token: "",
            },
          });
        if (!chatId && req.method === "POST") {
          const id = `oc_made_${chats.size + 1}`;
          chats.set(id, { name: body["name"] ?? "", people: 0 });
          return answer({ code: 0, msg: "ok", data: { chat_id: id, name: body["name"] } });
        }
        if (link) return answer({ code: 0, msg: "ok", data: { share_link: `https://applink.example/join/${chatId}` } });
        if (req.method === "DELETE") {
          // Only its owner may dissolve a group; the bot owns what it made.
          if (found?.owner_id) return answer({ code: 232017, msg: "operator is not the group owner" });
          chats.delete(decodeURIComponent(chatId as string));
          return answer({ code: 0, msg: "ok", data: {} });
        }
        return answer({ code: 0, msg: "ok", data: { name: found?.name, user_count: String(found?.people ?? 0) } });
      }
      if (req.url?.includes("/im/v1/messages")) {
        sent.push({
          chat: body["receive_id"] ?? "",
          text: (JSON.parse(body["content"] ?? "{}") as { text?: string }).text ?? "",
          auth: String(req.headers.authorization),
        });
        return answer({ code: 0, msg: "ok", data: { message_id: `om_${sent.length}` } });
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const gateway = new WebSocketServer({ server, path: "/ws" });
  const open = new Map<WebSocket, string>();
  gateway.on("connection", (socket, req) => {
    open.set(socket, new URL(req.url ?? "", "http://x").searchParams.get("app") ?? "");
    socket.on("close", () => open.delete(socket));
  });
  let pushed = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port()}`,
    sent,
    endpointCalls,
    live: () => open.size,
    chats,
    push(appId, event) {
      for (const [socket, app] of open) if (app === appId) socket.send(eventFrame(`push_${++pushed}`, event));
    },
    async stop() {
      gateway.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
