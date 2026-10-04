import type { Db } from "@agent-base/db";

export interface Inbox {
  orgId: string;
  userId: string;
}

const mine = (db: Db, inbox: Inbox) =>
  db.selectFrom("notifications").selectAll().where("org_id", "=", inbox.orgId).where("user_id", "=", inbox.userId);

export type NotificationRow = Awaited<ReturnType<typeof listOpen>>[number];

export const listOpen = (db: Db, inbox: Inbox) =>
  mine(db, inbox).where("resolved_at", "is", null).orderBy("created_at", "desc").limit(200).execute();

export const listHistory = (db: Db, inbox: Inbox, before: Date | undefined, limit: number) =>
  mine(db, inbox)
    .$if(before !== undefined, (qb) => qb.where("created_at", "<", before as Date))
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();

export const insert = (
  db: Db,
  row: {
    id: string;
    org_id: string;
    user_id: string;
    kind: string;
    title: string;
    body: string;
    route: string | null;
    action: string;
    urgency: string;
    project_id: string | null;
    session_id: string | null;
    payload: string;
  },
) => db.insertInto("notifications").values(row).returningAll().executeTakeFirstOrThrow();

/** Mark as read (or resolved) what is still in the inbox and not yet so; returns the rows that changed. */
export const stamp = (db: Db, inbox: Inbox, column: "read_at" | "resolved_at", id?: string) =>
  db
    .updateTable("notifications")
    .set({ [column]: new Date() })
    .where("org_id", "=", inbox.orgId)
    .where("user_id", "=", inbox.userId)
    .where(column, "is", null)
    .where("resolved_at", "is", null)
    .$if(id !== undefined, (qb) => qb.where("id", "=", id as string))
    .returningAll()
    .execute();
