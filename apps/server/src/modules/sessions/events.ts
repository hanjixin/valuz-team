/** Reading a session's event log: a page of history, the last few turns, or a live stream. */
import type { Schema } from "@agent-base/contract";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Auth, Ctx } from "../../infra/context.ts";
import { orgChannel } from "../../infra/pubsub.ts";
import * as projects from "../projects/service.ts";
import { sessionChannel } from "./dispatch.ts";
import * as repo from "./repo.ts";
import * as service from "./service.ts";
import { type StoredEventRow, toControlFrame, toEnvelope, toFrame } from "./translate.ts";

const PAGE = 500;
const HEARTBEAT_MS = 15_000;

const envelopes = (rows: StoredEventRow[]): Schema<"SessionEventEnvelope">[] =>
  rows.flatMap((row) => {
    const frame = toFrame(row);
    return frame ? [toEnvelope(frame)] : [];
  });

export async function listAfter(
  ctx: Ctx,
  sessionId: string,
  afterSeq: number,
): Promise<Schema<"SessionEventsResponse">> {
  return { session_id: sessionId, items: envelopes(await repo.eventsAfter(ctx.db, sessionId, afterSeq, 5000)) };
}

export async function window(
  ctx: Ctx,
  sessionId: string,
  beforeSeq: number | undefined,
  turnLimit: number,
): Promise<Schema<"SessionEventWindowResponse">> {
  const { rows, hasMore } = await repo.eventWindow(ctx.db, sessionId, beforeSeq, turnLimit);
  return { session_id: sessionId, items: envelopes(rows), has_more: hasMore };
}

/**
 * Server-sent events: everything stored after `afterSeq`, then whatever
 * arrives, with nothing lost or repeated in between. A frame without
 * `event_type` is a heartbeat carrying the cursor to resume from.
 */
export async function stream(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  afterSeq: number,
): Promise<void> {
  let cursor = afterSeq;
  const send = (payload: unknown): void => reply.sse({ data: JSON.stringify(payload) });
  const deliver = (row: StoredEventRow): void => {
    if (row.seq <= cursor) return;
    cursor = row.seq;
    const frame = toFrame(row);
    if (frame) send(frame);
  };

  // Subscribe first and hold what arrives, so nothing published during the replay is missed.
  let held: StoredEventRow[] | null = [];
  const unsubscribe = await ctx.pubsub.subscribe(sessionChannel(sessionId), (payload) => {
    const row = payload as StoredEventRow;
    if (held) held.push(row);
    else deliver(row);
  });
  const heartbeat = setInterval(() => send({ seq: cursor }), HEARTBEAT_MS);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  for (;;) {
    const page = await repo.eventsAfter(ctx.db, sessionId, cursor, PAGE);
    page.forEach(deliver);
    if (page.length < PAGE) break;
  }
  for (const row of held) deliver(row);
  held = null;
  // The caller now knows where history ends.
  send({ seq: cursor });
}

/**
 * The caller's own stream: lifecycle frames for every session they can see,
 * replayed from `afterSeq` and then live. Heartbeats are `event: heartbeat`.
 */
export async function streamForUser(
  ctx: Ctx,
  auth: Auth,
  req: FastifyRequest,
  reply: FastifyReply,
  afterSeq: number,
): Promise<void> {
  let cursor = afterSeq;
  const beat = (): void => reply.sse({ event: "heartbeat", data: JSON.stringify({ seq: cursor }) });
  const deliver = (row: StoredEventRow & { session_id: string }): void => {
    if (row.seq <= cursor) return;
    cursor = row.seq;
    const frame = toControlFrame(row);
    if (frame) reply.sse({ event: frame.event_type, data: JSON.stringify(frame) });
  };

  // Whether the caller may see a session is asked once per session per connection.
  const visible = new Map<string, Promise<boolean>>();
  const maySee = (sessionId: string): Promise<boolean> => {
    let answer = visible.get(sessionId);
    if (!answer) {
      answer = service.access(ctx, auth, sessionId).then(
        () => true,
        () => false,
      );
      visible.set(sessionId, answer);
    }
    return answer;
  };

  let held: (StoredEventRow & { session_id: string })[] | null = [];
  const unsubscribe = await ctx.pubsub.subscribe(orgChannel(auth.orgId), (payload) => {
    const message = payload as { type?: string; session_id?: string; event?: StoredEventRow };
    if (message.type !== "session.event" || !message.session_id || !message.event) return;
    const row = { ...message.event, session_id: message.session_id };
    void maySee(row.session_id).then((allowed) => {
      if (!allowed) return;
      if (held) held.push(row);
      else deliver(row);
    });
  });
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  const projectIds = (await projects.list(ctx, auth)).map((project) => project.id);
  for (;;) {
    const page = await repo.lifecycleAfter(ctx.db, auth, projectIds, cursor, PAGE);
    page.forEach(deliver);
    if (page.length < PAGE) break;
  }
  for (const row of held.sort((a, b) => a.seq - b.seq)) deliver(row);
  held = null;
  beat();
}
