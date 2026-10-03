import { migrateToLatest } from "@agent-base/db";
import { type StartedPostgres, type StartedRedis, startPostgres, startRedis } from "@agent-base/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Server, buildServer } from "../src/app.ts";
import { loadConfig } from "../src/infra/config.ts";

describe("server", () => {
  let pg: StartedPostgres;
  let redis: StartedRedis;
  let server: Server;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
    server = await buildServer(loadConfig({ DATABASE_URL: pg.url, REDIS_URL: redis.url, LOG_LEVEL: "silent" }));
    await migrateToLatest(server.ctx.db);
  });
  afterAll(async () => {
    await server?.close();
    await Promise.all([pg?.stop(), redis?.stop()]);
  });

  it("reports healthy when PostgreSQL and Redis answer", async () => {
    const res = await server.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: true, redis: true } });
  });

  it("reports degraded, with the failing dependency named, when Redis is gone", async () => {
    await redis.stop();
    const res = await server.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "degraded", checks: { database: true, redis: false } });
  });

  it("refuses to start on missing configuration, naming what is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*REDIS_URL/s);
  });
});
