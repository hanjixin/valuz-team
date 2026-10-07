/**
 * Connectors — MCP servers an agent can call: one reached over the network
 * (`http`, `sse`), or a command run on the device (`stdio`). A connector
 * belongs to the member who added it and is shared through the ladder. What it
 * needs to authenticate — a header, a query parameter, an environment variable
 * marked secret — is sealed on the server and handed only to the turn that
 * uses it, never back to a person.
 */
import type { Schema } from "@agent-base/contract";
import type { ConnectorConfig, ConnectorEntry } from "@agent-base/db";
import type { McpServerConfig } from "@agent-base/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest, conflict, forbidden, notFound } from "../../infra/errors.ts";
import { BlockedAddressError, assertOutboundAllowed } from "../../infra/outbound.ts";
import { deriveSlug, ensureUniqueSlug, isValidSlug } from "../agents/slug.ts";
import * as audit from "../audit/service.ts";
import * as sharing from "../sharing/service.ts";
import * as oauth from "./oauth.ts";
import * as repo from "./repo.ts";

sharing.registerShareable("connector", "connectors");

const SECRET_PURPOSE = "connector-secrets";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSPORTS = ["http", "sse", "stdio"];
const TEST_TIMEOUT_MS = 15_000;

type Item = Schema<"ConnectorItem">;
type Param = Schema<"ConnectorParam">;
type Kind = "headers" | "params" | "env";
type Secrets = Record<string, string>;

const openSecrets = (ctx: Ctx, sealed: string | null): Secrets =>
  sealed ? (JSON.parse(ctx.box.open(SECRET_PURPOSE, sealed)) as Secrets) : {};
const sealSecrets = (ctx: Ctx, secrets: Secrets): string | null =>
  Object.keys(secrets).length ? ctx.box.seal(SECRET_PURPOSE, JSON.stringify(secrets)) : null;

/**
 * Split what was submitted into what is stored in the open and what is sealed.
 * A secret sent without a value keeps the value it already had — the form shows
 * secrets blank, and saving it must not wipe them.
 */
function take(kind: Kind, submitted: Param[], secrets: Secrets, previous: Secrets): ConnectorEntry[] {
  return submitted.map((entry) => {
    const key = entry.key.trim();
    if (!entry.secret) return { key, secret: false, value: entry.value ?? "" };
    const value = entry.value || previous[`${kind}:${key}`];
    if (value) secrets[`${kind}:${key}`] = value;
    return { key, secret: true, value: null };
  });
}

function present(row: repo.ConnectorRow): Item {
  const permission = row.permission ?? "view";
  // Only someone who may edit the connector sees how it is configured.
  const open = sharing.permissionAtLeast(permission, "edit");
  const shown = (entries: ConnectorEntry[]): ConnectorEntry[] =>
    open ? entries : entries.map((entry) => ({ ...entry, value: null }));
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    description: row.description,
    connector_type: "custom",
    transport: row.transport as Item["transport"],
    url: open ? row.config.url : null,
    auth_type: row.auth_type,
    has_api_key: row.secret_enc !== null,
    command: open ? row.config.command : null,
    args: open ? row.config.args : [],
    working_dir: open ? row.config.working_dir : null,
    env: shown(row.config.env),
    headers: shown(row.config.headers),
    params: shown(row.config.params),
    enabled: row.enabled,
    status: row.status,
    tool_count: row.tool_count,
    last_tested_at: row.last_tested_at?.getTime() ?? null,
    error_message: row.error_message,
    created_at: row.created_at.getTime(),
    updated_at: row.updated_at.getTime(),
    permission,
    owner_id: row.owner_id,
  };
}

async function mustFind(ctx: Ctx, auth: Auth, key: string, needed: sharing.Permission = "view") {
  const row = await repo.find(ctx.db, auth, key, UUID.test(key));
  if (!row?.permission) throw notFound("connector");
  if (!sharing.permissionAtLeast(row.permission, needed))
    throw forbidden(`this needs "${needed}" permission on the connector`);
  return row;
}

