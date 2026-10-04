/**
 * Work that happens off the request path. Jobs wait in Redis (BullMQ), so any
 * replica may do what another accepted, a restart loses nothing, and a job can
 * be asked to start later.
 */
import { Queue, Worker } from "bullmq";
import type { FastifyInstance } from "fastify";

export interface JobQueue<T> {
  add(jobs: T[], options?: { delayMs?: number }): Promise<void>;
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

  return {
    async add(jobs, { delayMs } = {}) {
      await queue.addBulk(
        jobs.map((data) => ({
          name,
          data,
          opts: { removeOnComplete: true, removeOnFail: 100, ...(delayMs ? { delay: delayMs } : {}) },
        })),
      );
    },
  };
}
