import { sql } from "kysely";
import type { Ctx } from "../../infra/context.ts";

export interface Health {
  status: "ok" | "degraded";
  checks: { database: boolean; redis: boolean };
}

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

/** Liveness of the server's dependencies — what load balancers and `docker compose` poll. */
export async function health(ctx: Ctx): Promise<Health> {
  const [database, redis] = await Promise.all([answers(sql`SELECT 1`.execute(ctx.db)), answers(ctx.redis.ping())]);
  return { status: database && redis ? "ok" : "degraded", checks: { database, redis } };
}
