/**
 * Scheduled automations. Scheduling is BullMQ's job (repeatable job schedulers
 * on Redis): with several server replicas, each tick is still delivered to
 * exactly one worker. This module only decides what a tick does — start a
 * session for the automation's agent in its project and send the prompt.
 */
import { type Job, Queue, Worker } from "bullmq";
import type { Ctx } from "./context.ts";
import type { Row } from "./db.ts";
import type { TurnEnd } from "./device-hub.ts";
import { createSession, dispatchTurn } from "./dispatch.ts";
import { badRequest } from "./http.ts";

const QUEUE = "automations";

interface Tick {
  automationId: string;
  trigger: "schedule" | "manual";
}

/** BullMQ connection options for a Redis URL. */
export const redisConnection = (redisUrl: string) => {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: Number(url.pathname.slice(1) || 0),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
};

export class AutomationService {
  private readonly queue: Queue<Tick>;
  private worker: Worker<Tick> | null = null;

  constructor(private readonly ctx: Ctx) {
    this.queue = new Queue<Tick>(QUEUE, { connection: redisConnection(ctx.config.REDIS_URL) });
  }

  start(): void {
    this.worker = new Worker<Tick>(QUEUE, (job) => this.run(job), { connection: redisConnection(this.ctx.config.REDIS_URL), concurrency: 4 });
    this.worker.on("failed", (job, err) => console.error(`[automation ${job?.data.automationId}] ${err.message}`));
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  /** Make the schedule in Redis match the row (create, change, pause, or remove). */
  async sync(automation: Row): Promise<void> {
    const id = automation["id"] as string;
    if (!automation["enabled"]) return void (await this.queue.removeJobScheduler(id));
    try {
      await this.queue.upsertJobScheduler(
        id,
        { pattern: automation["cron"] as string, tz: automation["timezone"] as string },
        { name: "tick", data: { automationId: id, trigger: "schedule" }, opts: { removeOnComplete: 50, removeOnFail: 50 } },
      );
    } catch (err) {
      throw badRequest(`invalid schedule: ${(err as Error).message}`, "invalid_cron");
    }
  }

  remove(id: string): Promise<boolean> {
    return this.queue.removeJobScheduler(id);
  }

  async nextRun(id: string): Promise<number | null> {
    return (await this.queue.getJobScheduler(id))?.next ?? null;
  }

  runNow(id: string): Promise<Job<Tick>> {
    return this.queue.add("tick", { automationId: id, trigger: "manual" }, { removeOnComplete: 50, removeOnFail: 50 });
  }

  private async run(job: Job<Tick>): Promise<void> {
    const { automationId, trigger } = job.data;
    const a = await this.ctx.db.one(
      `SELECT a.*, p.device_id, p.root_path, u.name AS owner_name FROM automations a
         JOIN projects p ON p.id = a.project_id JOIN users u ON u.id = a.owner_id WHERE a.id = $1`,
      [automationId],
    );
    // Deleted or paused since this tick was queued.
    if (!a || (trigger === "schedule" && !a["enabled"])) return;
    const runId = crypto.randomUUID();
    await this.ctx.db.query("INSERT INTO automation_runs (id, automation_id, trigger, status) VALUES ($1, $2, $3, 'running')", [runId, automationId, trigger]);
    await this.ctx.db.query("UPDATE automations SET last_run_at = now() WHERE id = $1", [automationId]);
    try {
      if (!a["device_id"] || !a["root_path"]) throw new Error("the project has no device or folder bound");
      const agent = await this.ctx.db.one("SELECT * FROM agents WHERE org_id = $1 AND slug = $2", [a["org_id"], a["agent_slug"]]);
      if (!agent) throw new Error(`agent "${String(a["agent_slug"])}" no longer exists`);
      const session = await createSession(this.ctx, {
        orgId: a["org_id"] as string,
        ownerId: a["owner_id"] as string,
        agent,
        deviceId: a["device_id"] as string,
        projectId: a["project_id"] as string,
        cwd: a["root_path"] as string,
        title: `${String(a["name"])} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        metadata: { valuz: { automation: { automation_id: automationId, run_id: runId } } },
      });
      await this.ctx.db.query("UPDATE automation_runs SET session_id = $2 WHERE id = $1", [runId, session["id"]]);
      await dispatchTurn(this.ctx, session, { text: a["prompt"] as string, attachments: [], additional_context: "" }, {
        user_id: a["owner_id"] as string,
        name: a["owner_name"] as string,
      });
    } catch (err) {
      // A run that could not start is recorded, not retried: the next tick is the retry.
      await this.ctx.db.query("UPDATE automation_runs SET status = 'failed', error = $2, ended_at = now() WHERE id = $1", [runId, (err as Error).message]);
    }
  }

  /** A turn ended on a device: close the run it belongs to, if any. */
  async onTurnEnd(message: TurnEnd): Promise<void> {
    if (message.status === "running") return;
    const failed = message.status !== "completed";
    const run = await this.ctx.db.one(
      `UPDATE automation_runs r SET status = $2, error = $3, summary = $4, ended_at = now() FROM automations a
        WHERE r.session_id = $1 AND r.status = 'running' AND a.id = r.automation_id
        RETURNING a.owner_id, a.org_id, a.name, r.error, r.summary`,
      [
        message.session_id,
        failed ? "failed" : "completed",
        failed ? String((message.error_message as Row | null)?.["message"] ?? message.status) : null,
        message.assistant_message?.slice(0, 4000) ?? null,
      ],
    );
    if (!run) return;
    await this.ctx.notify(run["owner_id"] as string, run["org_id"] as string, {
      kind: failed ? "automation_failed" : "automation_completed",
      title: `${failed ? "自动化运行失败" : "自动化已完成"}：${String(run["name"])}`,
      body: String(run["error"] ?? run["summary"] ?? "").slice(0, 300),
      link: `/sessions/${message.session_id}`,
    });
  }
}