function checkShape(transport: string, config: ConnectorConfig): void {
  if (!TRANSPORTS.includes(transport)) throw badRequest(`unknown transport "${transport}"`);
  if (transport === "stdio") {
    if (!config.command?.trim()) throw badRequest("a stdio connector needs a command");
  } else if (!config.url || !/^https?:\/\//i.test(config.url)) {
    throw badRequest("a connector reached over the network needs an http(s) URL");
  }
}

export const list = async (ctx: Ctx, auth: Auth): Promise<Item[]> => (await repo.list(ctx.db, auth)).map(present);

export const get = async (ctx: Ctx, auth: Auth, key: string): Promise<Item> => present(await mustFind(ctx, auth, key));

export async function create(
  ctx: Ctx,
  auth: Auth,
  input: Schema<"CreateConnectorRequest">,
): Promise<Schema<"CreateConnectorResponse">> {
  const name = input.display_name.trim();
  if (!name) throw badRequest("a connector needs a name");
  const taken = await repo.slugsInOrg(ctx.db, auth.orgId);
  const wanted = input.slug?.trim();
  if (wanted && !isValidSlug(wanted)) throw badRequest("that slug is not valid", "invalid_slug");
  // Signing in again to a connector one already has is asked for the same way as adding it.
  const again = wanted && input.auth_type === "oauth" ? await repo.find(ctx.db, auth, wanted, false) : undefined;
  if (again?.auth_type === "oauth" && sharing.permissionAtLeast(again.permission ?? "view", "edit"))
    return signIn(ctx, auth, again, input);
  if (wanted && taken.has(wanted)) throw conflict(`connector '${wanted}' already exists`, "slug_taken");

  const secrets: Secrets = {};
  // `credentials` is the shorthand a simple form sends: each one is a secret header.
  const credentials = Object.entries(input.credentials ?? {}).map(([key, value]) => ({ key, secret: true, value }));
  const env = Object.entries(input.env ?? {}).map(([key, value]) => ({ key, secret: true, value }));
  const config: ConnectorConfig = {
    url: input.url?.trim() || null,
    command: input.command?.trim() || null,
    args: input.args ?? [],
    working_dir: input.working_dir?.trim() || null,
    headers: take("headers", [...(input.headers ?? []), ...credentials], secrets, {}),
    params: take("params", input.params ?? [], secrets, {}),
    env: take("env", env, secrets, {}),
  };
  checkShape(input.transport, config);
  const id = crypto.randomUUID();
  const slug = wanted || ensureUniqueSlug(deriveSlug(name).toLowerCase(), taken);
  // A server reached over the network may ask for a sign-in: because the member said so, or because
  // it turns away a caller who brings nothing and says where to sign in.
  const networked = input.transport !== "stdio" && config.url;
  const signsIn =
    networked &&
    (input.auth_type === "oauth" ||
      ((input.auth_type ?? "none") === "none" &&
        config.headers.length === 0 &&
        (await guardedly(() => oauth.demandsSignIn(ctx, config.url as string))) &&
        (await guardedly(() => oauth.discover(ctx, config.url as string))) !== null));
  // OAuth client credentials are for the authorization server, not headers for the MCP server.
  if (signsIn) config.headers = take("headers", input.headers ?? [], secrets, {});
  await repo.insert(ctx.db, {
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    slug,
    display_name: name,
    description: input.description ?? null,
    transport: input.transport,
    auth_type: signsIn ? "oauth" : (input.auth_type ?? "none"),
    config,
    secret_enc: sealSecrets(ctx, secrets),
    enabled: true,
  });
  await audit.record(ctx.db, auth, "connector.create", { type: "connector", id }, { slug, transport: input.transport });
  if (!signsIn) return { id, slug, needs_auth: false, authorization_url: null };
  try {
    return await signIn(ctx, auth, { id, slug, config, oauth_enc: null }, input);
  } catch (err) {
    // Nothing half-made is left behind: a connector that cannot even start signing in was not added.
    await repo.remove(ctx.db, id);
    throw err;
  }
}

