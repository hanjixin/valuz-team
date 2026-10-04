import type { Schema } from "@agent-base/contract";
import { sql } from "kysely";
import { requireAuth } from "../../infra/auth.ts";
import type { Ctx, Handler } from "../../infra/context.ts";
import { SERVER_VERSION } from "../../infra/version.ts";

const CHECK_TIMEOUT_MS = 2000;

/** A dependency that does not answer in time is down — a health check must never hang with it. */
const answers = (probe: Promise<unknown>): Promise<boolean> =>
  Promise.race([
    probe.then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CHECK_TIMEOUT_MS).unref()),
  ]);

async function probe(ctx: Ctx): Promise<Schema<"HealthStatus">> {
  const [database, redis] = await Promise.all([answers(sql`SELECT 1`.execute(ctx.db)), answers(ctx.redis.ping())]);
  return { status: database && redis ? "ok" : "degraded", checks: { database, redis } };
}

/** Liveness of the server's dependencies — what load balancers and `docker compose` poll. */
export const healthCheck: Handler = async (req, reply) => {
  const result = await probe(req.server.ctx);
  return reply.code(result.status === "ok" ? 200 : 503).send(result);
};

/**
 * The status card the client shows in Settings. Several fields are local-machine
 * notions from the single-user build (database file, log directory); a server
 * has no meaningful value for them and reports them empty.
 */
export const getSystemStatus: Handler = async (req): Promise<Schema<"SystemStatusResponse">> => {
  const ctx = req.server.ctx;
  await requireAuth(ctx, req);
  const health = await probe(ctx);
  const warnings = Object.entries(health.checks).flatMap(([name, ok]) => (ok ? [] : [`${name} is not answering`]));
  return {
    status: warnings.length ? "degraded" : "running",
    pid: process.pid,
    started_at: ctx.startedAt,
    uptime_seconds: (Date.now() - ctx.startedAt) / 1000,
    version: SERVER_VERSION,
    kernel_pin: "",
    port: ctx.config.PORT,
    active_session_count: 0,
    db_path: "",
    log_path: "",
    log_dir: "",
    data_dir: "",
    runtimes_available: [],
    warnings,
  };
};
