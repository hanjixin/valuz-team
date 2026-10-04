import { createDb } from "@agent-base/db";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { Config } from "./infra/config.ts";
import type { Ctx } from "./infra/context.ts";
import { health } from "./modules/system/handlers.ts";

export interface Server {
  app: FastifyInstance;
  ctx: Ctx;
  close(): Promise<void>;
}

export async function buildServer(config: Config): Promise<Server> {
  const db = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  // A dropped connection is retried by ioredis; it must never take the process down.
  redis.on("error", (err: Error) => console.error(`[redis] ${err.message}`));
  const ctx: Ctx = { config, db, redis };

  // Long-lived streams must not hold a shutdown (deploys, restarts) hostage.
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, forceCloseConnections: true });

  app.get("/health", async (_req, reply) => {
    const result = await health(ctx);
    return reply.code(result.status === "ok" ? 200 : 503).send(result);
  });

  return {
    app,
    ctx,
    async close() {
      await app.close();
      redis.disconnect();
      await db.destroy();
    },
  };
}
