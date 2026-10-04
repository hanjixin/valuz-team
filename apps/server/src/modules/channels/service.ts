/**
 * Binding a chat-app bot to an agent. Whoever may edit the agent may bind it;
 * the conversations people then have with the bot are the binder's own — their
 * device, their model channels — with that agent.
 */
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, badRequest, notFound } from "../../infra/errors.ts";
import * as agents from "../agents/service.ts";
import * as audit from "../audit/service.ts";
import * as devices from "../devices/service.ts";
import * as feishu from "./feishu.ts";
import * as lines from "./lines.ts";
import * as repo from "./repo.ts";
import * as wecom from "./wecom.ts";

type Binding = Schema<"FeishuBinding">;

const unbound = (auth: Auth, agentSlug: string): Binding => ({
  enabled: false,
  channel_instance_id: "",
  owner_user_id: auth.userId,
  agent_slug: agentSlug,
  app_id: "",
  has_app_secret: false,
  has_verification_token: false,
  has_encrypt_key: false,
  connected: false,
  connection_status: "disabled",
  connection_error: null,
});

/**
 * The device that keeps a bot connected: one of the binder's own (its
 * credentials go nowhere else) — the one it is already on, else one that is
 * online. With none linked yet, the first to say hello takes it.
 */
async function deviceFor(ctx: Ctx, auth: Auth, existing: repo.BindingRow | undefined): Promise<string | null> {
  const mine = (await devices.list(ctx, auth)).filter((device) => device.owner_id === auth.userId);
  if (existing?.owner_id === auth.userId && mine.some((device) => device.id === existing.device_id))
    return existing.device_id;
  return (mine.find((device) => device.online) ?? mine[0])?.id ?? null;
}

/** Store a binding and tell the devices concerned. */
async function save(
  ctx: Ctx,
  auth: Auth,
  existing: repo.BindingRow | undefined,
  row: Omit<Parameters<typeof repo.upsert>[1], "id" | "org_id" | "owner_id" | "device_id">,
): Promise<repo.BindingRow> {
  const saved = await repo.upsert(ctx.db, {
    ...row,
    id: existing?.id ?? crypto.randomUUID(),
    org_id: auth.orgId,
    owner_id: auth.userId,
    device_id: await deviceFor(ctx, auth, existing),
  });
  if (existing?.device_id && existing.device_id !== saved.device_id) await lines.sync(ctx, existing.device_id);
  await lines.sync(ctx, saved.device_id);
  return saved;
}

async function present(ctx: Ctx, row: repo.BindingRow): Promise<Binding> {
  const secrets = feishu.secretsOf(ctx, row);
  return {
    enabled: row.enabled,
    // Also the last segment of the binding's callback URL.
    channel_instance_id: row.id,
    owner_user_id: row.owner_id,
    agent_slug: row.agent_slug,
    app_id: row.app_id,
    has_app_secret: Boolean(secrets.app_secret),
    has_verification_token: Boolean(secrets.verification_token),
    has_encrypt_key: Boolean(secrets.encrypt_key),
    ...(await lines.connection(ctx, row)),
  };
}

export async function getFeishu(ctx: Ctx, auth: Auth, agentSlug: string): Promise<Binding> {
  await agents.require(ctx, auth, agentSlug);
  const row = await repo.find(ctx.db, auth.orgId, feishu.PLATFORM, agentSlug);
  return row ? present(ctx, row) : unbound(auth, agentSlug);
}

