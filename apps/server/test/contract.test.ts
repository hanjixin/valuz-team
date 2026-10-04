import { readFileSync } from "node:fs";
import { CONTRACT_FILE } from "@agent-base/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/infra/config.ts";
import * as handlers from "../src/modules/index.ts";
import { type TestServer, signUp, startTestServer } from "./harness.ts";

describe("contract-driven server", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer({}, { ownRedis: true });
  });
  afterAll(() => t?.stop());

  it("binds every exported handler to an operation that exists in the contract", () => {
    const spec = parse(readFileSync(CONTRACT_FILE, "utf8")) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const operationIds = new Set(
      Object.values(spec.paths).flatMap((item) => Object.values(item).map((op) => op?.operationId)),
    );
    // A handler whose name matches no operationId would silently never be routed.
    expect(Object.keys(handlers).filter((name) => !operationIds.has(name))).toEqual([]);
  });

  it("answers 501, in the contract's error shape, for an operation not implemented yet", async () => {
    const { token } = await signUp(t, "contract");
    const res = await t.call("GET", "/v1/playbooks", { token });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({
      code: "not_implemented",
      message: "listPlaybooks is not implemented yet",
      detail: "listPlaybooks is not implemented yet",
    });
  });

  it("routes the contract's custom verbs (`{id}:verb`) as distinct operations", async () => {
    const { token } = await signUp(t, "verbs");
    const id = "3f2b6c1e-0000-4000-8000-000000000001";
    // Each verb is its own operation, with its own request schema…
    const refusal = async (verb: string) => (await t.call("POST", `/v1/tasks/${id}:${verb}`, { token, body: {} })).body;
    expect((await refusal("commit")).message).toMatch(/caller_session_id/);
    expect((await refusal("inject")).message).toMatch(/text/);
    expect((await refusal("intervene")).message).toMatch(/action/);
    // …and reaches its own handler, which here finds no such task.
    const commit = await t.call("POST", `/v1/tasks/${id}:commit`, { token, body: { caller_session_id: "s1" } });
    expect([commit.status, commit.body.message]).toEqual([404, "task not found"]);
    // The plain resource and a static segment with a verb are separate routes too.
    expect((await t.call("GET", `/v1/tasks/${id}`, { token })).body.message).toBe("task not found");
    expect((await t.call("POST", "/v1/notifications:read-all", { token })).body).toEqual({ ok: true });
    const unknown = await t.call("POST", `/v1/tasks/${id}:nope`, { token });
    expect([unknown.status, unknown.body.message]).toEqual([404, "route not found"]);
  });

  it("requires a valid access token on every operation the contract does not mark public", async () => {
    expect((await t.call("GET", "/v1/playbooks")).status).toBe(401);
    expect((await t.call("GET", "/v1/me", { token: "not-a-token" })).body).toMatchObject({ code: "unauthorized" });
    expect((await t.call("GET", "/health")).status).toBe(200); // public
    expect((await t.call("GET", "/v1/nope")).body).toMatchObject({ code: "not_found" });
  });

  it("validates requests against the contract", async () => {
    const res = await t.call("POST", "/v1/auth/login", { body: { email: "not-an-email" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("validation_error");
    expect(res.body.message).toMatch(/password/);
    // A field the contract does not declare is dropped before the handler sees it — never an error, never trusted.
    const extra = await t.call("POST", "/v1/auth/login", { body: { email: "a@b.co", password: "x", admin: true } });
    expect([extra.status, extra.body.code]).toEqual([401, "unauthorized"]);
  });

  it("reports health and names the dependency that is down", async () => {
    expect((await t.call("GET", "/health")).body).toEqual({ status: "ok", checks: { database: true, redis: true } });
    const { token } = await signUp(t, "status");
    const status = await t.call("GET", "/v1/system/status", { token });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ status: "running", version: "0.1.0", warnings: [], runtimes_available: [] });
    expect(status.body.uptime_seconds).toBeGreaterThanOrEqual(0);

    await t.redis?.stop();
    const down = await t.call("GET", "/health");
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ status: "degraded", checks: { database: true, redis: false } });
  });

  it("refuses to start on missing configuration, naming what is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*REDIS_URL.*APP_SECRET/s);
    expect(() => loadConfig({ DATABASE_URL: "x", REDIS_URL: "y", APP_SECRET: "short" })).toThrow(
      /at least 32 characters/,
    );
  });
});
