/** API client: bearer auth with silent refresh, org context, and resumable SSE. */

export interface Tokens {
  access: string;
  refresh: string;
  orgId: string;
}

const KEY = "agent-base.auth";
let tokens: Tokens | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null") as Tokens | null;
  } catch {
    return null;
  }
})();
const listeners = new Set<() => void>();

export const getTokens = (): Tokens | null => tokens;
export const onAuthChange = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export function setTokens(next: Tokens | null): void {
  tokens = next;
  if (next) localStorage.setItem(KEY, JSON.stringify(next));
  else localStorage.removeItem(KEY);
  for (const fn of listeners) fn();
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const headers = (body: boolean): Record<string, string> => ({
  ...(body ? { "content-type": "application/json" } : {}),
  ...(tokens ? { authorization: `Bearer ${tokens.access}`, ...(tokens.orgId ? { "x-org-id": tokens.orgId } : {}) } : {}),
});

// One refresh at a time: concurrent 401s must not burn the single-use refresh token twice.
let refreshing: Promise<boolean> | null = null;
function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    if (!tokens) return false;
    const res = await fetch("/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refresh }),
    }).catch(() => null);
    if (!res?.ok) {
      setTokens(null);
      return false;
    }
    const data = (await res.json()) as { access_token: string; refresh_token: string };
    setTokens({ ...tokens, access: data.access_token, refresh: data.refresh_token });
    return true;
  })().finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const send = () => fetch(path, { method, headers: headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined });
  let res = await send();
  if (res.status === 401 && tokens && (await refresh())) res = await send();
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `请求失败 (${res.status})`);
  return data as T;
}

export const get = <T = any>(path: string) => api<T>("GET", path);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const patch = <T = any>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const put = <T = any>(path: string, body: unknown) => api<T>("PUT", path, body);
export const del = (path: string) => api("DELETE", path);

export interface StreamEvent {
  seq?: number;
  type: string;
  [key: string]: any;
}

/**
 * Follow an SSE endpoint. Reconnects with backoff and resumes after the last
 * `seq` it delivered, so a dropped connection never loses or repeats an event.
 */
export function stream(path: string, afterSeq: number, onEvent: (e: StreamEvent) => void): () => void {
  const abort = new AbortController();
  let cursor = afterSeq;
  let attempt = 0;
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const sep = path.includes("?") ? "&" : "?";
        let res = await fetch(`${path}${sep}after_seq=${cursor}`, { headers: headers(false), signal: abort.signal });
        if (res.status === 401 && (await refresh())) res = await fetch(`${path}${sep}after_seq=${cursor}`, { headers: headers(false), signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const line = buffer.slice(0, end).split("\n").find((l) => l.startsWith("data: "));
            buffer = buffer.slice(end + 2);
            if (!line) continue;
            const event = JSON.parse(line.slice(6)) as StreamEvent;
            if (typeof event.seq === "number") cursor = event.seq;
            onEvent(event);
          }
        }
      } catch {
        if (abort.signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** attempt++)));
    }
  })();
  return () => abort.abort();
}
