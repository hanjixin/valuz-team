/**
 * Work that happens off the request path. Jobs wait in Redis (BullMQ), so any
 * replica may do what another accepted, a restart loses nothing, and a job can
 * be asked to start later.
 */
import { Queue, Worker } from "bullmq";
import type { FastifyInstance } from "fastify";

/** When a repeating job fires: by a cron pattern in a timezone, or every so many milliseconds. */
export type Repeat = { pattern: string; tz: string } | { everyMs: number };

export interface JobQueue<T> {
  add(jobs: T[], options?: { delayMs?: number }): Promise<void>;
  /**
   * Have `job` done repeatedly, under a name of the caller's choosing; calling
   * again with the same name replaces the schedule. With several replicas each
   * firing is still delivered to exactly one of them.
   */
  schedule(id: string, repeat: Repeat, job: T): Promise<void>;
  unschedule(id: string): Promise<void>;
  /** When `id` fires next (epoch ms), or null when it is not scheduled. */
  nextRun(id: string): Promise<number | null>;
}

/**
 * Start doing `name`'s jobs on this server, until it closes. A job that throws
 * is logged and dropped: handlers record their own failures where a person will see them.
 */
export function startJobs<T>(
  app: FastifyInstance,
  name: string,
  handle: (job: T) => Promise<void>,
  options: { concurrency?: number } = {},
): JobQueue<T> {
  const ctx = app.ctx;
  // BullMQ blocks on its connection, so it gets its own rather than the server's.
  const connection = ctx.redis.duplicate();
  connection.on("error", () => undefined); // retried by ioredis; the server's own connection reports it
  const queue = new Queue(name, { connection: ctx.redis });
  const worker = new Worker(name, (job) => handle(job.data as T), {
    connection,
    concurrency: options.concurrency ?? 2,
  });
  queue.on("error", (err) => ctx.log(err, `${name}: queue`));
  worker.on("error", (err) => ctx.log(err, `${name}: worker`));
  worker.on("failed", (_job, err) => ctx.log(err, `${name}: a job crashed`));

  app.addHook("onClose", async () => {
    // Closing waits for Redis to answer; when Redis is what went away, shutdown must not wait with it.
    const closed = Promise.allSettled([worker.close(true), queue.close()]);
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
    void worker.disconnect().catch(() => undefined);
    connection.disconnect();
  });

  const opts = { removeOnComplete: true, removeOnFail: 100 };
  return {
    async schedule(id, repeat, job) {
      await queue.upsertJobScheduler(
        id,
        "pattern" in repeat
          ? { pattern: repeat.pattern, tz: repeat.tz }
          : // Left to itself an interval fires at once; the first firing belongs one interval from now.
            { every: repeat.everyMs, startDate: new Date(Date.now() + repeat.everyMs) },
        { name, data: job as object, opts },
      );
    },
    unschedule: async (id) => void (await queue.removeJobScheduler(id)),
    nextRun: async (id) => (await queue.getJobScheduler(id))?.next ?? null,
    async add(jobs, { delayMs } = {}) {
      await queue.addBulk(
        jobs.map((data) => ({
          name,
          data,
          opts: { ...opts, ...(delayMs ? { delay: delayMs } : {}) },
        })),
      );
    },
  };
}
