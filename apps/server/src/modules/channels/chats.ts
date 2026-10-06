/**
 * "This group is that project." A member binds a group their Feishu bot is in
 * to a project, and what is said to the bot there becomes work in the project
 * instead of a quick chat. The group itself — listing the bot's groups, making
 * one with the bot in it, a link to join it, dissolving it — is the platform's
 * to say, and the platform is spoken to by the device that keeps the bot
 * connected (`channels.chats`), never from here.
 */
import type { Schema } from "@agent-base/contract";
import type { ChannelChat } from "@agent-base/protocol";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, conflict, notFound } from "../../infra/errors.ts";
import * as audit from "../audit/service.ts";
import * as projects from "../projects/service.ts";
import { actorOf } from "./chat.ts";
import * as feishu from "./feishu.ts";
import * as repo from "./repo.ts";

type ChatItem = Schema<"ChannelChatItem">;
type Binding = Schema<"ChatProjectBinding">;

/** The caller's own Feishu bot. Its groups are asked of the device that keeps it connected. */
async function botOf(ctx: Ctx, auth: Auth, agentSlug?: string): Promise<repo.BindingRow & { device_id: string }> {
  const bot = await repo.ownBot(ctx.db, auth.orgId, auth.userId, feishu.PLATFORM, agentSlug);
  if (!bot) throw notFound("feishu binding");
  if (!bot.device_id) throw conflict("no device keeps this bot connected yet — open the desktop app", "no_device");
  return { ...bot, device_id: bot.device_id };
}

async function onPlatform<T>(
  ctx: Ctx,
  bot: repo.BindingRow & { device_id: string },
  request: { op: "list" | "create" | "link" | "remove"; name?: string; chat_id?: string },
): Promise<T> {
  try {
    return (await ctx.hub.call(
      bot.device_id,
      "channels.chats",
      { bot_id: bot.id, op: request.op, name: request.name ?? "", chat_id: request.chat_id ?? "" },
      actorOf(bot.owner_id),
    )) as T;
  } catch (err) {
    if (err instanceof HttpError && err.code === "device_offline")
      throw conflict("the device that keeps this bot connected is offline", "device_offline");
    // What the platform refused, in its own words.
    if (err instanceof HttpError) throw new HttpError(502, "platform_error", err.message);
    throw err;
  }
}

const present = (row: Awaited<ReturnType<typeof repo.chatBindings>>[number]): Binding => ({
  channel_instance_id: row.binding_id,
  external_chat_id: row.external_chat_id,
  project_id: row.project_id,
  external_chat_name: row.external_chat_name,
  default_agent_slug: row.default_agent_slug,
  platform: row.platform === "wecom-aibot" ? "wecom_aibot" : "feishu",
  created_by_valuz: row.created_by_bot,
  needs_join: false,
});

/** The groups the caller's bot is in, each with the project it is bound to. */
export async function listChats(ctx: Ctx, auth: Auth, agentSlug?: string): Promise<ChatItem[]> {
  const bot = await botOf(ctx, auth, agentSlug);
  const { chats } = await onPlatform<{ chats: ChannelChat[] }>(ctx, bot, { op: "list" });
  const bound = new Map(
    (await repo.chatBindings(ctx.db, auth.orgId))
      .filter((row) => row.binding_id === bot.id)
      .map((row) => [row.external_chat_id, row]),
  );
  return chats.map((chat) => ({
    external_chat_id: chat.chat_id,
    name: chat.name,
    bound_project_id: bound.get(chat.chat_id)?.project_id ?? null,
    // Ownership is what the platform itself enforces; the stored flag covers what it cannot see.
    created_by_valuz: chat.bot_owned || (bound.get(chat.chat_id)?.created_by_bot ?? false),
    needs_join: chat.bot_owned && !chat.has_people,
  }));
}

/** Start conversations afresh where a chat's project changed: its old session belongs to where it was. */
const restart = (ctx: Ctx, botId: string, chatId: string) => repo.closeThread(ctx.db, botId, chatId);

