/**
 * Model channels: where an agent's model calls go. A channel belongs to the
 * member who added it, is private until shared, and keeps its API key sealed
 * on the server — a member it is shared with can run models through it without
 * ever seeing the key.
 */
import type { Schema } from "@agent-base/contract";
import type { StoredModel } from "@agent-base/db";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, badRequest, forbidden, notFound } from "../../infra/errors.ts";
import * as audit from "../audit/service.ts";
import * as settings from "../settings/service.ts";
import * as sharing from "../sharing/service.ts";
import {
  type ApiProtocol,
  DESCRIPTORS,
  type RuntimeId,
  compatibleProtocols,
  descriptorOf,
  endpointFor,
  pinnedProtocol,
  runtimesFor,
  wireShape,
} from "./catalog.ts";
import { completeOnce, ModelDiscoveryError, type Upstream, discoverModels, pingModel, pingModels } from "./discover.ts";
import * as repo from "./repo.ts";
import { SUBSCRIPTIONS, type Subscription, subscriptionOf } from "./subscriptions.ts";

sharing.registerShareable("provider", "providers");

const SECRET_PURPOSE = "provider-api-key";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Channel = Schema<"LLMChannelDetail">;
type ModelDefaults = Schema<"ModelDefaults">;

/** A reason the person adding the channel can act on; the web app shows it as is. */
const unusable = (err: unknown, status = 422): never => {
  if (err instanceof ModelDiscoveryError) throw new HttpError(status, "model_discovery_failed", err.reason);
  throw err;
};

const normalizeBaseUrl = (value: string | null | undefined): string | null => value?.trim() || null;

// -- Model defaults: what a new conversation starts with, per member --

const FACTORY_DEFAULTS: ModelDefaults = {
  default_runtime: "claude_agent",
  default_provider_id: null,
  default_model: null,
  default_effort: "high",
};

const storedDefaults = (ctx: Ctx, auth: Auth): Promise<ModelDefaults> =>
  settings.get(ctx.db, auth, "model-defaults", FACTORY_DEFAULTS);

// -- Presentation --

function present(row: repo.ProviderRow, auth: Auth, defaultProviderId: string | null): Channel {
  const d = descriptorOf(row.provider_kind);
  const protocols = compatibleProtocols(row.provider_kind, row.protocol);
  const runtimes = runtimesFor(protocols);
  const mine = row.owner_id === auth.userId;
  const models = row.models.length > 0 || !row.default_model ? row.models : [{ id: row.default_model }];
  return {
    id: row.id,
    name: row.name,
    provider_kind: row.provider_kind,
    // The caller's own channels, then the ones other members shared with them.
    source: mine ? "user" : "org",
    group: mine ? "api_key" : "org",
    group_rank: mine ? 40 : 30,
    enabled: row.secret_enc !== null,
    unavailable_reason: row.secret_enc === null ? "未配置 API Key" : null,
    is_default: row.id === defaultProviderId,
    deletable: row.permission === "admin",
    default_model: row.default_model,
    test_status: row.test_status,
    credential_source: row.secret_enc === null ? "none" : "secret_ref",
    auth_type: "api_key",
    protocol: row.protocol,
    effective_protocol: protocols[0] as ApiProtocol,
    compatible_protocols: protocols,
    models: models.map((model) => ({ id: model.id, label: model.label ?? null, runtimes })),
    permission: row.permission ?? "view",
    owner_id: row.owner_id,
    // Only someone who may edit the channel learns where it points.
    base_url: sharing.permissionAtLeast(row.permission ?? "view", "edit") ? row.base_url : null,
    supports_custom_base_url: d?.supports_custom_base_url ?? false,
    supports_connection_test: d?.supports_connection_test ?? true,
  };
}

async function mustFind(ctx: Ctx, auth: Auth, id: string, needed: sharing.Permission = "view") {
  const row = UUID.test(id) ? await repo.find(ctx.db, auth, id) : undefined;
  if (!row?.permission) throw notFound("provider");
  if (!sharing.permissionAtLeast(row.permission, needed))
    throw forbidden(`this needs "${needed}" permission on the provider`);
  return row;
}

const upstreamOf = (
  ctx: Ctx,
  row: Pick<repo.ProviderRow, "provider_kind" | "protocol" | "base_url" | "secret_enc">,
): Upstream => ({
  baseUrl: endpointFor(row.provider_kind, row.protocol, row.base_url),
  apiKey: row.secret_enc ? ctx.box.open(SECRET_PURPOSE, row.secret_enc) : "",
  shape: wireShape(row.provider_kind, row.protocol),
});

// -- Reading --

