import { migrateToLatest } from "@agent-base/db";
import { type StartedRedis, startRedis } from "@agent-base/test-utils";
import { tmpdir } from "node:os";
import path from "node:path";
import { Redis } from "ioredis";
import pg from "pg";
import { inject } from "vitest";
import { type Server, buildServer } from "../src/app.ts";
import { loadConfig } from "../src/infra/config.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface TestServer {
  server: Server;
  /** Only with `ownRedis`: a Redis container this server alone uses, so a test can take it down. */
  redis?: StartedRedis;
  /** The environment this server was configured with — start a second replica on the same stores with it. */
  env: Record<string, string>;
  /** Accept real connections (needed for WebSockets) and return the base URL. */
  listen(): Promise<string>;
  /** Call an operation the way a client would. `token` adds the bearer header. */
  call(
    method: string,
    url: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; body: Json }>;
  stop(): Promise<void>;
}

/** A database of this file's own in the shared PostgreSQL. */
async function freshDatabase(): Promise<string> {
  const admin = new URL(inject("pgUrl"));
  const name = `t_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  admin.pathname = `/${name}`;
  return admin.toString();
}

/**
 * A Redis keyspace of this file's own in the shared Redis: the next logical
 * database, emptied. Fifteen rotate, far more than ever run at once.
 */
async function freshKeyspace(): Promise<string> {
  const shared = new URL(inject("redisUrl"));
  const client = new Redis(shared.toString());
  try {
    const index = ((await client.incr("test:keyspace")) % 15) + 1;
    await client.select(index);
    await client.flushdb();
    shared.pathname = `/${index}`;
    return shared.toString();
  } finally {
    client.disconnect();
  }
}

/**
 * A real server over real PostgreSQL and Redis, migrated and ready.
 * `ownRedis` gives it a Redis container to itself, for tests that stop Redis.
 */
export async function startTestServer(
  env: Record<string, string> = {},
  options: { ownRedis?: boolean } = {},
): Promise<TestServer> {
  const redis = options.ownRedis ? await startRedis() : undefined;
  const [databaseUrl, redisUrl] = await Promise.all([freshDatabase(), redis?.url ?? freshKeyspace()]);
  const fullEnv = {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    APP_SECRET: "test-secret-test-secret-test-secret-0123",
    LOG_LEVEL: "silent",
    // Uploads are staged outside the repository.
    STORAGE_DIR: path.join(tmpdir(), `ab-storage-${crypto.randomUUID()}`),
    ...env,
  };
  const server = await buildServer(loadConfig(fullEnv));
  await migrateToLatest(server.ctx.db);
  await server.app.ready();
  return {
    server,
    ...(redis ? { redis } : {}),
    env: fullEnv,
    listen: () => server.app.listen({ port: 0, host: "127.0.0.1" }),
    async call(method, url, options = {}) {
      const res = await server.app.inject({
        method: method as "GET",
        url,
        headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
        ...(options.body !== undefined ? { payload: options.body as object } : {}),
      });
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    },
    async stop() {
      await server.close();
      await redis?.stop().catch(() => undefined);
    },
  };
}

export interface Account {
  token: string;
  refresh: string;
  orgId: string;
  userId: string;
  email: string;
}

/** Register `<name>@example.com`. With an invite token the account joins the inviting organization. */
export async function signUp(t: TestServer, name: string, inviteToken?: string): Promise<Account> {
  const email = `${name}@example.com`;
  const res = await t.call("POST", "/v1/auth/register", {
    body: { email, password: "correct horse battery", name, ...(inviteToken ? { invite_token: inviteToken } : {}) },
  });
  if (res.status !== 201) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    token: res.body.access_token,
    refresh: res.body.refresh_token,
    orgId: res.body.org_id,
    userId: res.body.user.id,
    email,
  };
}

/** Invite `<name>@example.com` into the owner's organization and register them with the invite. */
export async function joinOrg(
  t: TestServer,
  owner: Account,
  name: string,
  role: "admin" | "member" = "member",
): Promise<Account> {
  const invite = await t.call("POST", "/v1/org/invites", {
    token: owner.token,
    body: { email: `${name}@example.com`, role },
  });
  if (invite.status !== 201) throw new Error(`invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
  return signUp(t, name, invite.body.token);
}

/** Poll until `check` returns something truthy. */
export async function eventually<T>(
  check: () => Promise<T | false | null | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
