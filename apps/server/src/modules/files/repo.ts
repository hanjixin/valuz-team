import type { Db } from "@agent-base/db";

export interface Owner {
  orgId: string;
  userId: string;
}

export type AttachmentRow = Awaited<ReturnType<typeof listStaged>>[number];

export const insert = (
  db: Db,
  row: {
    id: string;
    org_id: string;
    owner_id: string;
    file_name: string;
    size_bytes: number;
    mime_type: string | null;
    storage_key: string | null;
    kb_document_id?: string;
  },
) => db.insertInto("attachments").values(row).returningAll().executeTakeFirstOrThrow();

/** Uploaded by this member, not yet part of a message. */
export const listStaged = (db: Db, owner: Owner) =>
  db
    .selectFrom("attachments")
    .selectAll()
    .where("org_id", "=", owner.orgId)
    .where("owner_id", "=", owner.userId)
    .where("session_id", "is", null)
    .orderBy("created_at")
    .execute();

export const listForSession = (db: Db, sessionId: string) =>
  db.selectFrom("attachments").selectAll().where("session_id", "=", sessionId).orderBy("created_at").execute();

/** The caller's own staged attachments among `ids`. */
export const stagedByIds = (db: Db, owner: Owner, ids: string[]) =>
  db
    .selectFrom("attachments")
    .selectAll()
    .where("org_id", "=", owner.orgId)
    .where("owner_id", "=", owner.userId)
    .where("session_id", "is", null)
    .where("id", "in", ids)
    .execute();

export const markDelivered = async (db: Db, id: string, sessionId: string, devicePath: string): Promise<void> =>
  void (await db
    .updateTable("attachments")
    .set({ session_id: sessionId, device_path: devicePath, consumed_at: new Date() })
    .where("id", "=", id)
    .execute());

/** Remove one of the caller's attachments and say where its bytes were. */
export const remove = (db: Db, owner: Owner, id: string) =>
  db
    .deleteFrom("attachments")
    .where("id", "=", id)
    .where("org_id", "=", owner.orgId)
    .where("owner_id", "=", owner.userId)
    .returning("storage_key")
    .executeTakeFirst();
