import type { Db } from "@agent-base/db";

export interface AuditEntry {
  org_id: string;
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  detail: Record<string, unknown>;
}

export const insert = async (db: Db, entry: AuditEntry): Promise<void> =>
  void (await db
    .insertInto("audit_logs")
    .values({ ...entry, detail: JSON.stringify(entry.detail) })
    .execute());

export function list(db: Db, orgId: string, options: { limit: number; before?: number }) {
  let query = db
    .selectFrom("audit_logs as a")
    .leftJoin("users as u", "u.id", "a.actor_id")
    .select([
      "a.id",
      "a.action",
      "a.actor_id",
      "u.name as actor_name",
      "a.resource_type",
      "a.resource_id",
      "a.detail",
      "a.created_at",
    ])
    .where("a.org_id", "=", orgId)
    .orderBy("a.id", "desc")
    .limit(options.limit);
  if (options.before !== undefined) query = query.where("a.id", "<", options.before);
  return query.execute();
}