/** A blocked address is an answer ("no"), not a failure of the whole request. */
async function guardedly<T>(ask: () => Promise<T>): Promise<T | null> {
  try {
    return await ask();
  } catch (err) {
    if (err instanceof BlockedAddressError) return null;
    throw err;
  }
}

/** Send the member to sign in to a connector's server. Until they come back it is `pending_auth`. */
async function signIn(
  ctx: Ctx,
  auth: Auth,
  row: Pick<repo.ConnectorRow, "id" | "slug" | "config" | "oauth_enc">,
  input: Schema<"CreateConnectorRequest">,
): Promise<Schema<"CreateConnectorResponse">> {
  let started: Awaited<ReturnType<typeof oauth.begin>>;
  try {
    started = await oauth.begin(ctx, row.id, row.config.url ?? "", {
      credentials: input.credentials ?? {},
      authorization_endpoint: input.oauth_authorization_endpoint ?? null,
      token_endpoint: input.oauth_token_endpoint ?? null,
      registration_endpoint: input.oauth_registration_endpoint ?? null,
      scopes: input.oauth_scopes ?? [],
      previous: oauth.open(ctx, row.oauth_enc),
    });
  } catch (err) {
    if (err instanceof BlockedAddressError) throw badRequest(err.message, "blocked_address");
    throw err;
  }
  await repo.update(ctx.db, row.id, {
    oauth_enc: oauth.seal(ctx, started.state),
    status: "pending_auth",
    error_message: null,
  });
  await audit.record(ctx.db, auth, "connector.sign_in", { type: "connector", id: row.id }, { slug: row.slug });
  return { id: row.id, slug: row.slug, needs_auth: true, authorization_url: started.authorizationUrl };
}

/**
 * A person came back from signing in. The `state` in the address is what ties
 * the browser to the sign-in that was started — it is spent on first use — so
 * this needs no session of its own. Returns what to tell them.
 */
export async function signedIn(
  ctx: Ctx,
  query: { code?: string; state?: string; error?: string; error_description?: string },
): Promise<{ ok: boolean; message: string }> {
  const waiting = query.state ? await oauth.pending(ctx, query.state) : null;
  if (!waiting)
    return { ok: false, message: "This sign-in link has expired or was already used. Start again from the app." };
  const row = await repo.byId(ctx.db, waiting.connectorId);
  const state = oauth.open(ctx, row?.oauth_enc ?? null);
  if (!row || !state) return { ok: false, message: "The connector this sign-in was for no longer exists." };
  const refused = (message: string) =>
    repo
      .update(ctx.db, row.id, { status: "pending_auth", error_message: message })
      .then(() => ({ ok: false, message }));
  if (query.error || !query.code)
    return refused(query.error_description || query.error || "The sign-in was not completed.");
  let signed: oauth.OAuthState;
  try {
    signed = await oauth.finish(ctx, state, query.code, waiting.verifier);
  } catch (err) {
    return refused(`The server did not accept the sign-in: ${(err as Error).message}`);
  }
  await repo.update(ctx.db, row.id, { oauth_enc: oauth.seal(ctx, signed) });
  // Signed in is not yet "works": connect once and keep what was found.
  const outcome = await probe(ctx, { ...row, oauth_enc: oauth.seal(ctx, signed) });
  await repo.update(ctx.db, row.id, {
    status: outcome.ok ? "connected" : "error",
    tool_count: outcome.tool_count,
    error_message: outcome.error,
    last_tested_at: new Date(),
  });
  return outcome.ok
    ? { ok: true, message: "Signed in. You can close this window." }
    : { ok: false, message: `Signed in, but the server could not be used: ${outcome.error ?? ""}` };
}

