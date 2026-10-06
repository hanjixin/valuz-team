import type { Db, MemorySnapshotEntry } from "@agent-base/db";
import { sql } from "kysely";

export type Target = "user" | "global" | "project";

/** Whose memory: a member's own (`user`, `global`), or a project's. */
export interface Scope {
  orgId: string;
  target: Target;
  /** The member, for `user` and `global`. */
  userId: string;
  /** The project, for `project`. */
  projectId: string | null;
}

const within = (db: Db, scope: Scope) => {
  const query = db.selectFrom("memories").where("org_id", "=", scope.orgId).where("target", "=", scope.target);
  return scope.target === "project"
    ? query.where("project_id", "=", scope.projectId)
    : query.where("user_id", "=", scope.userId);
};

export const entries = async (db: Db, scope: Scope): Promise<{ id: string; content: string }[]> =>
  within(db, scope).select(["id", "content"]).orderBy("created_at").orderBy("id").execute();

/**
 * Change a scope's entries as one step: `change` sees what is there and says
 * what to add, rewrite and remove. Writers of the same scope take turns, so a
 * size limit checked inside `change` holds.
 */
export async function mutate<T>(
  db: Db,
  scope: Scope,
  source: string,
  change: (current: { id: string; content: string }[]) => {
    result: T;
    add?: string[];
    rewrite?: { id: string; content: string }[];
    remove?: string[];
  },
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    const key = `memory:${scope.orgId}:${scope.target}:${scope.target === "project" ? scope.projectId : scope.userId}`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx);
    const { result, add = [], rewrite = [], remove = [] } = change(await entries(tx, scope));
    if (remove.length > 0) await tx.deleteFrom("memories").where("id", "in", remove).execute();
    for (const { id, content } of rewrite)
      await tx.updateTable("memories").set({ content, source }).where("id", "=", id).execute();
    if (add.length > 0)
      await tx
        .insertInto("memories")
        .values(
          add.map((content) => ({
            id: crypto.randomUUID(),
            org_id: scope.orgId,
            target: scope.target,
            user_id: scope.target === "project" ? null : scope.userId,
            project_id: scope.target === "project" ? scope.projectId : null,
            content,
            source,
          })),
        )
        .execute();
    return result;
  });
}

/** A scope's entries with when and by whom each was written, oldest first. */
export const detailed = (db: Db, scope: Scope) =>
  within(db, scope).select(["id", "content", "source", "created_at"]).orderBy("created_at").orderBy("id").execute();

const lock = (db: Db, scope: Scope) => {
  const key = `memory:${scope.orgId}:${scope.target}:${scope.target === "project" ? scope.projectId : scope.userId}`;
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(db);
};

const snapshotsOf = (db: Db, scope: Scope) => {
  const query = db.selectFrom("memory_snapshots").where("org_id", "=", scope.orgId).where("target", "=", scope.target);
  return scope.target === "project"
    ? query.where("project_id", "=", scope.projectId)
    : query.where("user_id", "=", scope.userId);
};

const KEPT_SNAPSHOTS = 5;

/**
 * Rewrite a scope as a whole, keeping what it held as a snapshot. `expected`
 * are the ids the new entries were worked out from: if the scope changed
 * meanwhile nothing is written, so no entry added in between is lost.
 */
export async function rewrite(
  db: Db,
  scope: Scope,
  change: { expected: string[] | null; entries: { content: string; source: string }[]; reason: string },
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    await lock(tx, scope);
    const current = await detailed(tx, scope);
    if (change.expected && current.map((entry) => entry.id).join() !== change.expected.join()) return false;
    await tx
      .insertInto("memory_snapshots")
      .values({
        id: crypto.randomUUID(),
        org_id: scope.orgId,
        target: scope.target,
        user_id: scope.target === "project" ? null : scope.userId,
        project_id: scope.target === "project" ? scope.projectId : null,
        entries: JSON.stringify(
          current.map((entry) => ({
            content: entry.content,
            source: entry.source,
            created_at: entry.created_at.toISOString(),
          })),
        ),
        reason: change.reason,
      })
      .execute();
    const stale = await snapshotsOf(tx, scope)
      .select("id")
      .orderBy("created_at", "desc")
      .offset(KEPT_SNAPSHOTS)
      .execute();
    if (stale.length > 0)
      await tx
        .deleteFrom("memory_snapshots")
        .where(
          "id",
          "in",
          stale.map((row) => row.id),
        )
        .execute();
    if (current.length > 0)
      await tx
        .deleteFrom("memories")
        .where(
          "id",
          "in",
          current.map((entry) => entry.id),
        )
        .execute();
    // Entries are read back in the order they were written: keep the new list's order.
    const base = Date.now();
    if (change.entries.length > 0)
      await tx
        .insertInto("memories")
        .values(
          change.entries.map((entry, index) => ({
            id: crypto.randomUUID(),
            org_id: scope.orgId,
            target: scope.target,
            user_id: scope.target === "project" ? null : scope.userId,
            project_id: scope.target === "project" ? scope.projectId : null,
            content: entry.content,
            source: entry.source,
            created_at: new Date(base + index),
          })),
        )
        .execute();
    return true;
  });
}

/** What the scope held before it was last rewritten. */
export const latestSnapshot = (
  db: Db,
  scope: Scope,
): Promise<{ entries: MemorySnapshotEntry[]; created_at: Date } | undefined> =>
  snapshotsOf(db, scope).select(["entries", "created_at"]).orderBy("created_at", "desc").limit(1).executeTakeFirst();

export const reviewedUntil = async (db: Db, sessionId: string): Promise<number> =>
  Number(
    (
      await db
        .selectFrom("memory_reviews")
        .select("reviewed_until")
        .where("session_id", "=", sessionId)
        .executeTakeFirst()
    )?.reviewed_until ?? 0,
  );

export const markReviewed = async (db: Db, sessionId: string, until: number): Promise<void> =>
  void (await db
    .insertInto("memory_reviews")
    .values({ session_id: sessionId, reviewed_until: until })
    .onConflict((oc) => oc.column("session_id").doUpdateSet({ reviewed_until: until }))
    .execute());
