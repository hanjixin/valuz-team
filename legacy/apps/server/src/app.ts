import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { AutomationService } from "./automations.ts";
import { ChannelService } from "./channels.ts";
import type { Config } from "./config.ts";
import type { Ctx } from "./context.ts";
import { SecretBox } from "./crypto.ts";
import { Db } from "./db.ts";
import { drainQueue } from "./dispatch.ts";
import { DocumentService } from "./documents.ts";
import { DeviceHub } from "./device-hub.ts";
import { HttpError } from "./http.ts";
import { projectToolRoutes } from "./project-tools.ts";
import { PubSub } from "./pubsub.ts";
import { authRoutes } from "./routes/auth.ts";
import { automationRoutes } from "./routes/automations.ts";
import { channelRoutes } from "./routes/channels.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { documentRoutes, notify } from "./routes/documents.ts";
import { libraryRoutes } from "./routes/library.ts";
import { orgRoutes } from "./routes/orgs.ts";
import { projectRoutes } from "./routes/projects.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { storageRoutes } from "./routes/storage.ts";
import { StorageService } from "./storage.ts";
import { taskMcpRoutes } from "./tasks/mcp.ts";
import { TaskService } from "./tasks/service.ts";
import { taskRoutes } from "./routes/tasks.ts";

export interface Server {
  app: FastifyInstance;
  ctx: Ctx;
  close(): Promise<void>;
}

export async function buildServer(config: Config): Promise<Server> {
  const db = new Db(config.DATABASE_URL);
  const pubsub = new PubSub(config.REDIS_URL);
  const box = new SecretBox(config.APP_SECRET);
  const instanceId = crypto.randomUUID();
  const hub = new DeviceHub(db, pubsub, instanceId);
  const ctx = { config, db, pubsub, box, hub, storage: new StorageService(db, box, config), instanceId } as Ctx;
  ctx.tasks = new TaskService(ctx);
  ctx.automations = new AutomationService(ctx);
  ctx.documents = new DocumentService(ctx);
  ctx.channels = new ChannelService(ctx);
  // A failed notification must never fail the work that triggered it.
  ctx.notify = (userId, orgId, notice) => notify(ctx, userId, orgId, notice).catch((err: unknown) => console.error("[notify]", err));
  hub.onTurnEnd = async (message) => {
    await Promise.all([ctx.tasks.onTurnEnd(message), ctx.automations.onTurnEnd(message), ctx.channels.onTurnEnd(message)]);
    // A finished turn sends the next queued message. After an error or an
    // interrupt the queue waits: the person decides whether to go on.
    if (message.status === "completed") await drainQueue(ctx, message.session_id);
  };

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 16 * 1024 * 1024,
    // Open SSE streams must not hold a shutdown (deploys, restarts) hostage.
    forceCloseConnections: true,
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS === "*" ? true : config.CORS_ORIGINS.split(",").map((o) => o.trim()),
    allowedHeaders: ["authorization", "content-type", "x-org-id", "last-event-id"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });
  await app.register(websocket, { options: { maxPayload: 32 * 1024 * 1024 } });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? "bad_request", message: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal_error", message: "something went wrong on the server" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "route not found" } }));

  app.get("/health", async (_req, reply) => {
    try {
      await Promise.all([db.query("SELECT 1"), pubsub.redis.ping()]);
      return { status: "ok" };
    } catch (err) {
      return reply.code(503).send({ status: "degraded", error: (err as Error).message });
    }
  });

  authRoutes(app, ctx);
  orgRoutes(app, ctx);
  libraryRoutes(app, ctx);
  projectRoutes(app, ctx);
  deviceRoutes(app, ctx);
  sessionRoutes(app, ctx);
  storageRoutes(app, ctx);
  taskRoutes(app, ctx);
  automationRoutes(app, ctx);
  documentRoutes(app, ctx);
  channelRoutes(app, ctx);
  projectToolRoutes(app, ctx);
  taskMcpRoutes(app, ctx);

  // Serve the web app from the same origin as the API when a build is present.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = config.WEB_DIR || path.resolve(here, "../../web/dist");
  if (existsSync(path.join(webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: webDir });
  }

  await hub.start();
  ctx.automations.start();
  ctx.documents.start();
  await ctx.channels.start();
  return {
    app,
    ctx,
    async close() {
      await ctx.automations.stop();
      await ctx.documents.stop();
      await ctx.channels.stop();
      await hub.stop();
      await app.close();
      await pubsub.close();
      await db.close();
    },
  };
}
