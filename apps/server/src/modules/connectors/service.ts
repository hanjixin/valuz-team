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
  await repo.insert(ctx.db, {
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    slug,
    display_name: name,
    description: input.description ?? null,
    transport: input.transport,
    auth_type: input.auth_type ?? "none",
    config,
    secret_enc: sealSecrets(ctx, secrets),
    enabled: true,
  });
  await audit.record(ctx.db, auth, "connector.create", { type: "connector", id }, { slug, transport: input.transport });
  return { id, slug, needs_auth: false, authorization_url: null };
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

type Stored = Pick<repo.ConnectorRow, "slug" | "transport" | "config" | "secret_enc">;

/** The connector as the kernel's MCP client needs it, secrets filled in. */
function serverConfig(ctx: Ctx, row: Stored): McpServerConfig {
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
    headers: resolve("headers", row.config.headers),
    tool_timeout_sec: null,
    server_instructions_trusted: false,
  };
}

/** Connect and list the server's tools; what was found is kept on the connector. */
export async function test(ctx: Ctx, auth: Auth, key: string): Promise<Schema<"TestConnectorResponse">> {
  const row = await mustFind(ctx, auth, key, "use");
  const outcome = await probe(ctx, row);
  await repo.update(ctx.db, row.id, {
    status: outcome.ok ? "connected" : "error",
    tool_count: outcome.tool_count,
    error_message: outcome.error,
    last_tested_at: new Date(),
  });
  return outcome;
}

async function probe(ctx: Ctx, row: Stored): Promise<Schema<"TestConnectorResponse">> {
  const failed = (error: string) => ({ ok: false, tool_count: null, tools: [], tool_details: [], error });
  const config = serverConfig(ctx, row);
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
export const serversFor = async (ctx: Ctx, orgId: string, slugs: string[]): Promise<McpServerConfig[]> =>
  (await repo.enabledBySlug(ctx.db, orgId, slugs)).map((row) => serverConfig(ctx, row));
