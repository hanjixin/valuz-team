/**
 * The market index: a public catalogue of skills, connectors, agents and teams
 * (valuz-agent's own, by default). Its answers are already in the shapes the
 * contract's `Marketplace*` schemas describe, so this only fetches, remembers
 * for a short while, and settles on whichever address answers.
 */
import type { Ctx } from "../../infra/context.ts";

const TIMEOUT_MS = 15_000;
const TTL_MS = { categories: 600_000, items: 60_000, detail: 300_000 } as const;
/** After a failure, further requests fail at once for a while rather than each waiting out a timeout. */
const FAILURE_MEMO_MS = 60_000;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

export class IndexUnavailable extends Error {}

interface State {
  cache: Map<string, { until: number; value: unknown }>;
  base: string | null;
  failedUntil: number;
}
const states = new WeakMap<Ctx, State>();
const stateOf = (ctx: Ctx): State => {
  let state = states.get(ctx);
  if (!state) states.set(ctx, (state = { cache: new Map(), base: null, failedUntil: 0 }));
  return state;
};

const candidates = (ctx: Ctx): string[] =>
  ctx.config.MARKETPLACE_INDEX_URLS.split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);

export const configured = (ctx: Ctx): boolean => candidates(ctx).length > 0;

async function fetchFrom(ctx: Ctx, path: string, params: Record<string, string>): Promise<unknown> {
  const state = stateOf(ctx);
  if (Date.now() < state.failedUntil) throw new IndexUnavailable("the market index did not answer a moment ago");
  const channel = ctx.config.MARKETPLACE_INDEX_CHANNEL;
  const query = new URLSearchParams({ ...params, channel, distribution: channel }).toString();
  // The address that answered last time first, then the others.
  const order = [...new Set([state.base, ...candidates(ctx)].filter((url): url is string => Boolean(url)))];
  for (const base of order) {
    try {
      const res = await fetch(`${base}${path}?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) return null;
      if (!res.ok) continue;
      const body: unknown = await res.json();
      state.base = base;
      return body;
    } catch {
      // try the next address
    }
  }
  state.failedUntil = Date.now() + FAILURE_MEMO_MS;
  throw new IndexUnavailable("no market index address answered");
}

async function cached(
  ctx: Ctx,
  kind: keyof typeof TTL_MS,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  const state = stateOf(ctx);
  const key = `${path}?${JSON.stringify(Object.entries(params).sort())}`;
  const hit = state.cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fetchFrom(ctx, path, params);
  if (value !== null) state.cache.set(key, { until: Date.now() + TTL_MS[kind], value });
  return value;
}

export const categories = (ctx: Ctx, kind: string, locale: string) =>
  cached(ctx, "categories", "/v1/marketplace/categories", { kind, locale });

export const items = (ctx: Ctx, params: Record<string, string>) =>
  cached(ctx, "items", "/v1/marketplace/items", params);

/** One item in full; null when the index has no such item. */
export const detail = (ctx: Ctx, itemId: string, locale: string) =>
  cached(ctx, "detail", `/v1/marketplace/items/${encodeURIComponent(itemId)}`, { locale });

/** A package the index points at, checked against the digest the index gave for it. */
export async function download(url: string, sha256: string | undefined): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new IndexUnavailable(`the package could not be downloaded: ${(err as Error).message}`);
  }
  if (!res.ok) throw new IndexUnavailable(`the package could not be downloaded (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new IndexUnavailable("the package is too large");
  if (sha256) {
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    if (digest !== sha256) throw new IndexUnavailable("the package does not match the digest the index gave for it");
  }
  return bytes;
}
