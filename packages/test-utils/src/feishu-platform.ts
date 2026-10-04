/**
 * A stand-in for the Feishu open platform: it issues tenant tokens, accepts
 * messages sent to chats, and runs the long-connection gateway the SDK dials
 * after asking for an endpoint. Apps whose secret is `good-secret` are real.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

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
  stop(): Promise<void>;
}

export async function startFeishuPlatform(): Promise<FeishuPlatform> {
  const sent: FeishuPlatform["sent"] = [];
  const endpointCalls: FeishuPlatform["endpointCalls"] = [];
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
                  URL: `ws://127.0.0.1:${port()}/ws?device_id=d1&service_id=s1`,
                  ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 },
                },
              }
            : { code: 1000040345, msg: "app secret invalid" },
        );
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
  const open = new Set<unknown>();
  gateway.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port()}`,
    sent,
    endpointCalls,
    live: () => open.size,
    async stop() {
      gateway.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