export async function bind(
  ctx: Ctx,
  auth: Auth,
  input: {
    external_chat_id: string;
    project_id: string;
    external_chat_name?: string | null;
    default_agent_slug?: string | null;
  },
): Promise<Binding> {
  // Work arrives in the project from outside: that takes the right to change it.
  const project = await projects.require(ctx, auth, input.project_id, "edit");
  const bot = await repo.ownBot(ctx.db, auth.orgId, auth.userId, feishu.PLATFORM);
  if (!bot) throw notFound("feishu binding");
  const chatId = input.external_chat_id.trim();
  await repo.bindChat(ctx.db, {
    org_id: auth.orgId,
    binding_id: bot.id,
    external_chat_id: chatId,
    project_id: project.id,
    external_chat_name: input.external_chat_name?.trim() || null,
    default_agent_slug: input.default_agent_slug?.trim() || null,
  });
  await restart(ctx, bot.id, chatId);
  await audit.record(ctx.db, auth, "channel.bind_chat", { type: "project", id: project.id }, { chat: chatId });
  return present(
    (await repo.chatBindings(ctx.db, auth.orgId, project.id)).find(
      (row) => row.binding_id === bot.id && row.external_chat_id === chatId,
    ) as Awaited<ReturnType<typeof repo.chatBindings>>[number],
  );
}

/** A project's bound chats, for whoever can see the project; every one of the caller's bots' chats with none named. */
export async function listBindings(ctx: Ctx, auth: Auth, projectId?: string): Promise<Binding[]> {
  if (projectId) {
    const project = await projects.require(ctx, auth, projectId).catch(() => null);
    return project ? (await repo.chatBindings(ctx.db, auth.orgId, project.id)).map(present) : [];
  }
  return (await repo.chatBindings(ctx.db, auth.orgId)).filter((row) => row.bot_owner_id === auth.userId).map(present);
}

/** The binding of a chat the caller may change: their own bot's, or one in a project they may edit. */
async function changeable(ctx: Ctx, auth: Auth, chatId: string) {
  for (const row of await repo.chatBindings(ctx.db, auth.orgId)) {
    if (row.external_chat_id !== chatId) continue;
    if (row.bot_owner_id === auth.userId) return row;
    if (await projects.require(ctx, auth, row.project_id, "edit").catch(() => null)) return row;
  }
  return null;
}

export async function unbind(ctx: Ctx, auth: Auth, chatId: string): Promise<void> {
  const row = await changeable(ctx, auth, chatId);
  if (!row || !(await repo.unbindChat(ctx.db, row.binding_id, chatId))) throw notFound("chat binding");
  await restart(ctx, row.binding_id, chatId);
  await audit.record(ctx.db, auth, "channel.unbind_chat", { type: "project", id: row.project_id }, { chat: chatId });
}

/** Make a group with the bot in it, bound to a project from the start. The link is how a person joins. */
export async function create(
  ctx: Ctx,
  auth: Auth,
  input: { name: string; project_id: string },
): Promise<Schema<"CreatedChat">> {
  const project = await projects.require(ctx, auth, input.project_id, "edit");
  const bot = await botOf(ctx, auth);
  const name = input.name.trim();
  const made = await onPlatform<{ chat_id: string; share_link: string | null }>(ctx, bot, { op: "create", name });
  await repo.bindChat(ctx.db, {
    org_id: auth.orgId,
    binding_id: bot.id,
    external_chat_id: made.chat_id,
    project_id: project.id,
    external_chat_name: name,
    default_agent_slug: null,
    created_by_bot: true,
  });
  await audit.record(ctx.db, auth, "channel.create_chat", { type: "project", id: project.id }, { chat: made.chat_id });
  return { external_chat_id: made.chat_id, name, project_id: project.id, share_link: made.share_link };
}

export async function link(ctx: Ctx, auth: Auth, chatId: string): Promise<{ share_link: string | null }> {
  return onPlatform(ctx, await botOf(ctx, auth), { op: "link", chat_id: chatId });
}

/**
 * Dissolve a group the bot made, and drop its binding. Not conditioned on a
 * binding existing — a group the bot made and nobody bound is exactly what
 * needs cleaning up — but on the bot owning it: dissolving someone else's
 * group is not something to do from a project page, nor to undo.
 */
export async function dissolve(ctx: Ctx, auth: Auth, chatId: string): Promise<void> {
  const bot = await botOf(ctx, auth);
  const stored = await repo.chatBinding(ctx.db, bot.id, chatId);
  const owns =
    stored?.created_by_bot ||
    (await onPlatform<{ chats: ChannelChat[] }>(ctx, bot, { op: "list" })).chats.some(
      (chat) => chat.chat_id === chatId && chat.bot_owned,
    );
  if (!owns) throw conflict("the bot did not make this group; unlink it instead", "not_bot_owned");
  await onPlatform(ctx, bot, { op: "remove", chat_id: chatId });
  await repo.unbindChat(ctx.db, bot.id, chatId);
  await restart(ctx, bot.id, chatId);
  await audit.record(ctx.db, auth, "channel.dissolve_chat", { type: "agent", id: bot.agent_slug }, { chat: chatId });
}
