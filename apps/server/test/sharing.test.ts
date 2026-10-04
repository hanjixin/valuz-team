import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Auth } from "../src/infra/context.ts";
import { getPermission, permissionOf, registerShareable } from "../src/modules/sharing/service.ts";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

/**
 * The share ladder, exercised against a stand-in resource table: the modules
 * that own real shareable resources are ported after this one.
 */
describe("sharing", () => {
  let t: TestServer;
  let owner: Account; // org owner
  let alice: Account; // owns the resource
  let bob: Account;
  let carol: Account;
  let outsider: Account;
  const thing = crypto.randomUUID();
  const base = `/v1/shares/project/${thing}`;

  beforeAll(async () => {
    t = await startTestServer();
    owner = await signUp(t, "owner");
    alice = await joinOrg(t, owner, "alice");
    bob = await joinOrg(t, owner, "bob");
    carol = await joinOrg(t, owner, "carol");
    outsider = await signUp(t, "outsider");
    const db = t.server.ctx.db;
    await sql`CREATE TABLE things (id uuid PRIMARY KEY, org_id uuid NOT NULL, owner_id uuid NOT NULL)`.execute(db);
    await sql`INSERT INTO things VALUES (${thing}, ${owner.orgId}, ${alice.userId})`.execute(db);
    registerShareable("project", "things");
  });
  afterAll(() => t?.stop());

  const as = (account: Account, role: Auth["role"] = "member"): Auth => ({
    userId: account.userId,
    orgId: account.orgId,
    role,
    name: "",
  });
  const held = (account: Account, role?: Auth["role"]) =>
    getPermission(t.server.ctx.db, as(account, role), "project", thing);
  const share = (body: object, token = alice.token) => t.call("PUT", base, { token, body });

  it("gives the owner and organization admins `admin`, and everyone else nothing until it is shared", async () => {
    expect(await held(alice)).toBe("admin");
    expect(await held(owner, "owner")).toBe("admin");
    expect(await held(bob)).toBeNull();
    // Unshared, the resource does not exist as far as bob can tell.
    expect((await t.call("GET", base, { token: bob.token })).status).toBe(404);
    expect((await t.call("GET", base, { token: outsider.token })).status).toBe(404);
    expect((await t.call("GET", `/v1/shares/agent/${thing}`, { token: alice.token })).status).toBe(404);
  });

  it("takes the strongest of the shares that reach someone: organization, team, or themselves", async () => {
    expect((await share({ principal_type: "org", permission: "view" })).body).toMatchObject({
      principal_type: "org",
      principal_id: owner.orgId,
      permission: "view",
    });
    expect([await held(bob), await held(carol)]).toEqual(["view", "view"]);

    const team = await t.call("POST", "/v1/org/teams", { token: owner.token, body: { name: "Editors" } });
    await t.call("PUT", `/v1/org/teams/${team.body.id}/members`, {
      token: owner.token,
      body: { user_ids: [bob.userId] },
    });
    await share({ principal_type: "team", principal_id: team.body.id, permission: "edit" });
    expect([await held(bob), await held(carol)]).toEqual(["edit", "view"]);

    await share({ principal_type: "user", principal_id: carol.userId, permission: "control" });
    expect(await held(carol)).toBe("control");
    // A weaker personal share does not pull someone below what their team has.
    await share({ principal_type: "user", principal_id: bob.userId, permission: "use" });
    expect(await held(bob)).toBe("edit");

    // The same expression filters and labels a list.
    const visible = await sql<{ permission: string }>`
      SELECT ${permissionOf(as(bob), "project", "r")} AS permission FROM things r
       WHERE ${permissionOf(as(bob), "project", "r")} IS NOT NULL`.execute(t.server.ctx.db);
    expect(visible.rows).toEqual([{ permission: "edit" }]);
    expect(await held(outsider)).toBeNull();
  });

  it("only the owner or an organization admin manages shares; seeing a resource is not enough", async () => {
    const res = await share({ principal_type: "user", principal_id: bob.userId, permission: "control" }, bob.token);
    expect([res.status, res.body.message]).toEqual([403, 'this needs "admin" permission on the project']);
    expect((await t.call("GET", base, { token: carol.token })).status).toBe(403);

    const list = await t.call("GET", base, { token: owner.token });
    expect(
      list.body.shares.map((s: { principal_type: string; principal_name: string; permission: string }) => [
        s.principal_type,
        s.principal_name,
        s.permission,
      ]),
    ).toEqual([
      ["org", "owner's workspace", "view"],
      ["team", "Editors", "edit"],
      ["user", "carol", "control"],
      ["user", "bob", "use"],
    ]);
  });

  it("sharing again with the same principal replaces the permission; it never grants `admin`", async () => {
    await share({ principal_type: "user", principal_id: carol.userId, permission: "view" });
    const list = await t.call("GET", base, { token: alice.token });
    expect(list.body.shares.filter((s: { principal_name: string }) => s.principal_name === "carol")).toHaveLength(1);
    expect(await held(carol)).toBe("view");
    expect((await share({ principal_type: "user", principal_id: carol.userId, permission: "admin" })).status).toBe(400);
  });

  it("refuses principals from outside the organization", async () => {
    const user = await share({ principal_type: "user", principal_id: outsider.userId, permission: "view" });
    expect([user.status, user.body.message]).toEqual([400, "that user is not a member of this organization"]);
    const team = await share({ principal_type: "team", principal_id: crypto.randomUUID(), permission: "view" });
    expect(team.body.message).toBe("that team does not exist in this organization");
    expect((await share({ principal_type: "user", permission: "view" })).body.message).toBe("principal_id is required");
  });

  it("removing a share, or deleting the team it went to, takes the access away", async () => {
    const list = await t.call("GET", base, { token: alice.token });
    const find = (type: string, name?: string) =>
      list.body.shares.find(
        (s: { principal_type: string; principal_name: string }) =>
          s.principal_type === type && (!name || s.principal_name === name),
      );
    expect((await t.call("DELETE", `${base}/${find("org").id}`, { token: alice.token })).status).toBe(204);
    expect((await t.call("DELETE", `${base}/${find("org").id}`, { token: alice.token })).status).toBe(404);
    expect((await t.call("DELETE", `${base}/${find("user", "carol").id}`, { token: alice.token })).status).toBe(204);
    expect(await held(carol)).toBeNull();

    expect(await held(bob)).toBe("edit");
    expect((await t.call("DELETE", `/v1/org/teams/${find("team").principal_id}`, { token: owner.token })).status).toBe(
      204,
    );
    expect(await held(bob)).toBe("use"); // only the personal share is left
    const logs = await t.call("GET", "/v1/org/audit-logs?limit=200", { token: owner.token });
    const actions = logs.body.logs.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["share.grant", "share.revoke", "team.delete"]));
  });
});