export const listDescriptors = (): typeof DESCRIPTORS => DESCRIPTORS;

// -- Subscription channels --

const SUBSCRIPTION_SWITCHES = "subscription-channels";

/** Which subscription channels the member has switched off. They are on unless said otherwise. */
const switchedOff = async (ctx: Ctx, auth: Auth): Promise<Record<string, boolean>> =>
  settings.get(ctx.db, auth, SUBSCRIPTION_SWITCHES, {} as Record<string, boolean>);

function presentSubscription(subscription: Subscription, enabled: boolean, defaultProviderId: string | null): Channel {
  return {
    id: subscription.id,
    name: subscription.name,
    provider_kind: subscription.kind,
    source: "user",
    group: "subscription",
    group_rank: 10,
    enabled,
    unavailable_reason: enabled ? null : "未启用",
    is_default: subscription.id === defaultProviderId,
    deletable: false,
    default_model: subscription.default_model,
    test_status: "success",
    // Nothing is stored for it: the device's own CLI login is the credential.
    credential_source: enabled ? "cli_keychain" : "none",
    auth_type: "oauth",
    protocol: null,
    effective_protocol: subscription.protocol,
    compatible_protocols: [subscription.protocol],
    models: subscription.models.map((model) => ({ ...model, runtimes: [subscription.runtime] })),
    permission: "use",
    base_url: null,
    supports_custom_base_url: false,
    supports_connection_test: false,
  };
}

/** Switch a subscription channel on (or off) for the member. */
export async function enable(ctx: Ctx, auth: Auth, id: string, on = true): Promise<Channel> {
  const subscription = subscriptionOf(id);
  if (!subscription) return get(ctx, auth, id);
  await settings.set(ctx.db, auth, SUBSCRIPTION_SWITCHES, { ...(await switchedOff(ctx, auth)), [id]: !on });
  return get(ctx, auth, id);
}

export async function list(ctx: Ctx, auth: Auth): Promise<Channel[]> {
  const [rows, defaults, off] = await Promise.all([
    repo.list(ctx.db, auth),
    storedDefaults(ctx, auth),
    switchedOff(ctx, auth),
  ]);
  return [
    ...SUBSCRIPTIONS.map((subscription) =>
      presentSubscription(subscription, off[subscription.id] !== true, defaults.default_provider_id),
    ),
    ...rows.map((row) => present(row, auth, defaults.default_provider_id)),
  ];
}

export async function get(ctx: Ctx, auth: Auth, id: string): Promise<Channel> {
  const subscription = subscriptionOf(id);
  if (subscription)
    return presentSubscription(
      subscription,
      (await switchedOff(ctx, auth))[id] !== true,
      (await storedDefaults(ctx, auth)).default_provider_id,
    );
  const row = await mustFind(ctx, auth, id);
  return present(row, auth, (await storedDefaults(ctx, auth)).default_provider_id);
}

/** Throws unless the caller may run models through this channel. */
export const assertUsable = async (ctx: Ctx, auth: Auth, id: string): Promise<void> =>
  void (subscriptionOf(id) ?? (await mustFind(ctx, auth, id, "use")));

/**
 * What a runtime needs to call the channel's model. Needs `use`: the key is
 * handed to the kernel on the member's behalf, never to the member.
 */
export async function credentials(ctx: Ctx, auth: Auth, id: string) {
  const row = await mustFind(ctx, auth, id, "use");
  const upstream = upstreamOf(ctx, row);
  if (!upstream.apiKey) throw badRequest("this model channel has no API key", "provider_unavailable");
  return {
    api_key: upstream.apiKey,
    base_url: upstream.baseUrl || null,
    protocols: compatibleProtocols(row.provider_kind, row.protocol),
    default_model: row.default_model,
  };
}

/**
 * The same, for a session that was bound to the channel when it was created:
 * whoever sends the next message — the owner or a colleague driving the shared
 * session — the channel is the session's, already authorized.
 */
export async function credentialsForSession(ctx: Ctx, orgId: string, id: string) {
  const row = await repo.findInOrg(ctx.db, orgId, id);
  const upstream = row ? upstreamOf(ctx, row) : null;
  if (!row || !upstream?.apiKey) return null;
  return {
    api_key: upstream.apiKey,
    base_url: upstream.baseUrl || null,
    protocols: compatibleProtocols(row.provider_kind, row.protocol),
    default_model: row.default_model,
  };
}

