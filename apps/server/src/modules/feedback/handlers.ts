/**
 * What people did with a turn: rated it, copied it. Each member's feedback is
 * their own — in a shared session, colleagues do not see one another's.
 */
import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { HttpError, notFound } from "../../infra/errors.ts";
import * as sessions from "../sessions/service.ts";
import * as repo from "./repo.ts";

type Req = Parameters<Handler>[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Anyone who can see a session can leave feedback on it. */
const viewer = async (req: Req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const sessionId = (req.params as { session_id: string }).session_id;
  await sessions.access(ctx, auth, sessionId);
  return { ctx, auth, sessionId };
};

const present = (row: repo.FeedbackRow): Schema<"FeedbackRecord"> => ({
  id: row.id,
  session_id: row.session_id,
  message_id: row.message_id,
  action: row.action as Schema<"FeedbackRecord">["action"],
  block_ref: row.block_ref,
  value: row.value as Schema<"FeedbackRecord">["value"],
  reason_code: row.reason_code,
  reason: row.reason,
  target: { type: "message", id: row.message_id },
  source: row.source as Schema<"FeedbackRecord">["source"],
  surface: row.surface,
  occurrences: row.occurrences,
  created_at: row.created_at.getTime(),
  updated_at: row.updated_at.getTime(),
  metadata: row.metadata,
});

export const listSessionFeedback: Handler = async (req) => {
  const { ctx, auth, sessionId } = await viewer(req);
  return { items: (await repo.list(ctx.db, sessionId, auth.userId)).map(present) };
};

export const recordSessionFeedback: Handler = async (req, reply) => {
  const { ctx, auth, sessionId } = await viewer(req);
  const input = req.body as Schema<"RecordFeedbackRequest">;
  const rating = input.action === "rating";
  if (rating !== (input.value != null))
    throw new HttpError(
      422,
      "invalid_feedback",
      rating ? "a rating needs a value: up or down" : "only a rating carries a value",
    );
  if (!UUID.test(input.message_id) || !(await repo.turnExists(ctx.db, sessionId, input.message_id)))
    throw notFound("message");
  const row = await repo.record(ctx.db, {
    session_id: sessionId,
    message_id: input.message_id,
    user_id: auth.userId,
    action: input.action,
    block_ref: input.block_ref ?? "",
    value: input.value ?? null,
    reason_code: input.reason_code ?? input.reason_codes?.[0] ?? null,
    reason: input.reason ?? null,
    source: input.source ?? "api",
    surface: input.surface ?? null,
    metadata: { ...(input.metadata ?? {}), ...(input.reason_codes ? { reason_codes: input.reason_codes } : {}) },
  });
  return reply.code(201).send(present(row));
};

export const withdrawSessionFeedback: Handler = async (req, reply) => {
  const { ctx, auth, sessionId } = await viewer(req);
  const { message_id, action, block_ref } = req.query as { message_id?: string; action?: string; block_ref?: string };
  const removed =
    message_id && action && UUID.test(message_id)
      ? await repo.withdraw(ctx.db, {
          session_id: sessionId,
          message_id,
          user_id: auth.userId,
          action,
          block_ref: block_ref ?? "",
        })
      : false;
  if (!removed) throw notFound("feedback");
  return reply.code(204).send();
};
