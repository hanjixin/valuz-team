import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@agent-base/db";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { FastifySSEPlugin } from "fastify-sse-v2";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { Config } from "./infra/config.ts";
import { registerContract } from "./infra/contract.ts";
import type { Ctx, Handler } from "./infra/context.ts";
import { DeviceHub } from "./infra/device-hub.ts";
import { HttpError, errorBody } from "./infra/errors.ts";
import { PubSub } from "./infra/pubsub.ts";
import { SecretBox } from "./infra/secret-box.ts";
import { createStorage } from "./infra/storage.ts";
import * as handlers from "./modules/index.ts";
import { setupModules } from "./modules/setup.ts";

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

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Long-lived streams must not hold a shutdown (deploys, restarts) hostage.
    forceCloseConnections: true,
    // The contract uses OpenAPI annotations (`example`, `int64`…) that are not JSON Schema keywords.
    ajv: { customOptions: { strict: false } },
    // Remote file writes carry the file in the request body.
    bodyLimit: 16 * 1024 * 1024,
    // A file token travels as a path segment and is longer than the router's default allowance.
    maxParamLength: 2048,
  });
  const pubsub = new PubSub(redis, (err) => app.log.error({ err }, "redis subscriber"));
  const log = (err: unknown, message: string): void => app.log.error({ err }, message);
  const hub = new DeviceHub(redis, pubsub, crypto.randomUUID(), log);
  const ctx: Ctx = {
    config,
    db,
    redis,
    pubsub,
    hub,
    box: new SecretBox(config.APP_SECRET),
    storage: createStorage(config),
    log,
    startedAt: Date.now(),
  };
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

  // One file at a time is held in memory on its way to storage or a device; the limit keeps that small.
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 20 },
    // A file uploaded into a project names where it goes ("docs/notes.md"); handlers check the path.
    preservePath: true,
  });
  await app.register(websocket);
  await app.register(FastifySSEPlugin);
  await registerContract(app, handlers as Record<string, Handler>);
  setupModules(app);
  await hub.start();

  // Serve the web app from the same origin as the API when a build is present.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir =
    config.WEB_DIR ||
    [path.join(here, "web"), path.resolve(here, "../../webui/dist")].find((dir) =>
      existsSync(path.join(dir, "index.html")),
    );
  if (webDir) await app.register(fastifyStatic, { root: webDir });
  app.setNotFoundHandler((req, reply) => {
    // The web app routes in the browser: a deep link like /settings is the app, not a missing file.
    const page = req.method === "GET" && !/^\/(v1|health)(\/|$)/.test(req.url) && req.headers.accept?.includes("html");
    if (webDir && page) return reply.sendFile("index.html");
    return reply.code(404).send(errorBody("not_found", "route not found"));
  });

  return {
    app,
    ctx,
    async close() {
      await hub.stop();
      await app.close();
      pubsub.close();
      redis.disconnect();
      await db.destroy();
    },
  };
}
