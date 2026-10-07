/**
 * Signing in to an MCP server that asks for it (OAuth 2.1 with PKCE, as the MCP
 * authorization spec lays it out). The protocol work — finding the
 * authorization server from the MCP server, registering as a client, building
 * the authorization request, exchanging the code, refreshing — is the MCP
 * SDK's. What is here is where each piece is kept: the client registration,
 * the endpoints and the tokens are sealed on the connector; the PKCE verifier
 * waits in Redis under the request's `state` for the ten minutes a person has
 * to finish in their browser.
 *
 * Every address involved was typed by a member or named by a server they
 * pointed at, so every request goes through the outbound check.
 */
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { Ctx } from "../../infra/context.ts";
import { HttpError } from "../../infra/errors.ts";
import { assertOutboundAllowed } from "../../infra/outbound.ts";

const SECRET_PURPOSE = "connector-oauth";
const PENDING_SECONDS = 600;
/** A token this close to expiring is renewed before it is handed to a turn. */
const RENEW_BEFORE_MS = 120_000;
const pendingKey = (state: string): string => `connector:oauth:${state}`;

type Metadata = NonNullable<Awaited<ReturnType<typeof discoverOAuthServerInfo>>["authorizationServerMetadata"]>;

export interface OAuthState {
  /** The authorization server, and what it says about itself. */
  server: string;
  metadata: Metadata;
  /** Who this server is to it. */
  client: { client_id: string; client_secret?: string };
  /** The MCP server the tokens are for, when the authorization server wants it named. */
  resource?: string;
  scope?: string;
  tokens?: { access_token: string; refresh_token?: string; expires_at?: number };
}

export const seal = (ctx: Ctx, state: OAuthState): string => ctx.box.seal(SECRET_PURPOSE, JSON.stringify(state));
export const open = (ctx: Ctx, sealed: string | null): OAuthState | null =>
  sealed ? (JSON.parse(ctx.box.open(SECRET_PURPOSE, sealed)) as OAuthState) : null;

/** The address a browser is sent back to once a person has signed in. */
export const redirectUri = (ctx: Ctx): string =>
  `${(ctx.config.PUBLIC_URL || `http://127.0.0.1:${ctx.config.PORT}`).replace(/\/+$/, "")}/v1/connectors/oauth/callback`;

/** `fetch`, refusing addresses a member must not be able to make the server call. Redirects are not followed. */
const guarded =
  (ctx: Ctx) =>
  async (url: string | URL, init?: RequestInit): Promise<Response> => {
    await assertOutboundAllowed(ctx.config, String(url));
    return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  };

/** What an MCP server says about signing in to it; null when it says nothing (it takes a key, or nobody). */
export async function discover(ctx: Ctx, url: string) {
  try {
    const info = await discoverOAuthServerInfo(url, { fetchFn: guarded(ctx) });
    if (!info.authorizationServerMetadata) return null;
    return {
      server: String(info.authorizationServerUrl),
      metadata: info.authorizationServerMetadata,
      resource: info.resourceMetadata?.resource,
    };
  } catch {
    return null;
  }
}

