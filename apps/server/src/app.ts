import { createDb } from "@agent-base/db";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { Config } from "./infra/config.ts";
import { registerContract } from "./infra/contract.ts";
import type { Ctx, Handler } from "./infra/context.ts";
import { HttpError, errorBody } from "./infra/errors.ts";
import * as handlers from "./modules/index.ts";

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
  const ctx: Ctx = { config, db, redis, startedAt: Date.now() };

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Long-lived streams must not hold a shutdown (deploys, restarts) hostage.
    forceCloseConnections: true,
    // The contract uses OpenAPI annotations (`example`, `int64`…) that are not JSON Schema keywords.
    ajv: { customOptions: { strict: false } },
  });
  app.decorate("ctx", ctx);

  await app.register(cors, {
    origin: true,
    allowedHeaders: ["authorization", "content-type", "x-org-id", "last-event-id"],
  });
  await app.register(jwt, { secret: config.APP_SECRET });
  // Password guessing and token grinding are throttled per client address; nothing else is.
  await app.register(rateLimit, {
    redis,
    max: 30,
    timeWindow: "1 minute",
    allowList: (req) => !req.url.startsWith("/v1/auth/"),
    errorResponseBuilder: () => new HttpError(429, "too_many_requests", "too many attempts; try again in a minute"),
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send(errorBody(err.code, err.message));
    if (err.validation) return reply.code(400).send(errorBody("validation_error", err.message));
    if (err.statusCode && err.statusCode < 500) {
      return reply
        .code(err.statusCode)
        .send(errorBody(err.statusCode === 401 ? "unauthorized" : "bad_request", err.message));
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send(errorBody("internal_error", "something went wrong on the server"));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody("not_found", "route not found")));

  await registerContract(app, handlers as Record<string, Handler>);

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
