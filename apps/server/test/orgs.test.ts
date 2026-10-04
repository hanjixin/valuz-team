import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

describe("organizations", () => {
  let t: TestServer;
  let owner: Account;
  let admin: Account;
  let member: Account;
  beforeAll(async () => {
    t = await startTestServer();
    owner = await signUp(t, "owner");
    admin = await joinOrg(t, owner, "admin", "admin");
    member = await joinOrg(t, owner, "member");
  });
  afterAll(() => t?.stop());

  const roles = async () =>
    Object.fromEntries(
      (await t.call("GET", "/v1/org/members", { token: owner.token })).body.members.map(
        (m: { name: string; role: string }) => [m.name, m.role],
      ),
    );

  it("an invited person joins the inviting organization with the invited role, instead of getting their own", async () => {
    expect([admin.orgId, member.orgId]).toEqual([owner.orgId, owner.orgId]);
    expect(await roles()).toEqual({ owner: "owner", admin: "admin", member: "member" });
    const me = await t.call("GET", "/v1/me", { token: member.token });
    expect(me.body.orgs).toEqual([{ id: owner.orgId, name: "owner's workspace", role: "member" }]);
  });

  it("shows the invite token once, stores only its hash, and never lets it be used twice", async () => {
    const created = await t.call("POST", "/v1/org/invites", {
      token: owner.token,
      body: { email: "Once@Example.com" },
    });
    expect(created.body).toMatchObject({ email: "once@example.com", role: "member" });
    expect(created.body.token).toMatch(/^inv_/);
    const listed = await t.call("GET", "/v1/org/invites", { token: owner.token });
    expect(listed.body.invites.map((i: { email: string }) => i.email)).toEqual(["once@example.com"]);
    expect(JSON.stringify(listed.body)).not.toContain("inv_");
    const stored = await t.server.ctx.db.selectFrom("org_invites").select("token_hash").execute();
    expect(stored.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash))).toBe(true);

    await signUp(t, "once", created.body.token);
    const again = await t.call("POST", "/v1/auth/register", {
      body: {
        email: "once2@example.com",
        password: "correct horse battery",
        name: "x",
        invite_token: created.body.token,
      },
    });
    expect([again.status, again.body.code]).toEqual([400, "invalid_invite"]);
    // The refused registration left nothing behind.
    const leftover = await t.server.ctx.db.selectFrom("users").select("id").where("email", "=", "once2@example.com");
    expect(await leftover.execute()).toEqual([]);
    expect((await t.call("GET", "/v1/org/invites", { token: owner.token })).body.invites).toEqual([]);
  });

  it("an invite only works for the address it was sent to", async () => {
    const invite = await t.call("POST", "/v1/org/invites", {
      token: owner.token,
      body: { email: "wanted@example.com" },
    });
    const thief = await t.call("POST", "/v1/auth/register", {
      body: {
        email: "thief@example.com",
        password: "correct horse battery",
        name: "t",
        invite_token: invite.body.token,
      },
    });
    expect([thief.status, thief.body.code]).toEqual([403, "invite_email_mismatch"]);
    // Revoked invites stop working.
    expect((await t.call("DELETE", `/v1/org/invites/${invite.body.id}`, { token: owner.token })).status).toBe(204);
    const late = await t.call("POST", "/v1/auth/register", {
      body: {
        email: "wanted@example.com",
        password: "correct horse battery",
        name: "w",
        invite_token: invite.body.token,
      },
    });
    expect(late.body.code).toBe("invalid_invite");
    const dup = await t.call("POST", "/v1/org/invites", { token: owner.token, body: { email: "member@example.com" } });
    expect([dup.status, dup.body.code]).toEqual([409, "already_member"]);
  });

  it("someone with an account joins a second organization and acts in it with X-Org-Id", async () => {
    const other = await signUp(t, "other");
    const invite = await t.call("POST", "/v1/org/invites", { token: other.token, body: { email: member.email } });
    const accepted = await t.call("POST", "/v1/invites/accept", {
      token: member.token,
      body: { token: invite.body.token },
    });
    expect(accepted.body).toEqual({ org_id: other.orgId });
    const inOther = await t.call("GET", "/v1/org", { token: member.token, headers: { "x-org-id": other.orgId } });
    expect(inOther.body).toEqual({ id: other.orgId, name: "other's workspace", role: "member" });
    // Default stays the first organization joined; an organization they are not in is refused.
    expect((await t.call("GET", "/v1/org", { token: member.token })).body.id).toBe(owner.orgId);
    const outsider = await t.call("GET", "/v1/org", { token: owner.token, headers: { "x-org-id": other.orgId } });
    expect(outsider.status).toBe(403);
  });

  it("keeps management to owners and admins, and owner roles to owners", async () => {
    const asMember = { token: member.token };
    expect((await t.call("POST", "/v1/org/invites", { ...asMember, body: { email: "x@example.com" } })).status).toBe(
      403,
    );
    expect((await t.call("PATCH", "/v1/org", { ...asMember, body: { name: "mine" } })).status).toBe(403);
    expect((await t.call("GET", "/v1/org/audit-logs", asMember)).status).toBe(403);
    expect((await t.call("DELETE", `/v1/org/members/${admin.userId}`, asMember)).status).toBe(403);

    const promote = (token: string, userId: string, role: string) =>
      t.call("PATCH", `/v1/org/members/${userId}`, { token, body: { role } });
    expect((await promote(admin.token, member.userId, "owner")).status).toBe(403);
    expect((await promote(admin.token, owner.userId, "member")).status).toBe(403);
    expect((await t.call("DELETE", `/v1/org/members/${owner.userId}`, { token: admin.token })).status).toBe(403);
    expect((await promote(admin.token, member.userId, "admin")).body).toMatchObject({ name: "member", role: "admin" });
    expect((await promote(owner.token, member.userId, "member")).status).toBe(200);
    expect((await t.call("PATCH", "/v1/org", { token: admin.token, body: { name: "Acme" } })).body).toEqual({
      id: owner.orgId,
      name: "Acme",
      role: "admin",
    });
  });

  it("always keeps one owner, even when two owners step down at the same moment", async () => {
    const demoteSelf = await t.call("PATCH", `/v1/org/members/${owner.userId}`, {
      token: owner.token,
      body: { role: "member" },
    });
    expect([demoteSelf.status, demoteSelf.body.code]).toEqual([409, "last_owner"]);
    const leave = await t.call("DELETE", `/v1/org/members/${owner.userId}`, { token: owner.token });
    expect(leave.body.code).toBe("last_owner");

    await t.call("PATCH", `/v1/org/members/${admin.userId}`, { token: owner.token, body: { role: "owner" } });
    const results = await Promise.all([
      t.call("PATCH", `/v1/org/members/${owner.userId}`, { token: owner.token, body: { role: "admin" } }),
      t.call("PATCH", `/v1/org/members/${admin.userId}`, { token: admin.token, body: { role: "admin" } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(Object.values(await roles()).filter((role) => role === "owner")).toHaveLength(1);
    // Put the roles back for the tests that follow.
    const db = t.server.ctx.db;
    await db.updateTable("org_members").set({ role: "owner" }).where("user_id", "=", owner.userId).execute();
    await db.updateTable("org_members").set({ role: "admin" }).where("user_id", "=", admin.userId).execute();
  });

  it("a member can leave; what was granted to them in the organization ends", async () => {
    const leaver = await joinOrg(t, owner, "leaver");
    const team = await t.call("POST", "/v1/org/teams", { token: owner.token, body: { name: "Leavers" } });
    await t.call("PUT", `/v1/org/teams/${team.body.id}/members`, {
      token: owner.token,
      body: { user_ids: [leaver.userId] },
    });
    await t.server.ctx.db
      .insertInto("resource_shares")
      .values({
        id: crypto.randomUUID(),
        org_id: owner.orgId,
        resource_type: "project",
        resource_id: crypto.randomUUID(),
        principal_type: "user",
        principal_id: leaver.userId,
        permission: "edit",
        rank: 3,
        created_by: owner.userId,
      })
      .execute();

    expect((await t.call("DELETE", `/v1/org/members/${leaver.userId}`, { token: leaver.token })).status).toBe(204);
    expect(await roles()).not.toHaveProperty("leaver");
    const teams = await t.call("GET", "/v1/org/teams", { token: owner.token });
    expect(teams.body.teams.find((x: { name: string }) => x.name === "Leavers").member_ids).toEqual([]);
    const shares = await t.server.ctx.db.selectFrom("resource_shares").select("id").execute();
    expect(shares).toEqual([]);
    // Their token still proves who they are, but they act in no organization now.
    const after = await t.call("GET", "/v1/org", { token: leaver.token });
    expect([after.status, after.body.code]).toEqual([403, "no_organization"]);
    // …and they can start a new one.
    const fresh = await t.call("POST", "/v1/orgs", { token: leaver.token, body: { name: "Fresh start" } });
    expect(fresh.status).toBe(201);
    expect(fresh.body).toMatchObject({ name: "Fresh start", role: "owner" });
  });

  it("records who did what in the audit trail, newest first, paged by id", async () => {
    const logs = await t.call("GET", "/v1/org/audit-logs?limit=200", { token: admin.token });
    const actions = logs.body.logs.map((l: { action: string }) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining(["user.register", "invite.create", "member.join", "member.role_change", "member.leave"]),
    );
    const ids = logs.body.logs.map((l: { id: number }) => l.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const change = logs.body.logs.find((l: { action: string }) => l.action === "member.role_change");
    expect(change).toMatchObject({
      resource_type: "user",
      detail: { from: expect.any(String), to: expect.any(String) },
    });
    expect(change.actor_name).toBeTruthy();

    const page = await t.call("GET", `/v1/org/audit-logs?limit=2&before=${ids[1]}`, { token: owner.token });
    expect(page.body.logs.map((l: { id: number }) => l.id)).toEqual(ids.slice(2, 4));
    // Another organization's trail never shows up here: "other" invited this member too.
    const invited = logs.body.logs.filter(
      (l: { action: string; detail: { email?: string } }) =>
        l.action === "invite.create" && l.detail.email === member.email,
    );
    expect(invited).toHaveLength(1);
  });
});
