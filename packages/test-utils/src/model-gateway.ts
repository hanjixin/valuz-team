/**
 * A stand-in OpenAI-compatible gateway: a real HTTP server streaming real SSE,
 * so runtimes are exercised over the actual wire format without a model.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelReply {
  content?: string;
  tool?: { name: string; args: unknown };
  delayMs?: number;
  /** Never finish the stream — for interruption tests. */
  hang?: boolean;
}
export interface ModelRequest {
  messages: { role: string; content: string | null }[];
  tools?: { function: { name: string } }[];
  auth: string;
}

export interface ModelGateway {
  url: string;
  /** Replies handed out in order when no handler claims the request. */
  replies: ModelReply[];
  requests: ModelRequest[];
  /** Decide the reply from the request itself (concurrent sessions cannot share a FIFO). */
  handler: ((request: ModelRequest) => ModelReply | undefined) | null;
  stop(): Promise<void>;
}

export async function startModelGateway(): Promise<ModelGateway> {
  const gateway: ModelGateway = { url: "", replies: [], requests: [], handler: null, stop: async () => undefined };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request: ModelRequest = { ...JSON.parse(body), auth: req.headers.authorization ?? "" };
      gateway.requests.push(request);
      const reply = gateway.handler?.(request) ?? gateway.replies.shift() ?? { content: "ok" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (reply.hang) return;
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      setTimeout(() => {
        if (reply.tool) {
          const call = {
            index: 0,
            id: `call_${gateway.requests.length}`,
            function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
          };
          send({ choices: [{ delta: { tool_calls: [call] } }] });
        }
        if (reply.content) send({ choices: [{ delta: { content: reply.content } }] });
        send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        res.end("data: [DONE]\n\n");
      }, reply.delayMs ?? 0);
    });
  });
  gateway.stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  gateway.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return gateway;
}