/** Ask a session's channel one question on the server's side. Null when the channel is gone or has no key. */
export async function complete(
  ctx: Ctx,
  orgId: string,
  id: string,
  model: string,
  prompt: string,
): Promise<string | null> {
  const row = await repo.findInOrg(ctx.db, orgId, id);
  const upstream = row ? upstreamOf(ctx, row) : null;
  if (!upstream?.apiKey) return null;
  return completeOnce(ctx.config, upstream, model, prompt);
}

/** The channel's protocols and default model, for a caller who may use it. */
export async function describe(ctx: Ctx, auth: Auth, id: string) {
  const subscription = subscriptionOf(id);
  if (subscription) return { protocols: [subscription.protocol], default_model: subscription.default_model };
  const row = await mustFind(ctx, auth, id, "use");
  return { protocols: compatibleProtocols(row.provider_kind, row.protocol), default_model: row.default_model };
}

// -- Writing --

function chooseDefaultModel(wanted: string | null | undefined, kind: string, models: StoredModel[]): string | null {
  const ids = models.map((model) => model.id);
  if (wanted && (ids.length === 0 || ids.includes(wanted))) return wanted;
  const suggested = descriptorOf(kind)?.default_model;
  return (suggested && ids.includes(suggested) ? suggested : ids[0]) ?? null;
}

export async function create(ctx: Ctx, auth: Auth, input: Schema<"ProviderCreateRequest">): Promise<Channel> {
  const d = descriptorOf(input.provider_kind);
  if (!d) throw badRequest(`unknown provider kind "${input.provider_kind}"`);
  if (input.protocol && !pinnedProtocol(input.protocol)) throw badRequest(`unknown protocol "${input.protocol}"`);
  const row = {
    provider_kind: input.provider_kind,
    protocol: input.protocol ?? null,
    base_url: d.supports_custom_base_url ? normalizeBaseUrl(input.base_url) : null,
    secret_enc: null,
  };
  const upstream = { ...upstreamOf(ctx, row), apiKey: input.api_key?.trim() ?? "" };
  // A custom endpoint may not list its models, so its owner names them; everything else is asked.
  const custom = input.provider_kind === "compatible";
  const typed = [...new Set(input.models ?? [])].map((id) => ({ id }));
  if (custom && typed.length === 0) throw new HttpError(422, "model_discovery_failed", "至少需要 1 个模型 id");
  // Listing the models doubles as the credential check: nothing unusable is stored.
  const models = custom ? typed : await discoverModels(ctx.config, upstream).catch(unusable);
  if (custom) await pingModel(ctx.config, upstream, (input.default_model ?? typed[0]?.id) as string).catch(unusable);

  const id = crypto.randomUUID();
  await repo.insert(ctx.db, {
    ...row,
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    name: input.name.trim(),
    default_model: chooseDefaultModel(input.default_model, input.provider_kind, models),
    models,
    secret_enc: ctx.box.seal(SECRET_PURPOSE, upstream.apiKey),
    test_status: "success",
  });
  await audit.record(ctx.db, auth, "provider.create", { type: "provider", id }, { kind: input.provider_kind });
  return get(ctx, auth, id);
}

export async function update(
  ctx: Ctx,
  auth: Auth,
  id: string,
  input: Schema<"ProviderUpdateRequest">,
): Promise<Channel> {
  // A subscription channel has nothing to edit but its switch.
  if (subscriptionOf(id)) {
    const { enabled } = input as { enabled?: boolean | null };
    return typeof enabled === "boolean" ? enable(ctx, auth, id, enabled) : get(ctx, auth, id);
  }
  const existing = await mustFind(ctx, auth, id, "edit");
  const d = descriptorOf(existing.provider_kind);
  if (input.protocol && !pinnedProtocol(input.protocol)) throw badRequest(`unknown protocol "${input.protocol}"`);
  const next: Partial<repo.ProviderValues> = {};
  if (input.name?.trim()) next.name = input.name.trim();
  if (input.protocol != null) next.protocol = input.protocol;
  if (input.base_url != null && d?.supports_custom_base_url) next.base_url = normalizeBaseUrl(input.base_url);
  if (input.api_key?.trim()) next.secret_enc = ctx.box.seal(SECRET_PURPOSE, input.api_key.trim());

  const custom = existing.provider_kind === "compatible";
  const connectionChanged = "secret_enc" in next || "base_url" in next || "protocol" in next;
  const merged = { ...existing, ...next };
  if (custom && input.models) {
    next.models = [...new Set(input.models)].map((modelId) => ({ id: modelId }));
    if (next.models.length === 0) throw new HttpError(422, "model_discovery_failed", "至少需要 1 个模型 id");
  } else if (!custom && connectionChanged) {
    // Where it points or how it signs in changed: the model list is asked again, which also re-checks the key.
    next.models = await discoverModels(ctx.config, upstreamOf(ctx, merged)).catch(unusable);
  }
  const models = next.models ?? existing.models;
  if (input.default_model != null || next.models)
    next.default_model = chooseDefaultModel(
      input.default_model ?? existing.default_model,
      existing.provider_kind,
      models,
    );
  if (custom && connectionChanged && next.default_model !== null)
    await pingModel(
      ctx.config,
      upstreamOf(ctx, merged),
      (next.default_model ?? existing.default_model) as string,
    ).catch(unusable);
  if (connectionChanged) next.test_status = "success";

  if (Object.keys(next).length > 0) {
    await repo.update(ctx.db, id, next);
    // Never the key itself — only that it changed.
    const fields = Object.keys(next).map((field) => (field === "secret_enc" ? "api_key" : field));
    await audit.record(ctx.db, auth, "provider.update", { type: "provider", id }, { fields });
  }
  return get(ctx, auth, id);
}

