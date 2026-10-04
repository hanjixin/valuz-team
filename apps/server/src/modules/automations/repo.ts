import type { AutomationTrigger, Db } from "@agent-base/db";
import { sql } from "kysely";

export type AutomationRow = NonNullable<Awaited<ReturnType<typeof find>>>;
export type RunRow = NonNullable<Awaited<ReturnType<typeof findRun>>>;

/** An automation with what its runs say about it. */
const automations = (db: Db) =>
  db
    .selectFrom("automations as a")
    .selectAll("a")
    .select((eb) => [
      eb
        .selectFrom("automation_runs as r")
        .whereRef("r.automation_id", "=", "a.id")
        .select(eb.fn.countAll<string>().as("n"))
        .as("total_runs"),
      eb
        .selectFrom("automation_runs as r")
        .whereRef("r.automation_id", "=", "a.id")
        .where("r.status", "=", "failed")
        .where("r.triggered_at", ">", sql<Date>`now() - interval '7 days'`)
        .select(eb.fn.countAll<string>().as("n"))
        .as("recent_failures"),
      eb
        .selectFrom("automation_runs as r")
        .whereRef("r.automation_id", "=", "a.id")
        .where("r.status", "!=", "skipped")
        .select("r.triggered_at")
        .orderBy("r.triggered_at", "desc")
        .limit(1)
        .as("last_run_at"),
      eb
        .selectFrom("automation_runs as r")
        .whereRef("r.automation_id", "=", "a.id")
        .where("r.status", "!=", "skipped")
        .select("r.status")
        .orderBy("r.triggered_at", "desc")
        .limit(1)
        .as("last_run_status"),
    ]);

export const find = (db: Db, orgId: string, id: string) =>
  automations(db).where("a.org_id", "=", orgId).where("a.id", "=", id).executeTakeFirst();

/** For the runner, which acts for no caller. */
export const byId = (db: Db, id: string) =>
  db.selectFrom("automations").selectAll().where("id", "=", id).executeTakeFirst();

export const listInProjects = (db: Db, orgId: string, projectIds: string[]) =>
  projectIds.length === 0
    ? Promise.resolve([])
    : automations(db)
        .where("a.org_id", "=", orgId)
        .where("a.project_id", "in", projectIds)
        .orderBy("a.created_at")
        .execute();

export const insert = (
  db: Db,
  row: {
    id: string;
    org_id: string;
    owner_id: string;
    project_id: string;
    name: string;
    agent_kind: string | null;
    agent_slug: string | null;
    action_kind: "chat" | "task";
    prompt_template: string;
    trigger: AutomationTrigger;
  },
) =>
  db
    .insertInto("automations")
    .values({ ...row, trigger: JSON.stringify(row.trigger) })
    .execute();

export const update = (
  db: Db,
  id: string,
  patch: {
    name?: string;
    agent_slug?: string | null;
    agent_kind?: string | null;
    action_kind?: "chat" | "task";
    prompt_template?: string;
    trigger?: AutomationTrigger;
    status?: "enabled" | "paused";
  },
) => {
  const { trigger, ...rest } = patch;
  return db
    .updateTable("automations")
    .set({ ...rest, ...(trigger ? { trigger: JSON.stringify(trigger) } : {}), updated_at: new Date() })
    .where("id", "=", id)
    .execute();
};

export const remove = (db: Db, id: string) => db.deleteFrom("automations").where("id", "=", id).execute();

// ---------------------------------------------------------------- runs

/** A run with the task it started, if it started one. */
const runs = (db: Db) =>
  db
    .selectFrom("automation_runs as r")
    .innerJoin("automations as a", "a.id", "r.automation_id")
    .leftJoin("tasks as t", "t.id", "r.task_id")
    .selectAll("r")
    .select(["a.project_id", "t.title as task_title", "t.status as task_state"]);

export const findRun = (db: Db, automationId: string, id: string) =>
  runs(db).where("r.automation_id", "=", automationId).where("r.id", "=", id).executeTakeFirst();

export function listRuns(db: Db, automationId: string, limit: number, before?: Date) {
  let query = runs(db).where("r.automation_id", "=", automationId).orderBy("r.triggered_at", "desc").limit(limit);
  if (before) query = query.where("r.triggered_at", "<", before);
  return query.execute();
}

export const hasActiveRun = async (db: Db, automationId: string): Promise<boolean> =>
  (await db
    .selectFrom("automation_runs")
    .select("id")
    .where("automation_id", "=", automationId)
    .where("status", "=", "running")
    .executeTakeFirst()) !== undefined;

export const insertRun = (
  db: Db,
  run: {
    id: string;
    automation_id: string;
    trigger_type: string;
    status: string;
    input?: unknown;
    error_code?: string;
    error_message?: string;
  },
) => {
  const { input, ...rest } = run;
  const now = new Date();
  const settled = run.status !== "running";
  return db
    .insertInto("automation_runs")
    .values({
      ...rest,
      input: input === undefined || input === null ? null : JSON.stringify(input),
      started_at: settled ? null : now,
      completed_at: settled ? now : null,
    })
    .execute();
};

export const linkRun = (db: Db, id: string, link: { session_id?: string; task_id?: string }) =>
  db.updateTable("automation_runs").set(link).where("id", "=", id).execute();

/** End a run that is still going. Returns the run's automation when this call is what ended it. */
export async function settleRun(
  db: Db,
  match: { id: string } | { sessionId: string },
  outcome: {
    status: string;
    result_summary?: string | null;
    error_code?: string | null;
    error_message?: string | null;
  },
) {
  let query = db
    .updateTable("automation_runs")
    .set({ ...outcome, completed_at: new Date() })
    .where("status", "=", "running");
  query = "id" in match ? query.where("id", "=", match.id) : query.where("session_id", "=", match.sessionId);
  const run = await query.returning(["id", "automation_id", "session_id"]).executeTakeFirst();
  return run ? { run, automation: await byId(db, run.automation_id) } : null;
}

export const requestCancel = (db: Db, id: string) =>
  db.updateTable("automation_runs").set({ cancel_requested_at: new Date() }).where("id", "=", id).execute();
