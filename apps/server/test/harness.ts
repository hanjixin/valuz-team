import { migrateToLatest } from "@agent-base/db";
import { type StartedPostgres, type StartedRedis, startPostgres, startRedis } from "@agent-base/test-utils";
import { type Server, buildServer } from "../src/app.ts";
import { loadConfig } from "../src/infra/config.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface TestServer {
  server: Server;
  redis: StartedRedis;
  /** Call an operation the way a client would. `token` adds the bearer header. */
  call(
    method: string,
    url: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; body: Json }>;
  stop(): Promise<void>;
}

/** A real server over real PostgreSQL and Redis, migrated and ready. */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const [pg, redis]: [StartedPostgres, StartedRedis] = await Promise.all([startPostgres(), startRedis()]);
  const server = await buildServer(
    loadConfig({
      DATABASE_URL: pg.url,
      REDIS_URL: redis.url,
      APP_SECRET: "test-secret-test-secret-test-secret-0123",
      LOG_LEVEL: "silent",
      ...env,
    }),
  );
  await migrateToLatest(server.ctx.db);
  await server.app.ready();
  return {
    server,
    redis,
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
      await Promise.all([pg.stop(), redis.stop().catch(() => undefined)]);
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
