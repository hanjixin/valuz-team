/**
 * A member's inbox: things that happened while they were not looking, or that
 * need something from them. Other modules add to it with `notify`; an open
 * stream hears about each change as it happens.
 */
import type { Schema } from "@agent-base/contract";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../../infra/context.ts";
import * as repo from "./repo.ts";

type Entry = Schema<"NotificationEntry">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const channel = (inbox: repo.Inbox): string => `inbox:${inbox.orgId}:${inbox.userId}`;

const present = (row: repo.NotificationRow): Entry => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  route: row.route,
  action: row.action,
  urgency: row.urgency,
  task_id: null,
  project_id: row.project_id,
  session_id: row.session_id,
  pending_id: null,
  payload: row.payload,
  created_at: row.created_at.getTime(),
  read_at: row.read_at?.getTime() ?? null,
  resolved_at: row.resolved_at?.getTime() ?? null,
});

export interface Notice {
  kind: string;
  title: string;
  body?: string;
  /** Where clicking it leads, inside the app. */
  route?: string;
  projectId?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

/** Put something in a member's inbox. Never fails the action it reports on. */
export async function notify(ctx: Ctx, inbox: repo.Inbox, notice: Notice): Promise<void> {
  try {
    const row = await repo.insert(ctx.db, {
      id: crypto.randomUUID(),
      org_id: inbox.orgId,
      user_id: inbox.userId,
      kind: notice.kind,
      title: notice.title,
      body: notice.body ?? "",
      route: notice.route ?? null,
      action: "none",
      urgency: "info",
      project_id: notice.projectId ?? null,
      session_id: notice.sessionId ?? null,
      payload: JSON.stringify(notice.payload ?? {}),
    });
    await ctx.pubsub.publish(channel(inbox), { event: "added", payload: { entry: present(row) } });
  } catch (err) {
    ctx.log(err, "could not deliver a notification");
  }
}

export async function listOpen(ctx: Ctx, inbox: repo.Inbox): Promise<Schema<"NotificationListResponse">> {
  const entries = (await repo.listOpen(ctx.db, inbox)).map(present);
  return { entries, unread: entries.filter((entry) => entry.read_at === null).length };
}

export async function history(
  ctx: Ctx,
  inbox: repo.Inbox,
  options: { limit: number; before?: number },
): Promise<Schema<"NotificationHistoryResponse">> {
  const before = options.before === undefined ? undefined : new Date(options.before);
  const rows = await repo.listHistory(ctx.db, inbox, before, options.limit + 1);
  return { entries: rows.slice(0, options.limit).map(present), has_more: rows.length > options.limit };
}

/** Mark one notification — or, with no id, all of them — as read. */
export async function markRead(ctx: Ctx, inbox: repo.Inbox, id?: string): Promise<void> {
  if (id !== undefined && !UUID.test(id)) return;
  for (const row of await repo.stamp(ctx.db, inbox, "read_at", id))
    await ctx.pubsub.publish(channel(inbox), { event: "updated", payload: { entry: present(row) } });
}

/** Take one notification — or all — out of the inbox. They stay in the history. */
export async function dismiss(ctx: Ctx, inbox: repo.Inbox, id?: string): Promise<void> {
  if (id !== undefined && !UUID.test(id)) return;
  for (const row of await repo.stamp(ctx.db, inbox, "resolved_at", id))
    await ctx.pubsub.publish(channel(inbox), { event: "resolved", payload: { id: row.id } });
}

/** Server-sent events: the inbox as it is now (`snapshot`), then each change. */
export async function stream(ctx: Ctx, inbox: repo.Inbox, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const send = (event: string, payload: unknown): void => reply.sse({ event, data: JSON.stringify({ payload }) });
  const unsubscribe = await ctx.pubsub.subscribe(channel(inbox), (message) => {
    const { event, payload } = message as { event: string; payload: unknown };
    send(event, payload);
  });
  const heartbeat = setInterval(() => send("heartbeat", {}), 15_000);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  send("snapshot", { entries: (await listOpen(ctx, inbox)).entries });
}