export async function remove(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  if (subscriptionOf(id)) throw forbidden("a subscription channel is built in; switch it off instead");
  await mustFind(ctx, auth, id, "admin");
  await ctx.db.transaction().execute(async (tx) => {
    await sharing.revokeForResource(tx, "provider", id);
    await repo.remove(tx, id);
    await audit.record(tx, auth, "provider.delete", { type: "provider", id });
  });
}

// -- Checking a connection --

type TestResult = Schema<"ConnectionTestResult">;

async function timed(check: () => Promise<unknown>): Promise<TestResult> {
  const started = Date.now();
  try {
    await check();
    return { success: true, latency_ms: Date.now() - started, error_message: null };
  } catch (err) {
    if (!(err instanceof ModelDiscoveryError)) throw err;
    return { success: false, latency_ms: null, error_message: err.reason };
  }
}

/** One real request for a model when one is known, else a model listing. */
const check = (ctx: Ctx, upstream: Upstream, model: string | null | undefined): Promise<TestResult> =>
  timed(() => (model ? pingModel(ctx.config, upstream, model) : discoverModels(ctx.config, upstream)));

export async function test(ctx: Ctx, auth: Auth, id: string): Promise<TestResult> {
  const row = await mustFind(ctx, auth, id, "use");
  const result = await check(ctx, upstreamOf(ctx, row), row.default_model);
  await repo.update(ctx.db, id, { test_status: result.success ? "success" : "failed" });
  return result;
}

export function validate(ctx: Ctx, input: Schema<"ProviderValidateRequest">): Promise<TestResult> {
  const row = {
    provider_kind: input.provider_kind,
    protocol: input.protocol ?? null,
    base_url: normalizeBaseUrl(input.base_url),
    secret_enc: null,
  };
  return check(ctx, { ...upstreamOf(ctx, row), apiKey: input.api_key?.trim() ?? "" }, input.default_model);
}

export async function ping(ctx: Ctx, auth: Auth, input: Schema<"ProviderPingRequest">) {
  if (input.models.length === 0) throw new HttpError(422, "model_discovery_failed", "至少需要 1 个模型 id");
  // Re-testing a saved channel uses its stored key, so nobody has to type it again.
  const stored = input.provider_id ? upstreamOf(ctx, await mustFind(ctx, auth, input.provider_id, "edit")).apiKey : "";
  const apiKey = input.api_key?.trim() || stored;
  if (!apiKey) throw new HttpError(422, "model_discovery_failed", "请先填写 API Key 或先保存该模型再测试");
  const shape = pinnedProtocol(input.protocol) === "anthropic" ? "anthropic" : "openai";
  return pingModels(ctx.config, { baseUrl: input.base_url.trim(), apiKey, shape }, input.models).catch(unusable);
}

const labelsOf = (models: StoredModel[]): Record<string, string> =>
  Object.fromEntries(models.flatMap((model) => (model.label ? [[model.id, model.label]] : [])));

export async function probe(ctx: Ctx, input: Schema<"ProbeModelsRequest">): Promise<Schema<"ProbeModelsResponse">> {
  const row = {
    provider_kind: input.provider_kind,
    protocol: input.protocol ?? null,
    base_url: normalizeBaseUrl(input.base_url),
    secret_enc: null,
  };
  const models = await discoverModels(ctx.config, { ...upstreamOf(ctx, row), apiKey: input.api_key.trim() }).catch(
    unusable,
  );
  return {
    models: models.map((model) => model.id),
    model_labels: labelsOf(models),
    suggested_default: chooseDefaultModel(null, input.provider_kind, models),
  };
}

