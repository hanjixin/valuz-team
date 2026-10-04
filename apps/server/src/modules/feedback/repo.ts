import type { Db } from "@agent-base/db";
import { sql } from "kysely";

export type FeedbackRow = Awaited<ReturnType<typeof list>>[number];

export const list = (db: Db, sessionId: string, userId: string) =>
  db
    .selectFrom("message_feedback")
    .selectAll()
    .where("session_id", "=", sessionId)
    .where("user_id", "=", userId)
    .orderBy("created_at")
    .execute();

/** Whether the turn belongs to the session. */
export const turnExists = async (db: Db, sessionId: string, messageId: string): Promise<boolean> =>
  (await db
    .selectFrom("messages")
    .select("id")
    .where("id", "=", messageId)
    .where("session_id", "=", sessionId)
    .executeTakeFirst()) !== undefined;

export interface FeedbackValues {
  session_id: string;
  message_id: string;
  user_id: string;
  action: string;
  block_ref: string;
  value: string | null;
  reason_code: string | null;
  reason: string | null;
  source: string;
  surface: string | null;
  metadata: Record<string, unknown>;
}

/** The first time creates the row; doing it again counts it and takes the newer details. */
export const record = (db: Db, values: FeedbackValues) =>
  db
    .insertInto("message_feedback")
    .values({ id: crypto.randomUUID(), ...values, metadata: JSON.stringify(values.metadata) })
    .onConflict((oc) =>
      oc.columns(["user_id", "message_id", "action", "block_ref"]).doUpdateSet({
        value: values.value,
        reason_code: values.reason_code,
        reason: values.reason,
        source: values.source,
        surface: values.surface,
        metadata: JSON.stringify(values.metadata),
        occurrences: sql`message_feedback.occurrences + 1`,
        updated_at: new Date(),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

export const withdraw = async (
  db: Db,
  key: { session_id: string; message_id: string; user_id: string; action: string; block_ref: string },
): Promise<boolean> =>
  (
    await db
      .deleteFrom("message_feedback")
      .where("session_id", "=", key.session_id)
      .where("message_id", "=", key.message_id)
      .where("user_id", "=", key.user_id)
      .where("action", "=", key.action)
      .where("block_ref", "=", key.block_ref)
      .executeTakeFirst()
  ).numDeletedRows > 0n;
