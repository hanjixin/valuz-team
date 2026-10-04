/**
 * Talking to a model upstream on a member's behalf: list its models, and check
 * that a model id actually answers. Failures carry a reason written for the
 * person adding the channel — the web app shows it as is.
 */
import Anthropic, { APIError as AnthropicError } from "@anthropic-ai/sdk";
import OpenAI, { APIError as OpenAIError } from "openai";
import type { StoredModel } from "@agent-base/db";
import type { Config } from "../../infra/config.ts";
import { BlockedAddressError, assertOutboundAllowed } from "../../infra/outbound.ts";
import type { WireShape } from "./catalog.ts";

const DISCOVERY_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 15_000;

export class ModelDiscoveryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface Upstream {
  baseUrl: string;
  apiKey: string;
  shape: WireShape;
}

async function guard(config: Config, upstream: Upstream): Promise<void> {
  if (!upstream.baseUrl) throw new ModelDiscoveryError("请填写 Endpoint");
  if (!upstream.apiKey) throw new ModelDiscoveryError("API Key 不能为空");
  try {
    await assertOutboundAllowed(config, upstream.baseUrl);
  } catch (err) {
    if (err instanceof BlockedAddressError) throw new ModelDiscoveryError(`Endpoint 不可用：${err.message}`);
    throw err;
  }
}

const authHeaders = ({ shape, apiKey }: Upstream): Record<string, string> =>
  shape === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${apiKey}` };

/** `claude-sonnet-4-6-20251015` → `claude-sonnet-4-6`. */
const withoutDateSuffix = (id: string): string => id.replace(/-\d{8}$/, "");

function modelsIn(payload: unknown, shape: WireShape): StoredModel[] {
  const items = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(items)) return [];
  const byId = new Map<string, StoredModel>();
  for (const item of items as { id?: unknown; display_name?: unknown; name?: unknown }[]) {
    if (typeof item?.id !== "string" || !item.id) continue;
    const id = shape === "anthropic" ? withoutDateSuffix(item.id) : item.id;
    const label = [item.display_name, item.name].find((value) => typeof value === "string" && value) as
      string | undefined;
    if (!byId.has(id) || (label && !byId.get(id)?.label)) byId.set(id, label ? { id, label } : { id });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The upstream's model list, sorted and de-duplicated. */
export async function discoverModels(config: Config, upstream: Upstream): Promise<StoredModel[]> {
  await guard(config, upstream);
  const base = upstream.baseUrl.replace(/\/+$/, "");
  const candidates = base.endsWith("/v1") ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];
  let lastReason = "服务方未提供可用的模型列表接口";
  for (const url of candidates) {
    let res: Response;
    try {
      // Redirects are not followed: a public endpoint must not be able to bounce the server inward.
      res = await fetch(url, {
        headers: authHeaders(upstream),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError")
        throw new ModelDiscoveryError("服务方响应超时，请稍后重试");
      throw new ModelDiscoveryError("无法连接到服务方，请检查 Endpoint");
    }
    if (res.status === 404) {
      lastReason = "服务方未提供模型列表接口（/v1/models 不存在）";
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ModelDiscoveryError("API Key 无效，请检查后重试");
    if (res.status === 429) throw new ModelDiscoveryError("请求过于频繁，请稍后重试");
    if (res.status >= 500) throw new ModelDiscoveryError(`服务方异常（HTTP ${res.status}），请稍后重试`);
    if (res.status >= 300) throw new ModelDiscoveryError(`服务方拒绝请求（HTTP ${res.status}）`);
    const models = modelsIn(await res.json().catch(() => null), upstream.shape);
    if (models.length > 0) return models;
    lastReason = "服务方未返回任何可用模型";
  }
  throw new ModelDiscoveryError(lastReason);
}

/**
 * Some proxies accept any model id with 200 and silently answer with their own
 * default. Accept the requested id or a dated version of it; anything else is a substitution.
 */
function assertSameModel(requested: string, returned: string | undefined): void {
  const got = (returned ?? "").trim();
  if (!got || got === requested || got.startsWith(`${requested}-`)) return;
  throw new ModelDiscoveryError(
    `上游返回了模型「${got}」而非请求的「${requested}」，服务方可能不支持该模型 id（已 fallback 到其他模型）`,
  );
}

function reasonFor(err: unknown, model: string): string {
  if (err instanceof ModelDiscoveryError) return err.reason;
  if (!(err instanceof AnthropicError) && !(err instanceof OpenAIError)) return "无法连接到服务方，请检查 Endpoint";
  const status = err.status;
  const upstream = (err.error as { error?: { message?: string }; message?: string } | undefined) ?? {};
  const said = upstream.error?.message ?? upstream.message;
  if (status === undefined)
    return /timed? ?out/i.test(err.message) ? "服务方响应超时，请稍后重试" : "无法连接到服务方，请检查 Endpoint";
  if (status === 401 || status === 403) return "API Key 无效，请检查后重试";
  if (status === 404) return `服务方未找到模型「${model}」或该接口（请检查 Endpoint 与模型 id）`;
  if (status === 400) return `模型「${model}」可能不存在或上游不识别${said ? `（上游：${said}）` : ""}`;
  if (status === 429) return "请求过于频繁，请稍后重试";
  if (status >= 500) return `服务方异常（HTTP ${status}），请稍后重试`;
  return `服务方拒绝请求：${said ?? `HTTP ${status}`}`;
}

/**
 * Send one minimal request for `model`. Uses the vendors' own SDKs so the URL
 * is composed exactly as a real session would compose it.
 */
export async function pingModel(config: Config, upstream: Upstream, model: string): Promise<void> {
  await guard(config, upstream);
  // Redirects are not followed here either (see discoverModels).
  const noRedirect: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "manual" });
  const options = { apiKey: upstream.apiKey, timeout: PING_TIMEOUT_MS, maxRetries: 0, fetch: noRedirect };
  const ask = { model, max_tokens: 1, messages: [{ role: "user" as const, content: "." }] };
  try {
    if (upstream.shape === "anthropic") {
      // The SDK appends `/v1/messages` itself.
      const client = new Anthropic({ ...options, baseURL: upstream.baseUrl.replace(/\/v1\/?$/, "") });
      assertSameModel(model, (await client.messages.create(ask)).model);
    } else {
      const client = new OpenAI({ ...options, baseURL: upstream.baseUrl });
      assertSameModel(model, (await client.chat.completions.create(ask)).model);
    }
  } catch (err) {
    throw new ModelDiscoveryError(reasonFor(err, model));
  }
}

/** Ping each model; one failing does not stop the others. */
export async function pingModels(
  config: Config,
  upstream: Upstream,
  models: string[],
): Promise<{ ok: string[]; failed: { model: string; reason: string }[] }> {
  await guard(config, upstream);
  const outcomes = await Promise.all(
    [...new Set(models)].map(async (model) => {
      try {
        await pingModel(config, upstream, model);
        return { model, reason: null };
      } catch (err) {
        return { model, reason: err instanceof ModelDiscoveryError ? err.reason : String(err) };
      }
    }),
  );
  return {
    ok: outcomes.filter((o) => o.reason === null).map((o) => o.model),
    failed: outcomes.flatMap((o) => (o.reason === null ? [] : [{ model: o.model, reason: o.reason }])),
  };
}
