/**
 * A stand-in model vendor: lists models and answers one-shot chat requests in
 * both the OpenAI and the Anthropic shape, checking the API key the way a real
 * upstream does.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface ProviderUpstream {
  /** Base URL including `/v1`. */
  url: string;
  /** The only key this upstream accepts. */
  apiKey: string;
  /** Model ids it offers (and answers for). Change it to simulate the vendor adding models. */
  models: { id: string; display_name?: string }[];
  /** Answer every chat request as this model instead of the requested one (a proxy silently substituting). */
  substituteWith: string | null;
  /** Paths requested, in order. */
  hits: string[];
  stop(): Promise<void>;
}

export async function startProviderUpstream(): Promise<ProviderUpstream> {
  const upstream: ProviderUpstream = {
    url: "",
    apiKey: "sk-test-good",
    models: [{ id: "alpha-1" }, { id: "beta-2", display_name: "Beta Two" }],
    substituteWith: null,
    hits: [],
    stop: async () => undefined,
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const authorized = (req: IncomingMessage) =>
    req.headers.authorization === `Bearer ${upstream.apiKey}` || req.headers["x-api-key"] === upstream.apiKey;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    upstream.hits.push(`${req.method} ${path}`);
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!authorized(req)) return json(res, 401, { error: { message: "invalid api key" } });
      if (req.method === "GET" && path === "/v1/models") return json(res, 200, { data: upstream.models });
      const chat = path === "/v1/chat/completions";
      if (req.method === "POST" && (chat || path === "/v1/messages")) {
        const { model } = JSON.parse(raw) as { model: string };
        if (!upstream.models.some((m) => m.id === model))
          return json(res, 400, { error: { message: `unknown model ${model}` } });
        const answeredBy = upstream.substituteWith ?? model;
        return json(
          res,
          200,
          chat
            ? {
                id: "c1",
                object: "chat.completion",
                model: answeredBy,
                choices: [{ index: 0, message: { role: "assistant", content: "." }, finish_reason: "length" }],
              }
            : {
                id: "m1",
                type: "message",
                role: "assistant",
                model: answeredBy,
                content: [{ type: "text", text: "." }],
                stop_reason: "max_tokens",
                usage: { input_tokens: 1, output_tokens: 1 },
              },
        );
      }
      return json(res, 404, { error: { message: "not found" } });
    });
  });
  upstream.stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstream.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return upstream;
}
