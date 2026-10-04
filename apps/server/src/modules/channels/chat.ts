/**
 * What every chat-app channel does once a message has arrived and been
 * authenticated: each chat is a session with the bound agent — the binder's
 * own, on their device — and the agent's answer goes back to the chat.
 */
import { authFor } from "../../infra/auth.ts";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError } from "../../infra/errors.ts";
import * as notifications from "../notifications/service.ts";
import { type TurnEnd, dispatchTurn, enqueue } from "../sessions/dispatch.ts";
import * as sessions from "../sessions/service.ts";
import * as repo from "./repo.ts";

/** How a platform sends text to one of its chats. */
type Send = (ctx: Ctx, binding: repo.BindingRow, chatId: string, text: string) => Promise<void>;

const platforms = new Map<string, { label: string; send: Send }>();

/** A platform says how it is called in session titles, and how it sends. */
export const registerPlatform = (platform: string, label: string, send: Send): void =>
  void platforms.set(platform, { label, send });

const say = async (ctx: Ctx, binding: repo.BindingRow, chatId: string, text: string): Promise<void> =>
  platforms.get(binding.platform)?.send(ctx, binding, chatId, text);

/** Take one event, once: platforms redeliver until they are acknowledged. */
export const firstTime = async (ctx: Ctx, bindingId: string, eventId: string): Promise<boolean> =>
  !eventId || (await ctx.redis.set(`channel-event:${bindingId}:${eventId}`, "1", "EX", 3600, "NX")) !== null;

/** Something a person said to the bot, in words. */
export async function hear(ctx: Ctx, binding: repo.BindingRow, chatId: string, text: string): Promise<void> {
  if (text === "/new") {
    await repo.closeThread(ctx.db, binding.id, chatId);
    return say(ctx, binding, chatId, "已开始新会话。");
  }
  try {
    const owner = await authFor(ctx, binding.org_id, binding.owner_id);
    if (!owner) throw new Error("绑定这个机器人的成员已不在组织中");
    const sessionId = await sessionFor(ctx, binding, owner, chatId);
    try {
      await dispatchTurn(ctx, sessionId, text, {
        user_id: owner.userId,
        name: platforms.get(binding.platform)?.label ?? binding.platform,
      });
    } catch (err) {
      if (!(err instanceof HttpError) || err.code !== "session_busy") throw err;
      // Mid-turn: it waits its turn like any message typed during a run.
      await enqueue(ctx, owner, sessionId, text);
    }
  } catch (err) {
    const offline = err instanceof HttpError && (err.code === "device_offline" || err.code === "no_device");
    await say(
      ctx,
      binding,
      chatId,
      offline ? "执行设备当前不在线，请稍后再试。" : `无法处理这条消息：${(err as Error).message}`,
    );
  }
}

/** Something the bot cannot take (an image, a file): said in the chat rather than dropped silently. */
export const decline = (ctx: Ctx, binding: repo.BindingRow, chatId: string): Promise<void> =>
  say(ctx, binding, chatId, "目前只支持文本消息。");

/** The chat's session, created on first contact: the binding owner's, with the bound agent. */
async function sessionFor(ctx: Ctx, binding: repo.BindingRow, owner: Auth, chatId: string): Promise<string> {
  const existing = await repo.threadSession(ctx.db, binding.id, chatId);
  if (existing) return existing;
  const label = platforms.get(binding.platform)?.label ?? binding.platform;
  const session = await sessions.create(
    ctx,
    owner,
    { project_id: "chat-default", agent_slug: binding.agent_slug, title: `${label} · ${binding.agent_slug}` },
    { origin: "user", metadata: { valuz: { channel: { binding_id: binding.id, chat_id: chatId } } } },
  );
  return repo.openThread(ctx.db, binding.id, chatId, session.id);
}

/** A turn ended on a device: if the session belongs to a chat, answer there. */
export async function handleTurnEnd(ctx: Ctx, turn: TurnEnd): Promise<void> {
  if (turn.status === "running" || turn.status === "cancelled") return;
  const session = await sessions.byId(ctx, turn.session_id);
  const meta = (session?.metadata as { valuz?: { channel?: { binding_id?: string; chat_id?: string } } } | undefined)
    ?.valuz?.channel;
  if (!session || !meta?.binding_id || !meta.chat_id) return;
  const binding = await repo.byId(ctx.db, meta.binding_id);
  if (!binding) return;
  const text =
    turn.status === "completed"
      ? turn.assistant_message?.trim() || "（已完成，没有文字回复）"
      : `运行出错：${String((turn.error_message as { message?: unknown } | null)?.message ?? "未知错误")}`;
  try {
    await say(ctx, binding, meta.chat_id, text);
  } catch (err) {
    const label = platforms.get(binding.platform)?.label ?? binding.platform;
    await notifications.notify(
      ctx,
      { orgId: binding.org_id, userId: binding.owner_id },
      {
        kind: "channel_send_failed",
        title: `${label}回复发送失败：${binding.agent_slug}`,
        body: (err as Error).message.slice(0, 300),
        route: `/conversation/${turn.session_id}`,
        sessionId: turn.session_id,
      },
    );
  }
}
