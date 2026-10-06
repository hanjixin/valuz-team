/**
 * The signed-in session (agent-base addition — the server is multi-user).
 *
 * Holds the token pair and the active organization, registers itself with the
 * request layer so every API call is authenticated, and renews the access
 * token transparently. See UPSTREAM.md for why this lives in a carried-over
 * package.
 */
import { safeLocalGet, safeLocalRemove, safeLocalSet } from "@valuz/shared";

import { requestJson, setAuthProvider } from "./request";

const STORAGE_KEY = "agent-base.session";

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  org_id: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface Me {
  user: AuthUser;
  orgs: { id: string; name: string; role: "owner" | "admin" | "member" }[];
  current_org_id: string;
  role: "owner" | "admin" | "member";
}

function read(): AuthSession | null {
  try {
    const parsed = JSON.parse(safeLocalGet(STORAGE_KEY) ?? "null") as Partial<AuthSession> | null;
    return parsed?.access_token && parsed.refresh_token ? { access_token: parsed.access_token, refresh_token: parsed.refresh_token, org_id: parsed.org_id ?? "" } : null;
  } catch {
    return null;
  }
}

let session: AuthSession | null = read();
const listeners = new Set<() => void>();

export const getAuthSession = (): AuthSession | null => session;

/** For ``useSyncExternalStore``: re-render when the user signs in or out. */
export function subscribeAuthSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setAuthSession(next: AuthSession | null): void {
  session = next;
  if (next) safeLocalSet(STORAGE_KEY, JSON.stringify(next));
  else safeLocalRemove(STORAGE_KEY);
  for (const listener of listeners) listener();
}

// One refresh at a time: a refresh token is single-use, so two concurrent 401s
// must share one renewal rather than race and invalidate each other.
let refreshing: Promise<boolean> | null = null;

function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const current = session;
    if (!current) return false;
    try {
      const tokens = await requestJson<Pick<AuthSession, "access_token" | "refresh_token">>("/v1/auth/refresh", {
        method: "POST",
        json: { refresh_token: current.refresh_token },
        skipAuth: true,
      });
      setAuthSession({ ...current, ...tokens });
      return true;
    } catch {
      setAuthSession(null);
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

setAuthProvider({
  headers: () => (session ? { Authorization: `Bearer ${session.access_token}`, ...(session.org_id ? { "X-Org-Id": session.org_id } : {}) } : {}),
  refresh,
});

type SessionResponse = AuthSession & { user: AuthUser };

export const authApi = {
  async login(email: string, password: string): Promise<AuthUser> {
    const res = await requestJson<SessionResponse>("/v1/auth/login", { method: "POST", json: { email, password }, skipAuth: true });
    setAuthSession({ access_token: res.access_token, refresh_token: res.refresh_token, org_id: res.org_id });
    return res.user;
  },

  async register(input: { email: string; password: string; name: string; invite_token?: string }): Promise<AuthUser> {
    const res = await requestJson<SessionResponse>("/v1/auth/register", { method: "POST", json: input, skipAuth: true });
    setAuthSession({ access_token: res.access_token, refresh_token: res.refresh_token, org_id: res.org_id });
    return res.user;
  },

  async logout(): Promise<void> {
    const current = session;
    setAuthSession(null);
    if (!current) return;
    // Best effort: the local session is gone either way.
    await requestJson("/v1/auth/logout", { method: "POST", json: { refresh_token: current.refresh_token }, skipAuth: true }).catch(() => undefined);
  },

  me: (): Promise<Me> => requestJson<Me>("/v1/me"),

  /** Start a new organization, owned by the caller. */
  createOrganization: (name: string): Promise<{ id: string; name: string }> =>
    requestJson("/v1/orgs", { method: "POST", json: { name } }),

  /** Act in another of the user's organizations from the next request on. */
  switchOrganization(orgId: string): void {
    if (session) setAuthSession({ ...session, org_id: orgId });
  },
};