/** Ask the upstream again and add what is new; ids the owner added by hand are kept. */
export async function refreshModels(ctx: Ctx, auth: Auth, id: string): Promise<Schema<"DiscoverModelsResponse">> {
  const row = await mustFind(ctx, auth, id, "edit");
  const discovered = await discoverModels(ctx.config, upstreamOf(ctx, row)).catch((err) => unusable(err, 502));
  const byId = new Map([...row.models, ...discovered].map((model) => [model.id, model]));
  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  await repo.update(ctx.db, id, { models: merged });
  return {
    provider_id: id,
    discovered: discovered.map((model) => model.id),
    merged: merged.map((model) => model.id),
    model_labels: labelsOf(merged),
  };
}

// -- Defaults and the model picker --

/** Defaults pointing at a channel the member can no longer use read as unset. */
export async function getDefaults(ctx: Ctx, auth: Auth): Promise<ModelDefaults> {
  const stored = await storedDefaults(ctx, auth);
  if (!stored.default_provider_id || subscriptionOf(stored.default_provider_id)) return stored;
  const usable = await repo.find(ctx.db, auth, stored.default_provider_id);
  return usable ? stored : { ...stored, default_provider_id: null, default_model: null };
}

export async function patchDefaults(ctx: Ctx, auth: Auth, patch: Schema<"ModelDefaultsPatch">): Promise<ModelDefaults> {
  const next = { ...(await getDefaults(ctx, auth)) };
  if (patch.default_runtime) next.default_runtime = patch.default_runtime;
  if (patch.default_effort) next.default_effort = patch.default_effort;
  if (patch.default_model !== undefined) next.default_model = patch.default_model || null;
  if (patch.default_provider_id !== undefined) {
    if (patch.default_provider_id) await assertUsable(ctx, auth, patch.default_provider_id);
    next.default_provider_id = patch.default_provider_id || null;
    if (!next.default_provider_id) next.default_model = null;
  }
  await settings.set(ctx.db, auth, "model-defaults", next);
  return next;
}

/** Make a channel the member's default, on a runtime it can actually drive. */
export async function setDefault(ctx: Ctx, auth: Auth, id: string, model: string | null | undefined): Promise<void> {
  const subscription = subscriptionOf(id);
  const row = subscription ?? (await mustFind(ctx, auth, id, "use"));
  const current = await storedDefaults(ctx, auth);
  const runtimes: RuntimeId[] = subscription
    ? [subscription.runtime]
    : runtimesFor(compatibleProtocols((row as repo.ProviderRow).provider_kind, (row as repo.ProviderRow).protocol));
  await settings.set(ctx.db, auth, "model-defaults", {
    ...current,
    default_provider_id: id,
    default_model: model || row.default_model,
    default_runtime: runtimes.includes(current.default_runtime as RuntimeId)
      ? current.default_runtime
      : (runtimes[0] ?? current.default_runtime),
  } satisfies ModelDefaults);
}

/** Every (channel, model) the member can pick, resolved so a picker renders it verbatim. */
export async function modelOptions(ctx: Ctx, auth: Auth): Promise<Schema<"ModelOptionsResponse">> {
  const [channels, defaults] = await Promise.all([list(ctx, auth), getDefaults(ctx, auth)]);
  const groups = new Map<string, { rank: number; providers: Schema<"ModelOptionProvider">[] }>();
  for (const channel of channels) {
    const models = channel.models.flatMap((model) => {
      const runtimes = model.runtimes ?? [];
      const first = runtimes[0];
      if (first === undefined) return [];
      return [
        {
          model_id: model.id,
          provider_id: channel.id,
          label: model.label ?? model.id,
          runtimes,
          default_runtime: first,
          is_current_default: channel.id === defaults.default_provider_id && model.id === defaults.default_model,
        },
      ];
    });
    if (models.length === 0) continue;
    const group = groups.get(channel.group) ?? { rank: channel.group_rank, providers: [] };
    groups.set(channel.group, group);
    group.providers.push({
      provider_id: channel.id,
      label: channel.name,
      kind: channel.provider_kind,
      source: channel.source,
      cli_tool: null,
      status: channel.enabled ? "available" : "unavailable",
      unavailable_reason: channel.unavailable_reason,
      models,
    });
  }
  return {
    current: {
      runtime: defaults.default_runtime,
      provider_id: defaults.default_provider_id,
      model: defaults.default_model,
    },
    groups: [...groups.entries()]
      .sort(([, a], [, b]) => a.rank - b.rank)
      .map(([key, group]) => ({ key, providers: group.providers })),
  };
}

export { subscriptionFor, subscriptionOf } from "./subscriptions.ts";
