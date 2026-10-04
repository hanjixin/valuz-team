/** Reading a session's event log: a page of history, the last few turns, or a live stream. */
import type { Schema } from "@agent-base/contract";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../../infra/context.ts";
import { sessionChannel } from "./dispatch.ts";
import * as repo from "./repo.ts";
import { type StoredEventRow, toEnvelope, toFrame } from "./translate.ts";

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