/** What a server says about signing in to it, for the form that is about to add it. */
export async function discover(ctx: Ctx, url: string): Promise<Schema<"DiscoverConnectorResponse">> {
  const none = {
    auth_type: "none",
    discovered: false,
    oauth_authorization_endpoint: null,
    oauth_token_endpoint: null,
    oauth_registration_endpoint: null,
  };
  if (!/^https?:\/\//i.test(url)) return none;
  const found = await guardedly(() => oauth.discover(ctx, url));
  if (!found) return none;
  return {
    auth_type: "oauth",
    discovered: true,
    oauth_authorization_endpoint: found.metadata.authorization_endpoint,
    oauth_token_endpoint: found.metadata.token_endpoint,
    // Null: the server has no self-registration, so the member supplies a client they registered.
    oauth_registration_endpoint: found.metadata.registration_endpoint ?? null,
  };
}

export async function update(
  ctx: Ctx,
  auth: Auth,
  key: string,
  input: Schema<"UpdateConnectorRequest">,
): Promise<Item> {
  const row = await mustFind(ctx, auth, key, "edit");
  const previous = openSecrets(ctx, row.secret_enc);
  // Secrets of a list that was not sent stay as they are.
  const sent = { headers: input.headers != null, params: input.params != null, env: input.env != null };
  const secrets: Secrets = Object.fromEntries(
    Object.entries(previous).filter(([name]) => !sent[name.split(":")[0] as Kind]),
  );
  const env = input.env ? Object.entries(input.env).map(([k, value]) => ({ key: k, secret: true, value })) : null;
  const config: ConnectorConfig = {
    url: input.url != null ? input.url.trim() || null : row.config.url,
    command: input.command != null ? input.command.trim() || null : row.config.command,
    args: input.args ?? row.config.args,
    working_dir: input.working_dir != null ? input.working_dir.trim() || null : row.config.working_dir,
    headers: input.headers ? take("headers", input.headers, secrets, previous) : row.config.headers,
    params: input.params ? take("params", input.params, secrets, previous) : row.config.params,
    env: env ? take("env", env, secrets, previous) : row.config.env,
  };
  checkShape(row.transport, config);
  await repo.update(ctx.db, row.id, {
    display_name: input.display_name?.trim() || row.display_name,
    description: input.description ?? row.description,
    auth_type: input.auth_type ?? row.auth_type,
    config,
    secret_enc: sealSecrets(ctx, secrets),
    ...(input.enabled != null ? { enabled: input.enabled } : {}),
    // Where it points may have changed: what the last test found no longer stands.
    status: "untested",
    tool_count: null,
    error_message: null,
  });
  await audit.record(ctx.db, auth, "connector.update", { type: "connector", id: row.id });
  return get(ctx, auth, row.id);
}

export async function setEnabled(ctx: Ctx, auth: Auth, key: string, enabled: boolean): Promise<Item> {
  const row = await mustFind(ctx, auth, key, "edit");
  await repo.update(ctx.db, row.id, { enabled });
  return get(ctx, auth, row.id);
}

export async function remove(ctx: Ctx, auth: Auth, key: string): Promise<void> {
  const row = await mustFind(ctx, auth, key, "admin");
  await ctx.db.transaction().execute(async (tx) => {
    await sharing.revokeForResource(tx, "connector", row.id);
    await repo.remove(tx, row.id);
    await audit.record(tx, auth, "connector.delete", { type: "connector", id: row.id }, { slug: row.slug });
  });
}

type Stored = Pick<repo.ConnectorRow, "slug" | "transport" | "config" | "secret_enc"> & {
  id?: string;
  auth_type?: string;
  oauth_enc?: string | null;
};

/** A connector that is signed in to cannot be used until someone signs in (again). */
export class NeedsSignIn extends Error {}

/**
 * The bearer token of a connector that is signed in to, renewed when it is about to run out
 * (and what was renewed kept). Null for a connector that takes a key or nothing.
 */
async function bearerOf(ctx: Ctx, row: Stored): Promise<string | null> {
  if (row.auth_type !== "oauth") return null;
  const state = oauth.open(ctx, row.oauth_enc ?? null);
  const current = state ? await oauth.fresh(ctx, state) : null;
  if (!current?.state.tokens) {
    if (row.id) await repo.update(ctx.db, row.id, { status: "pending_auth", error_message: "sign in again" });
    throw new NeedsSignIn(`sign in to "${row.slug}" again`);
  }
  if (current.renewed && row.id) await repo.update(ctx.db, row.id, { oauth_enc: oauth.seal(ctx, current.state) });
  return current.state.tokens.access_token;
}

/** The connector as the kernel's MCP client needs it, secrets filled in. */
async function serverConfig(ctx: Ctx, row: Stored): Promise<McpServerConfig> {
  const bearer = await bearerOf(ctx, row);
  const secrets = openSecrets(ctx, row.secret_enc);
  const resolve = (kind: Kind, entries: ConnectorEntry[]): Record<string, string> =>
    Object.fromEntries(
      entries.flatMap((entry) => {
        const value = entry.secret ? secrets[`${kind}:${entry.key}`] : entry.value;
        return value ? [[entry.key, value]] : [];
      }),
    );
  if (row.transport === "stdio")
    return {
      name: row.slug,
      transport: "stdio",
      command: row.config.command ?? "",
      args: row.config.args,
      env: resolve("env", row.config.env),
      env_vars: [],
    };
  const url = new URL(row.config.url ?? "");
  for (const [name, value] of Object.entries(resolve("params", row.config.params))) url.searchParams.set(name, value);
  return {
    name: row.slug,
    transport: row.transport as "http" | "sse",
    url: url.toString(),
    headers: { ...resolve("headers", row.config.headers), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    tool_timeout_sec: null,
    server_instructions_trusted: false,
  };
}

/** Connect and list the server's tools; what was found is kept on the connector. */
export async function test(ctx: Ctx, auth: Auth, key: string): Promise<Schema<"TestConnectorResponse">> {
  const row = await mustFind(ctx, auth, key, "use");
  const outcome = await probe(ctx, row);
  const unsigned = row.auth_type === "oauth" && !oauth.open(ctx, row.oauth_enc)?.tokens;
  await repo.update(ctx.db, row.id, {
    status: outcome.ok ? "connected" : unsigned ? "pending_auth" : "error",
    tool_count: outcome.tool_count,
    error_message: outcome.error,
    last_tested_at: new Date(),
  });
  return outcome;
}

async function probe(ctx: Ctx, row: Stored): Promise<Schema<"TestConnectorResponse">> {
  const failed = (error: string) => ({ ok: false, tool_count: null, tools: [], tool_details: [], error });
  let config: McpServerConfig;
  try {
    config = await serverConfig(ctx, row);
  } catch (err) {
    if (err instanceof NeedsSignIn) return failed(err.message);
    throw err;
  }
  if (config.transport === "stdio")
    return failed("a stdio connector is a command run on a device; it is checked there, when a session uses it");
  try {
    await assertOutboundAllowed(ctx.config, config.url);
  } catch (err) {
    if (err instanceof BlockedAddressError) return failed(err.message);
    throw err;
  }
  const client = new Client({ name: "agent-base", version: "0.1.0" });
  // Redirects are not followed: a public server must not be able to bounce the server inward.
  const init = { requestInit: { headers: config.headers, redirect: "manual" as const } };
  const url = new URL(config.url);
  const transport =
    config.transport === "sse" ? new SSEClientTransport(url, init) : new StreamableHTTPClientTransport(url, init);
  try {
    await client.connect(transport, { timeout: TEST_TIMEOUT_MS });
    const { tools } = await client.listTools(undefined, { timeout: TEST_TIMEOUT_MS });
    return {
      ok: true,
      tool_count: tools.length,
      tools: tools.map((tool) => tool.name),
      tool_details: tools.map((tool) => ({ name: tool.name, description: tool.description ?? null })),
      error: null,
    };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * The MCP servers an agent's connectors resolve to, for the device to connect.
 * A slug that names no enabled connector any more is simply left out.
 */
export async function serversFor(ctx: Ctx, orgId: string, slugs: string[]): Promise<McpServerConfig[]> {
  const servers: McpServerConfig[] = [];
  for (const row of await repo.enabledBySlug(ctx.db, orgId, slugs)) {
    try {
      servers.push(await serverConfig(ctx, row));
    } catch (err) {
      // One that needs signing in to again is left out of this turn — and now says so on its page.
      if (!(err instanceof NeedsSignIn)) throw err;
    }
  }
  return servers;
}
