import { hash } from "@node-rs/argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestServer, startTestServer } from "./harness.ts";

const account = (name: string) => ({ email: `${name}@example.com`, password: "correct horse battery", name });

describe("accounts", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
  });
  afterAll(() => t?.stop());

  it("registers a user into an organization they own, and signs them in", async () => {
    const res = await t.call("POST", "/v1/auth/register", {
      body: { ...account("alice"), email: "Alice@Example.com" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 900,
      user: { email: "alice@example.com", name: "alice" },
    });
    // The response is shaped by the contract: nothing but what it declares leaves the server.
    expect(Object.keys(res.body).sort()).toEqual([
      "access_token",
      "expires_in",
      "org_id",
      "refresh_token",
      "token_type",
      "user",
    ]);

    const me = await t.call("GET", "/v1/me", { token: res.body.access_token });
    expect(me.body).toEqual({
      user: { id: res.body.user.id, email: "alice@example.com", name: "alice" },
      orgs: [{ id: res.body.org_id, name: "alice's workspace", role: "owner" }],
      current_org_id: res.body.org_id,
      role: "owner",
    });
    const stored = await t.server.ctx.db
      .selectFrom("users")
      .select("password_hash")
      .where("email", "=", "alice@example.com")
      .executeTakeFirstOrThrow();
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);
  });

  it("refuses a duplicate email, whatever its letter case", async () => {
    const res = await t.call("POST", "/v1/auth/register", {
      body: { ...account("alice"), email: "ALICE@example.com" },
    });
    expect([res.status, res.body.code]).toEqual([409, "email_taken"]);
  });

  it("signs in with the right password and gives the same answer for a wrong password and an unknown account", async () => {
    const ok = await t.call("POST", "/v1/auth/login", {
      body: { email: "alice@example.com", password: "correct horse battery" },
    });
    expect(ok.status).toBe(200);
    const wrong = await t.call("POST", "/v1/auth/login", { body: { email: "alice@example.com", password: "nope" } });
    const unknown = await t.call("POST", "/v1/auth/login", { body: { email: "nobody@example.com", password: "nope" } });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body).toEqual(unknown.body);
    // The client reads the message from `detail`.
    expect(wrong.body.detail).toBe("incorrect email or password");
  });

  it("rotates refresh tokens: a replayed one is dead, and logout kills the current one", async () => {
    const { body: session } = await t.call("POST", "/v1/auth/login", {
      body: { email: "alice@example.com", password: "correct horse battery" },
    });
    const first = await t.call("POST", "/v1/auth/refresh", { body: { refresh_token: session.refresh_token } });
    expect(first.status).toBe(200);
    expect((await t.call("POST", "/v1/auth/refresh", { body: { refresh_token: session.refresh_token } })).status).toBe(
      401,
    );
    expect((await t.call("GET", "/v1/me", { token: first.body.access_token })).status).toBe(200);
    // A refresh token is not an access token.
    expect((await t.call("GET", "/v1/me", { token: first.body.refresh_token })).status).toBe(401);

    expect(
      (await t.call("POST", "/v1/auth/logout", { body: { refresh_token: first.body.refresh_token } })).status,
    ).toBe(204);
    expect(
      (await t.call("POST", "/v1/auth/refresh", { body: { refresh_token: first.body.refresh_token } })).status,
    ).toBe(401);
  });

  it("keeps organizations apart: another org's id in X-Org-Id is refused", async () => {
    const alice = (
      await t.call("POST", "/v1/auth/login", {
        body: { email: "alice@example.com", password: "correct horse battery" },
      })
    ).body;
    const bob = (await t.call("POST", "/v1/auth/register", { body: account("bob") })).body;
    expect(bob.org_id).not.toBe(alice.org_id);
    const foreign = await t.call("GET", "/v1/me", { token: bob.access_token, headers: { "x-org-id": alice.org_id } });
    expect([foreign.status, foreign.body.code]).toEqual([403, "forbidden"]);
    expect(
      (await t.call("GET", "/v1/me", { token: bob.access_token, headers: { "x-org-id": "not-a-uuid" } })).status,
    ).toBe(403);
    expect(
      (await t.call("GET", "/v1/me", { token: bob.access_token, headers: { "x-org-id": bob.org_id } })).body
        .current_org_id,
    ).toBe(bob.org_id);
  });

  it("throttles sign-in attempts per client, and nothing else", async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await t.call("POST", "/v1/auth/login", { body: { email: "alice@example.com", password: "guess" } });
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    const blocked = await t.call("POST", "/v1/auth/login", {
      body: { email: "alice@example.com", password: "correct horse battery" },
    });
    expect(blocked.body).toMatchObject({ code: "too_many_requests" });
    expect((await t.call("GET", "/health")).status).toBe(200);
  });
});

describe("accounts with signup disabled", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer({ ALLOW_SIGNUP: "0" });
  });
  afterAll(() => t?.stop());

  it("does not create accounts", async () => {
    const res = await t.call("POST", "/v1/auth/register", { body: account("mallory") });
    expect([res.status, res.body.code]).toEqual([403, "signup_disabled"]);
    expect(await t.server.ctx.db.selectFrom("users").select("id").execute()).toEqual([]);
  });

  it("locks an account for a while after ten wrong passwords, then lets the right one in again", async () => {
    // Signup is off on this server, so the account is put in place directly.
    const db = t.server.ctx.db;
    const user = { id: crypto.randomUUID(), email: "locked@example.com", name: "locked" };
    await db
      .insertInto("users")
      .values({ ...user, password_hash: await hash("correct horse battery") })
      .execute();
    await db.insertInto("orgs").values({ id: user.id, name: "Locked", created_by: user.id }).execute();
    await db.insertInto("org_members").values({ org_id: user.id, user_id: user.id, role: "owner" }).execute();
    const attempt = (password: string) =>
      t.call("POST", "/v1/auth/login", { body: { email: "locked@example.com", password } });
    for (let i = 0; i < 10; i++) expect((await attempt("nope")).status).toBe(401);
    const locked = await attempt("correct horse battery");
    expect([locked.status, locked.body.code]).toEqual([429, "too_many_attempts"]);
    await t.server.ctx.redis.del("login-fail:locked@example.com"); // the lock expiring
    expect((await attempt("correct horse battery")).status).toBe(200);
  });
});
