import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

describe("projects", () => {
  let t: TestServer;
  let alice: Account; // the organization's owner
  let bob: Account;
  let carol: Account;
  let projectId: string;

  const call = (account: Account, method: string, url: string, body?: object) =>
    t.call(method, url, { token: account.token, ...(body ? { body } : {}) });
  const team = async (account: Account) =>
    (await call(account, "GET", `/v1/projects/${projectId}/agents`)).body.agents.map(
      (m: { member: { agent_slug: string } }) => m.member.agent_slug,
    );

  beforeAll(async () => {
    t = await startTestServer();
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
    carol = await joinOrg(t, alice, "carol");
  });
  afterAll(() => t?.stop());

  it("creates a project in the shape the web app reads", async () => {
    const created = await call(bob, "POST", "/v1/projects", { name: "  Q3 Research " });
    expect(created.status).toBe(201);
    projectId = created.body.id;
    expect(created.body).toEqual({
      id: projectId,
      name: "Q3 Research",
      kind: "project",
      root_path: null,
      icon: null,
      cwd: null,
      device_id: null,
      permission: "admin",
      owner_id: bob.userId,
      instructions_md: "",
      default_lead_agent_slug: null,
    });
    expect((await call(bob, "GET", "/v1/projects")).body.projects).toHaveLength(1);
    expect((await call(bob, "GET", `/v1/projects/${projectId}/last-session-pick`)).body).toMatchObject({
      runtime_provider: null,
      provider_id: null,
      model_id: null,
    });
  });

  it("keeps a project's folder on a device: the one named, or the member's own when there is only one", async () => {
    const noDevice = await call(bob, "POST", "/v1/projects", { name: "Code", root_path: "/Users/bob/code" });
    expect([noDevice.status, noDevice.body.code]).toEqual([400, "device_required"]);
    const relative = await call(bob, "POST", "/v1/projects", { name: "Code", root_path: "code" });
    expect(relative.status).toBe(400);

    const laptop = (await call(bob, "POST", "/v1/devices", { name: "Bob's laptop" })).body;
    const implicit = await call(bob, "POST", "/v1/projects", { name: "Code", root_path: "/Users/bob/code" });
    expect(implicit.body).toMatchObject({ device_id: laptop.id, root_path: "/Users/bob/code", cwd: "/Users/bob/code" });
    expect((await call(bob, "POST", "/v1/projects", { name: "Win", root_path: "C:\\work" })).status).toBe(201);

    // Someone else's device needs `use` on it.
    const others = await call(carol, "POST", "/v1/projects", {
      name: "Sneaky",
      root_path: "/tmp",
      device_id: laptop.id,
    });
    expect(others.status).toBe(404);
    await call(bob, "PUT", `/v1/shares/device/${laptop.id}`, {
      principal_type: "user",
      principal_id: carol.userId,
      permission: "use",
    });
    const allowed = await call(carol, "POST", "/v1/projects", {
      name: "Shared box",
      root_path: "/tmp",
      device_id: laptop.id,
    });
    expect(allowed.body).toMatchObject({ device_id: laptop.id, owner_id: carol.userId });
  });

  it("is private until shared: `use` to work in it, `edit` to change it, the owner to delete it", async () => {
    expect((await call(carol, "GET", `/v1/projects/${projectId}`)).status).toBe(404);
    expect((await call(carol, "GET", "/v1/projects/not-a-uuid")).status).toBe(404);
    const share = (permission: string) =>
      call(bob, "PUT", `/v1/shares/project/${projectId}`, {
        principal_type: "user",
        principal_id: carol.userId,
        permission,
      });

    await share("use");
    expect((await call(carol, "GET", `/v1/projects/${projectId}`)).body.permission).toBe("use");
    expect((await call(carol, "PATCH", `/v1/projects/${projectId}?name=Mine`)).status).toBe(403);

    await share("edit");
    const renamed = await call(carol, "PATCH", `/v1/projects/${projectId}?name=${encodeURIComponent("Q3 研究")}`);
    expect(renamed.body.name).toBe("Q3 研究");
    const instructions = "# Direction\nFocus on margins.";
    expect(
      (
        await call(
          carol,
          "PUT",
          `/v1/projects/${projectId}/instructions?instructions_md=${encodeURIComponent(instructions)}`,
        )
      ).body,
    ).toEqual({ ok: true });
    expect((await call(bob, "GET", `/v1/projects/${projectId}`)).body.instructions_md).toBe(instructions);
    expect((await call(carol, "DELETE", `/v1/projects/${projectId}`)).status).toBe(403);
    expect((await call(carol, "PATCH", `/v1/projects/${projectId}`)).status).toBe(400); // name is required
  });

  it("deploys library agents to the team as live references", async () => {
    await call(bob, "POST", "/v1/agents", { name: "Analyst", instructions: "v1" });
    const deployed = await call(bob, "POST", `/v1/projects/${projectId}/agents:deploy`, {
      source_agent_slug: "Analyst",
    });
    expect(deployed.status).toBe(201);
    expect(deployed.body).toMatchObject({
      member: { project_id: projectId, agent_slug: "Analyst", source_agent_slug: "Analyst" },
      agent: {
        name: "Analyst",
        instructions: "v1",
        runtime_provider: "claude_agent",
        skills: [],
        connectors: [],
        resource_policy: "explicit",
      },
    });
    const twice = await call(bob, "POST", `/v1/projects/${projectId}/agents:deploy`, { source_agent_slug: "Analyst" });
    expect([twice.status, twice.body.code]).toEqual([409, "already_deployed"]);

    // Improving the agent in the library reaches the project at once.
    await call(bob, "PATCH", "/v1/agents/Analyst", { instructions: "v2", skills: ["dcf"] });
    const seen = (await call(carol, "GET", `/v1/projects/${projectId}/agents`)).body.agents;
    expect(seen[0].agent).toMatchObject({ instructions: "v2", skills: ["dcf"] });
  });

  it("needs `edit` on the project and `use` on the agent to deploy; a blank agent is created and deployed in one step", async () => {
    await call(alice, "POST", "/v1/agents", { name: "Private Strategist" });
    // carol can edit the project but cannot see alice's agent.
    const hidden = await call(carol, "POST", `/v1/projects/${projectId}/agents:deploy`, {
      source_agent_slug: "Private-Strategist",
    });
    expect(hidden.status).toBe(404);

    const blank = await call(carol, "POST", `/v1/projects/${projectId}/agents`, {
      name: "Writer",
      instructions: "Write clearly.",
    });
    expect(blank.status).toBe(201);
    expect(blank.body).toMatchObject({ member: { agent_slug: "Writer" }, agent: { instructions: "Write clearly." } });
    expect((await call(carol, "GET", "/v1/agents/Writer")).body).toMatchObject({
      permission: "admin",
      owner_name: "carol",
    });
    expect(await team(bob)).toEqual(["Analyst", "Writer"]);

    const outsider = await signUp(t, "outsider");
    expect(
      (await call(outsider, "POST", `/v1/projects/${projectId}/agents:deploy`, { source_agent_slug: "Analyst" }))
        .status,
    ).toBe(404);
  });

  it("the default lead must be on the team, and stops leading when taken off it", async () => {
    const lead = (slug?: string) =>
      call(bob, "PUT", `/v1/projects/${projectId}/default-lead${slug ? `?agent_slug=${slug}` : ""}`);
    expect((await lead("Nobody")).body.code).toBe("not_a_member");
    expect((await lead("Writer")).body.default_lead_agent_slug).toBe("Writer");

    expect((await call(bob, "DELETE", `/v1/projects/${projectId}/agents/Writer`)).status).toBe(204);
    expect(await team(bob)).toEqual(["Analyst"]);
    expect((await call(bob, "GET", `/v1/projects/${projectId}`)).body.default_lead_agent_slug).toBeNull();
    // Off the team, still in the library.
    expect((await call(carol, "GET", "/v1/agents/Writer")).status).toBe(200);
    expect((await call(bob, "DELETE", `/v1/projects/${projectId}/agents/Writer`)).status).toBe(404);
    expect((await lead("Analyst")).body.default_lead_agent_slug).toBe("Analyst");
    expect((await lead()).body.default_lead_agent_slug).toBeNull();
  });

  it("will not delete an agent that is still on a team, unless told to take it off every team", async () => {
    expect((await call(bob, "GET", "/v1/agents/Analyst/deployments")).body).toEqual({
      deployments: [{ project_id: projectId, agent_slug: "Analyst" }],
      count: 1,
    });
    const refused = await call(bob, "DELETE", "/v1/agents/Analyst");
    expect([refused.status, refused.body.code]).toEqual([409, "agent_deployed"]);
    expect((await call(bob, "DELETE", "/v1/agents/Analyst?cascade=true")).status).toBe(204);
    expect(await team(bob)).toEqual([]);
  });

  it("deleting a project takes its team and its shares with it", async () => {
    await call(bob, "POST", `/v1/projects/${projectId}/agents`, { name: "Temp" });
    expect((await call(bob, "GET", `/v1/projects/${projectId}/delete-preview`)).body).toEqual({
      session_count: 0,
      doc_binding_count: 0,
      schedule_count: 0,
      skill_config_count: 0,
    });
    expect((await call(bob, "DELETE", `/v1/projects/${projectId}`)).status).toBe(204);
    expect((await call(carol, "GET", `/v1/projects/${projectId}`)).status).toBe(404);
    const db = t.server.ctx.db;
    expect(await db.selectFrom("project_members").select("id").where("project_id", "=", projectId).execute()).toEqual(
      [],
    );
    expect(await db.selectFrom("resource_shares").select("id").where("resource_id", "=", projectId).execute()).toEqual(
      [],
    );
    expect((await call(bob, "GET", "/v1/agents/Temp")).status).toBe(200); // the library agent stays
  });
});
