import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

describe("teams", () => {
  let t: TestServer;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  beforeAll(async () => {
    t = await startTestServer();
    owner = await signUp(t, "owner");
    member = await joinOrg(t, owner, "member");
    outsider = await signUp(t, "outsider");
  });
  afterAll(() => t?.stop());

  it("admins create, rename and fill teams; members can only see them", async () => {
    const created = await t.call("POST", "/v1/org/teams", { token: owner.token, body: { name: "Research" } });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: created.body.id, name: "Research", member_ids: [] });
    const id = created.body.id;

    const dup = await t.call("POST", "/v1/org/teams", { token: owner.token, body: { name: "Research" } });
    expect([dup.status, dup.body.code]).toEqual([409, "team_name_taken"]);

    const filled = await t.call("PUT", `/v1/org/teams/${id}/members`, {
      token: owner.token,
      body: { user_ids: [member.userId, owner.userId, member.userId] },
    });
    expect(filled.body.member_ids).toEqual([member.userId, owner.userId].sort());
    const renamed = await t.call("PATCH", `/v1/org/teams/${id}`, { token: owner.token, body: { name: "Analysts" } });
    expect(renamed.body).toEqual({ id, name: "Analysts", member_ids: [member.userId, owner.userId].sort() });

    expect((await t.call("GET", "/v1/org/teams", { token: member.token })).body.teams).toEqual([renamed.body]);
    expect((await t.call("POST", "/v1/org/teams", { token: member.token, body: { name: "Mine" } })).status).toBe(403);
    expect((await t.call("DELETE", `/v1/org/teams/${id}`, { token: member.token })).status).toBe(403);
  });

  it("a team only holds members of its own organization, and is invisible to other organizations", async () => {
    const { teams } = (await t.call("GET", "/v1/org/teams", { token: owner.token })).body;
    const id = teams[0].id;
    const res = await t.call("PUT", `/v1/org/teams/${id}/members`, {
      token: owner.token,
      body: { user_ids: [outsider.userId] },
    });
    expect([res.status, res.body.message]).toEqual([400, "every team member must belong to the organization"]);
    // The refused change left the membership as it was.
    expect((await t.call("GET", "/v1/org/teams", { token: owner.token })).body.teams[0].member_ids).toHaveLength(2);

    expect((await t.call("GET", "/v1/org/teams", { token: outsider.token })).body.teams).toEqual([]);
    expect((await t.call("PATCH", `/v1/org/teams/${id}`, { token: outsider.token, body: { name: "x" } })).status).toBe(
      404,
    );
    expect((await t.call("DELETE", `/v1/org/teams/${id}`, { token: outsider.token })).status).toBe(404);
    expect((await t.call("DELETE", `/v1/org/teams/${id}`, { token: owner.token })).status).toBe(204);
    expect((await t.call("GET", "/v1/org/teams", { token: owner.token })).body.teams).toEqual([]);
  });
});