export async function putFeishu(
  ctx: Ctx,
  auth: Auth,
  agentSlug: string,
  input: Schema<"FeishuBindingUpdate">,
): Promise<Binding> {
  if (input.agent_slug.trim() !== agentSlug) throw badRequest("agent_slug mismatch");
  await agents.require(ctx, auth, agentSlug, "edit");
  const appId = input.app_id.trim();
  // The shape of a self-built app's id; the platform's long connection takes no other.
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId))
    throw badRequest('that is not a Feishu App ID — it looks like "cli_" followed by 16 characters', "invalid_app_id");
  const existing = await repo.find(ctx.db, auth.orgId, feishu.PLATFORM, agentSlug);
  const kept = existing ? feishu.secretsOf(ctx, existing) : null;
  // A secret left blank keeps the stored one; there must be one to keep.
  const appSecret = input.app_secret?.trim() || kept?.app_secret;
  if (!appSecret) throw new HttpError(422, "secret_required", "App Secret is required");
  const verification =
    input.verification_token === undefined ? kept?.verification_token : input.verification_token.trim();
  const encrypt = input.encrypt_key === undefined ? kept?.encrypt_key : input.encrypt_key.trim();

  const row = await save(ctx, auth, existing, {
    platform: feishu.PLATFORM,
    agent_slug: agentSlug,
    app_id: appId,
    secret_enc: feishu.seal(ctx, {
      app_secret: appSecret,
      ...(verification ? { verification_token: verification } : {}),
      ...(encrypt ? { encrypt_key: encrypt } : {}),
    }),
    enabled: input.enabled,
  });
  await audit.record(
    ctx.db,
    auth,
    "channel.bind",
    { type: "agent", id: agentSlug },
    { platform: feishu.PLATFORM, app_id: appId, enabled: input.enabled },
  );
  return present(ctx, row);
}

export async function testFeishu(ctx: Ctx, auth: Auth, agentSlug: string): Promise<Schema<"FeishuBindingTestResult">> {
  await agents.require(ctx, auth, agentSlug);
  const row = await repo.find(ctx.db, auth.orgId, feishu.PLATFORM, agentSlug);
  if (!row) throw notFound("feishu binding");
  const error = await feishu.checkCredentials(ctx, row);
  return { credential_ok: error === null, error, ...(await lines.connection(ctx, row)) };
}

// ------------------------------------------------------------------ WeCom smart bots

type WeComBinding = Schema<"WeComAIBotBinding">;

const presentWeCom = async (ctx: Ctx, row: repo.BindingRow): Promise<WeComBinding> => ({
  enabled: row.enabled,
  channel_instance_id: row.id,
  owner_user_id: row.owner_id,
  agent_slug: row.agent_slug,
  bot_id: row.app_id,
  has_secret: Boolean(wecom.secretOf(ctx, row)),
  ...(await lines.connection(ctx, row)),
});

export async function getWeCom(ctx: Ctx, auth: Auth, agentSlug: string): Promise<WeComBinding> {
  await agents.require(ctx, auth, agentSlug);
  const row = await repo.find(ctx.db, auth.orgId, wecom.PLATFORM, agentSlug);
  if (row) return presentWeCom(ctx, row);
  return {
    enabled: false,
    channel_instance_id: "",
    owner_user_id: auth.userId,
    agent_slug: agentSlug,
    bot_id: "",
    has_secret: false,
    connected: false,
    connection_status: "disabled",
    connection_error: null,
  };
}

export async function putWeCom(
  ctx: Ctx,
  auth: Auth,
  agentSlug: string,
  input: Schema<"WeComAIBotBindingUpdate">,
): Promise<WeComBinding> {
  if (input.agent_slug.trim() !== agentSlug) throw badRequest("agent_slug mismatch");
  await agents.require(ctx, auth, agentSlug, "edit");
  const botId = input.bot_id.trim();
  if (!botId) throw badRequest("the bot's Bot ID is required");
  const existing = await repo.find(ctx.db, auth.orgId, wecom.PLATFORM, agentSlug);
  // A secret left blank keeps the stored one; there must be one to keep.
  const secret = input.secret?.trim() || (existing ? wecom.secretOf(ctx, existing) : "");
  if (!secret) throw new HttpError(422, "secret_required", "Secret is required");
  const row = await save(ctx, auth, existing, {
    platform: wecom.PLATFORM,
    agent_slug: agentSlug,
    app_id: botId,
    secret_enc: wecom.seal(ctx, secret),
    enabled: input.enabled,
  });
  await audit.record(
    ctx.db,
    auth,
    "channel.bind",
    { type: "agent", id: agentSlug },
    { platform: wecom.PLATFORM, bot_id: botId, enabled: input.enabled },
  );
  return presentWeCom(ctx, row);
}