/** Whether the server turns away a caller who brings nothing — the sign that signing in is not optional. */
export async function demandsSignIn(ctx: Ctx, url: string): Promise<boolean> {
  try {
    const res = await guarded(ctx)(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    return res.status === 401;
  } catch {
    return false;
  }
}

/**
 * Start a sign-in: settle who we are to the authorization server (registering
 * if it lets clients register themselves, else with the client a member
 * supplied or the one kept from last time) and build the address to send the
 * person to. The verifier waits under `state` for the callback.
 */
export async function begin(
  ctx: Ctx,
  connectorId: string,
  url: string,
  given: {
    credentials?: Record<string, string>;
    authorization_endpoint?: string | null;
    token_endpoint?: string | null;
    registration_endpoint?: string | null;
    scopes?: string[];
    previous?: OAuthState | null;
  },
): Promise<{ state: OAuthState; authorizationUrl: string }> {
  const found = await discover(ctx, url);
  // Endpoints a member typed (a server that publishes none) stand in for discovery.
  const manual =
    given.authorization_endpoint && given.token_endpoint
      ? {
          server: new URL(given.authorization_endpoint).origin,
          metadata: {
            issuer: new URL(given.authorization_endpoint).origin,
            authorization_endpoint: given.authorization_endpoint,
            token_endpoint: given.token_endpoint,
            ...(given.registration_endpoint ? { registration_endpoint: given.registration_endpoint } : {}),
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          } as Metadata,
          resource: undefined as string | undefined,
        }
      : null;
  const target = found ?? manual;
  if (!target)
    throw new HttpError(502, "oauth_discovery_failed", `could not find out how to sign in to ${new URL(url).origin}`);

  const redirect = redirectUri(ctx);
  const scope = (given.scopes?.length ? given.scopes : (target.metadata.scopes_supported ?? [])).join(" ") || undefined;
  let client: OAuthState["client"] | null = null;
  if (given.credentials?.["client_id"])
    client = {
      client_id: given.credentials["client_id"],
      ...(given.credentials["client_secret"] ? { client_secret: given.credentials["client_secret"] } : {}),
    };
  // The client registered last time is good for the same authorization server.
  if (!client && given.previous?.server === target.server) client = given.previous.client;
  if (!client && target.metadata.registration_endpoint) {
    try {
      const registered = await registerClient(target.server, {
        metadata: target.metadata,
        clientMetadata: {
          client_name: "agent-base",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          ...(scope ? { scope } : {}),
        },
        fetchFn: guarded(ctx),
      });
      client = {
        client_id: registered.client_id,
        ...(registered.client_secret ? { client_secret: registered.client_secret } : {}),
      };
    } catch (err) {
      ctx.log(err, `connector ${connectorId}: client registration was refused`);
    }
  }
  if (!client)
    throw new HttpError(
      422,
      "oauth_client_required",
      "this server does not let clients register themselves: enter the Client ID (and secret) of an OAuth app you registered with it",
    );

  const state: OAuthState = {
    server: target.server,
    metadata: target.metadata,
    client,
    ...(target.resource ? { resource: target.resource } : {}),
    ...(scope ? { scope } : {}),
  };
  const nonce = crypto.randomUUID();
  const { authorizationUrl, codeVerifier } = await startAuthorization(state.server, {
    metadata: state.metadata,
    clientInformation: state.client,
    redirectUrl: redirect,
    state: nonce,
    ...(scope ? { scope } : {}),
    ...(state.resource ? { resource: new URL(state.resource) } : {}),
  });
  await ctx.redis.set(
    pendingKey(nonce),
    JSON.stringify({ connectorId, verifier: codeVerifier }),
    "EX",
    PENDING_SECONDS,
  );
  return { state, authorizationUrl: authorizationUrl.toString() };
}

/** The sign-in a callback's `state` belongs to — once: a state is spent when it is read. */
export async function pending(ctx: Ctx, state: string): Promise<{ connectorId: string; verifier: string } | null> {
  const raw = await ctx.redis.getdel(pendingKey(state));
  return raw ? (JSON.parse(raw) as { connectorId: string; verifier: string }) : null;
}

const withTokens = (
  state: OAuthState,
  tokens: { access_token: string; refresh_token?: string; expires_in?: number },
) => ({
  ...state,
  tokens: {
    access_token: tokens.access_token,
    // A server that sends no new refresh token means the old one still stands.
    ...((tokens.refresh_token ?? state.tokens?.refresh_token)
      ? { refresh_token: tokens.refresh_token ?? state.tokens?.refresh_token }
      : {}),
    ...(tokens.expires_in ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
  },
});

/** Trade the code a person came back with for tokens. */
export async function finish(ctx: Ctx, state: OAuthState, code: string, verifier: string): Promise<OAuthState> {
  const tokens = await exchangeAuthorization(state.server, {
    metadata: state.metadata,
    clientInformation: state.client,
    authorizationCode: code,
    codeVerifier: verifier,
    redirectUri: redirectUri(ctx),
    ...(state.resource ? { resource: new URL(state.resource) } : {}),
    fetchFn: guarded(ctx),
  });
  return withTokens(state, tokens);
}

/**
 * The state with a token good for use right now: as it is while the token has
 * life left, renewed when it is about to run out. Null when there is no token,
 * or it ran out and could not be renewed — the member has to sign in again.
 */
export async function fresh(ctx: Ctx, state: OAuthState): Promise<{ state: OAuthState; renewed: boolean } | null> {
  if (!state.tokens) return null;
  const expiresAt = state.tokens.expires_at;
  if (!expiresAt || expiresAt - Date.now() > RENEW_BEFORE_MS) return { state, renewed: false };
  if (!state.tokens.refresh_token) return expiresAt > Date.now() ? { state, renewed: false } : null;
  try {
    const tokens = await refreshAuthorization(state.server, {
      metadata: state.metadata,
      clientInformation: state.client,
      refreshToken: state.tokens.refresh_token,
      ...(state.resource ? { resource: new URL(state.resource) } : {}),
      fetchFn: guarded(ctx),
    });
    return { state: withTokens(state, tokens), renewed: true };
  } catch (err) {
    ctx.log(err, "a connector's sign-in could not be renewed");
    return expiresAt > Date.now() ? { state, renewed: false } : null;
  }
}
