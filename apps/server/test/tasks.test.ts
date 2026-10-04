import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Host } from "@agent-base/host";
import { type ModelGateway, type ModelReply, startModelGateway } from "@agent-base/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, type TestServer, eventually, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Multi-agent tasks, end to end: a real host runs the lead and the members;
 * the stand-in model plays each of them from a script. The lead reaches the
 * orchestrator the way a real one does — as an MCP tool server, from the device.
 */
describe("tasks", () => {
  let t: TestServer;
  let url: string;
  let model: ModelGateway;
  let dir: string;
  let host: Host;
  let alice: Account;
  let bob: Account;
  let carol: Account;
  let projectId: string;
  /** What each task's lead does, turn by turn, keyed by the task's title. */
  const leadScripts = new Map<string, ModelReply[]>();

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const tool = (name: string, args: unknown = {}): ModelReply => ({ tool: { name: `mcp__task__${name}`, args } });
  const systemOf = (request: { messages: { role: string; content: string | null }[] }) =>
    request.messages[0]?.content ?? "";
  /** Every tool result the lead of this task has been shown, in order. */
  const toolResults = (title: string): Json[] =>
    (model.requests.filter((r) => systemOf(r).includes(`### Task: ${title}`)).at(-1)?.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => {
        try {
          return JSON.parse(m.content ?? "");
        } catch {
          return m.content;
        }
      });
  const detail = async (id: string, as = alice) => (await call(as, "GET", `/v1/tasks/${id}`)).body;
  const statusOf = async (id: string) => (await detail(id)).task.status;
  const until = (id: string, status: string) => eventually(async () => (await statusOf(id)) === status, 20_000);
  const kickoff = async (title: string, script: ModelReply[], extra: object = {}) => {
    leadScripts.set(title, script);
    const res = await call(alice, "POST", `/v1/projects/${projectId}/tasks`, {
      title,
      goal: `Goal of ${title}.`,
      lead_agent_slug: "Analyst",
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    url = await t.listen();
    model = await startModelGateway();
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "ab-tasks-")));
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
    carol = await joinOrg(t, alice, "carol");

    const device = (await call(alice, "POST", "/v1/devices", { name: "Alice's Mac" })).body;
    host = new Host({
      config: {
        server_url: url,
        device_id: device.id,
        device_token: device.token,
        owner_user_id: device.owner_id,
        shared_roots: [],
        allow_exec: false,
      },
      dataDir: path.join(dir, "data"),
    });
    await host.start();
    await eventually(async () => (await call(alice, "GET", `/v1/devices/${device.id}`)).body.online === true);

    const channel = (
      await call(alice, "POST", "/v1/providers", {
        name: "Gateway",
        provider_kind: "compatible",
        api_key: "sk",
        base_url: model.url,
        models: ["test-model"],
      })
    ).body;
    for (const [name, description] of [
      ["Analyst", "Plans and reviews"],
      ["Researcher", "Finds facts and figures"],
      ["Writer", "Writes the final document"],
    ])
      await call(alice, "POST", "/v1/agents", {
        name,
        description,
        runtime: "deepagents",
        model: "test-model",
        provider_id: channel.id,
      });
    projectId = (await call(alice, "POST", "/v1/projects", { name: "Report" })).body.id;
    for (const slug of ["Analyst", "Researcher", "Writer"])
      await call(alice, "POST", `/v1/projects/${projectId}/agents:deploy`, { source_agent_slug: slug });

    // The lead follows its task's script; a member answers from its brief.
    model.handler = (request) => {
      const system = systemOf(request);
      const title = /### Task: (.+)/.exec(system)?.[1];
      if (title) return leadScripts.get(title)?.shift() ?? { content: "(the lead has nothing more to say)" };
      if (!system.includes("You are a MEMBER")) return undefined;
      const brief = request.messages.map((m) => m.content).join("\n");
      if (brief.includes("key: slow")) return { hang: true };
      if (brief.includes("key: research")) return { content: "Research: revenue is 42." };
      if (brief.includes("asks for changes")) return { content: "Draft v2 — revenue is 42." };
      return { content: "Draft v1." };
    };
  });
  afterAll(async () => {
    await host?.stop();
    await model?.stop();
    await t?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("needs a lead who is on the project's team", async () => {
    const res = await call(alice, "POST", `/v1/projects/${projectId}/tasks`, { goal: "x", lead_agent_slug: "Nobody" });
    expect([res.status, res.body.code]).toEqual([400, "agent_unavailable"]);
    // A task that could not start leaves nothing behind.
    expect((await call(alice, "GET", `/v1/projects/${projectId}/tasks`)).body.tasks).toEqual([]);
  });

  it("drives plan → dispatch → await → review → finish across a lead and two members", async () => {
    const id = await kickoff("Quarterly report", [
      tool("list_members"),
      tool("dispatch", { subtask_key: "research" }), // before Json plan exists
      tool("plan_task", {
        subtasks: [
          {
            key: "research",
            title: "Research",
            goal: "Find the revenue.",
            agent: "Researcher",
            review_criteria: "States the number.",
          },
          { key: "write", title: "Write", goal: "Write the report.", agent: "Writer", depends_on: ["research"] },
        ],
      }),
      tool("dispatch", { subtask_key: "write" }), // blocked on its dependency
      tool("finish_task", { summary: "too early" }), // unresolved subtasks
      tool("dispatch", { subtask_key: "research" }),
      tool("await_members", { timeout_s: 30 }),
      tool("review_subtask", { subtask_key: "research", decision: "approve", feedback: "has the number" }),
      tool("dispatch", { subtask_key: "write" }),
      tool("await_members", { keys: ["write"], timeout_s: 30 }),
      tool("review_subtask", { subtask_key: "write", decision: "rework", feedback: "Include the revenue figure." }),
      tool("await_members", { timeout_s: 30 }),
      tool("review_subtask", { subtask_key: "write", decision: "approve" }),
      tool("finish_task", { summary: "Report written; revenue is 42.", artifacts: ["report.md"] }),
      { content: "The task is complete." },
    ]);
    await until(id, "completed");

    const done = await detail(id);
    expect(done.task).toMatchObject({
      title: "Quarterly report",
      lead_agent_slug: "Analyst",
      created_by: alice.userId,
      trigger: { type: "user" },
    });
    // One lead and one run per member: the rework went back to the same writer session.
    expect(done.runs.map((r: Json) => [r.kind, r.agent_slug, r.status, r.label])).toEqual([
      ["lead", "Analyst", "completed", "lead"],
      ["subtask", "Researcher", "completed", "Research"],
      ["subtask", "Writer", "completed", "Write"],
    ]);
    const plan = (await call(alice, "GET", `/v1/tasks/${id}/plan`)).body;
    expect(plan).toMatchObject({ ready: [], all_done: true, counts: { done: 2 } });
    expect(plan.subtasks.map((n: Json) => [n.key, n.status, n.attempts])).toEqual([
      ["research", "completed", 1],
      ["write", "completed", 2],
    ]);

    // What the lead was actually shown back from each tool call, in order.
    await eventually(async () => toolResults("Quarterly report").length >= 14);
    const seen = toolResults("Quarterly report");
    expect(seen[0].members.map((m: Json) => [m.slug, m.role_summary])).toEqual([
      ["Analyst", "Plans and reviews"],
      ["Researcher", "Finds facts and figures"],
      ["Writer", "Writes the final document"],
    ]);
    expect(seen[1]).toMatch(/no subtask with key "research"/);
    expect(seen[2].ready).toEqual(["research"]);
    expect(seen[3]).toMatch(/blocked on unfinished dependencies: research/);
    expect(seen[4]).toMatch(/cannot complete: unresolved subtasks remain \(research, write\)/);
    expect(seen[5]).toMatchObject({ status: "dispatched", subtask_key: "research", agent: "Researcher" });
    expect(seen[6].results).toMatchObject([
      {
        subtask_key: "research",
        status: "completed",
        summary: "Research: revenue is 42.",
        review_criteria: "States the number.",
      },
    ]);
    expect(seen[7]).toMatchObject({ status: "done", ready: ["write"] });
    expect(seen[9].results[0]).toMatchObject({ subtask_key: "write", summary: "Draft v1." });
    expect(seen[10]).toMatchObject({ status: "in_progress", session_id: seen[8].session_id });
    expect(seen[11].results[0]).toMatchObject({ subtask_key: "write", summary: "Draft v2 — revenue is 42." });
    expect(seen[13]).toMatchObject({ status: "completed" });

    // A member gets a self-contained brief with the lead's acceptance bar — and no task toolkit.
    const member = model.requests.find((r) => r.messages.some((m) => m.content?.includes("key: research")));
    expect(systemOf(member as never)).toContain("You are a MEMBER");
    expect(member?.messages.map((m) => m.content).join("\n")).toContain("## Acceptance criteria\nStates the number.");
    expect(member?.tools?.some((offered) => offered.function.name.startsWith("mcp__task__"))).toBe(false);

    const timeline = (await call(alice, "GET", `/v1/tasks/${id}/events`)).body.events;
    expect(
      timeline.map((e: Json) => (e.type === "subtask_reviewed" ? `reviewed:${e.payload.decision}` : e.type)),
    ).toEqual([
      "task_drafted",
      "committed",
      "task_planned",
      "subtask_spawned",
      "subtask_completed",
      "subtask_reported",
      "reviewed:approve",
      "subtask_spawned",
      "subtask_completed",
      "subtask_reported",
      "reviewed:rework",
      "subtask_completed",
      "subtask_reported",
      "reviewed:approve",
      "task_completed",
    ]);
    // The plan event carries the plan as the panel shows it.
    expect(timeline[2].payload).toMatchObject({
      plan_version: 1,
      subtasks: [{ key: "research", label: "Research" }, { key: "write" }],
    });
    expect(timeline.at(-1)).toMatchObject({
      actor: "Analyst",
      payload: { summary: "Report written; revenue is 42.", artifacts: ["report.md"] },
    });

    const usage = (await call(alice, "GET", `/v1/tasks/${id}/usage`)).body;
    expect(usage.runs.map((r: Json) => r.kind)).toEqual(["lead", "subtask", "subtask"]);
    expect(usage.total_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.runs.reduce((sum: number, run: Json) => sum + run.total_tokens, 0));

    // The owner is told when it is done.
    const inbox = (await call(alice, "GET", "/v1/notifications")).body.entries;
    expect(inbox[0]).toMatchObject({
      kind: "task_completed",
      route: `/tasks/${id}`,
      body: "Report written; revenue is 42.",
    });
  });

  it("is reached through its project: teammates watch, editors steer, outsiders see nothing", async () => {
    const [task] = (await call(alice, "GET", `/v1/projects/${projectId}/tasks`)).body.tasks;
    expect((await call(bob, "GET", `/v1/tasks/${task.id}`)).status).toBe(404);
    expect((await call(bob, "GET", "/v1/tasks")).body.tasks).toEqual([]);

    await call(alice, "PUT", `/v1/shares/project/${projectId}`, {
      principal_type: "user",
      principal_id: bob.userId,
      permission: "view",
    });
    expect((await call(bob, "GET", `/v1/tasks/${task.id}`)).body.task.id).toBe(task.id);
    expect((await call(bob, "GET", "/v1/tasks")).body.tasks).toHaveLength(1);
    expect((await call(bob, "POST", `/v1/tasks/${task.id}:intervene`, { action: "stop" })).status).toBe(403);
    // A viewer can read the conversations of the runs, but not drive them.
    const lead = (await detail(task.id, bob)).runs[0];
    expect((await call(bob, "GET", `/v1/sessions/${lead.session_id}`)).body).toMatchObject({
      task_id: task.id,
      permission: "view",
    });
    expect((await call(carol, "GET", `/v1/tasks/${task.id}`)).status).toBe(404);

    // The toolkit answers only to a lead's own token — not to a person's.
    const forged = await fetch(`${url}/v1/mcp/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${alice.token}` },
      body: "{}",
    });
    expect(forged.status).toBe(401);
  });

  it("pauses and resumes: running members are parked, and the lead picks the plan back up", async () => {
    const id = await kickoff("Slow work", [
      tool("plan_task", { subtasks: [{ key: "slow", title: "Slow", goal: "Take your time.", agent: "Researcher" }] }),
      tool("dispatch", { subtask_key: "slow" }),
      tool("await_members", { timeout_s: 60 }),
    ]);
    const plan = async () => (await call(alice, "GET", `/v1/tasks/${id}/plan`)).body.subtasks[0];
    await eventually(async () => (await plan())?.internal_status === "in_progress");

    const paused = await call(alice, "POST", `/v1/tasks/${id}:intervene`, { action: "pause" });
    expect(paused.body.status).toBe("paused");
    expect(await plan()).toMatchObject({ internal_status: "paused", status: "paused" });
    const runs = async () => (await detail(id)).runs.map((r: Json) => [r.kind, r.status]);
    expect(await runs()).toEqual([
      ["lead", "active"],
      ["subtask", "paused"],
    ]);
    // A paused task takes no messages until it is resumed.
    const refused = await call(alice, "POST", `/v1/tasks/${id}:inject`, { text: "hello?", from_session_id: "x" });
    expect(refused.body).toMatchObject({ delivered: false, reason: "TASK_PAUSED" });

    // On resume the lead is told, sees the paused subtask, and wraps up.
    leadScripts.set("Slow work", [
      tool("get_plan"),
      tool("finish_task", { summary: "Stopped early.", status: "stopped" }),
      { content: "Closed." },
    ]);
    await call(alice, "POST", `/v1/tasks/${id}:intervene`, { action: "resume" });
    await until(id, "stopped");
    const resumed = model.requests.filter((r) => systemOf(r).includes("### Task: Slow work")).at(-1);
    expect(resumed?.messages.some((m) => m.content?.includes('<system_notice kind="task_resumed">'))).toBe(true);
    expect((await call(alice, "GET", `/v1/tasks/${id}/events`)).body.events.map((e: Json) => e.type)).toEqual(
      expect.arrayContaining(["paused", "resumed", "task_stopped"]),
    );
  });

  it("carries a person's message to the lead, and blocks a task whose lead walks away unfinished", async () => {
    const id = await kickoff("Needs steering", [
      tool("plan_task", { subtasks: [{ key: "only", title: "Only", agent: "Writer" }] }),
      { content: "I will wait for instructions." }, // ends its turn with work outstanding
      { content: "Still waiting." }, // nudged once
      { content: "Still waiting." }, // nudged twice — then the task is blocked
    ]);
    await until(id, "blocked");
    const blocked = (await call(alice, "GET", `/v1/tasks/${id}/events`)).body.events.at(-1);
    expect(blocked).toMatchObject({
      type: "task_blocked",
      payload: { reason: "the lead stopped working while the task was unfinished", unresolved: ["only"] },
    });
    expect((await call(alice, "GET", "/v1/notifications")).body.entries[0]).toMatchObject({ kind: "task_blocked" });
    const nudge = model.requests.filter((r) => systemOf(r).includes("### Task: Needs steering")).at(-1);
    expect(nudge?.messages.some((m) => m.content?.includes("Unresolved subtasks: only"))).toBe(true);

    // The owner resumes it; the lead is told, and this time sees it through.
    leadScripts.set("Needs steering", [
      tool("dispatch", { subtask_key: "only" }),
      tool("await_members", { timeout_s: 30 }),
      tool("review_subtask", { subtask_key: "only", decision: "approve" }),
      tool("finish_task", { summary: "Done after a push." }),
      { content: "Closed." },
    ]);
    await call(alice, "POST", `/v1/tasks/${id}:intervene`, { action: "resume" });
    await until(id, "completed");
  });

  it("a message sent to a running task interrupts the lead's wait and is read at its next turn", async () => {
    const id = await kickoff("Take a message", [
      tool("plan_task", { subtasks: [{ key: "slow", title: "Slow", agent: "Researcher" }] }),
      tool("dispatch", { subtask_key: "slow" }),
      tool("await_members", { timeout_s: 60 }), // parked here when the message arrives
      { content: "Let me read that." },
      // …woken with the message:
      tool("stop_subtask", { subtask_key: "slow", reason: "the user called it off" }),
      tool("finish_task", { summary: "Called off.", status: "stopped" }),
      { content: "Closed." },
    ]);
    await eventually(
      async () =>
        (await call(alice, "GET", `/v1/tasks/${id}/plan`)).body.subtasks[0]?.internal_status === "in_progress",
    );
    const lead = (await detail(id)).task.current_holder;
    const sent = await call(alice, "POST", `/v1/tasks/${id}:inject`, { text: "Call it off.", from_session_id: "x" });
    expect(sent.body).toEqual({ delivered: true, lead_session_id: lead, reason: null });
    await until(id, "stopped");

    const heard = model.requests.filter((r) => systemOf(r).includes("### Task: Take a message"));
    expect(
      heard.some((r) => r.messages.some((m) => m.content?.includes("<user_message>\nCall it off.\n</user_message>"))),
    ).toBe(true);
    await eventually(async () => toolResults("Take a message").length >= 5);
    const seen = toolResults("Take a message");
    // The wait ended early, saying why, with the member reported as still alive.
    expect(seen[2]).toMatchObject({
      results: [],
      pending: ["slow"],
      note: "a new message is waiting for you — end this wait and read it",
    });
    expect(seen[3]).toMatchObject({ subtask_key: "slow", status: "rework" });
    expect(seen[4]).toMatchObject({ status: "stopped" });
    // The stopped member's conversation shows it was interrupted, not that it failed on its own.
    const member = (await detail(id)).runs.find((r: Json) => r.kind === "subtask");
    expect(member.status).toBe("rejected");
  });

  it("starts as a draft whose plan a person can write, then commits or is abandoned", async () => {
    const draft = await call(alice, "POST", `/v1/projects/${projectId}/tasks:draft`, {
      goal: "Draft the launch plan",
      lead_agent_slug: "Analyst",
      originating_session_id: "chat",
    });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({
      status: "draft",
      plan_version: 0,
      title: "Draft the launch plan",
      lead_agent_slug: "Analyst",
    });
    const id = draft.body.task_id;
    expect((await detail(id)).runs).toEqual([]); // nothing runs until it is committed

    const planned = await call(alice, "POST", `/v1/tasks/${id}/plan`, {
      subtasks: [
        { key: "outline", title: "Outline", agent: "Writer" },
        { key: "polish", title: "Polish", agent: "Writer", depends_on: ["outline"] },
      ],
    });
    expect(planned.body).toMatchObject({ ready: ["outline"], current_version: 1 });
    const stale = await call(alice, "PATCH", `/v1/tasks/${id}/plan`, {
      update: [{ key: "polish", title: "Polish it" }],
      expected_version: 0,
    });
    expect([stale.status, stale.body.code]).toEqual([409, "plan_version_mismatch"]);
    const cyclic = await call(alice, "PATCH", `/v1/tasks/${id}/plan`, {
      update: [{ key: "outline", depends_on: ["polish"] }],
      expected_version: 1,
    });
    expect([cyclic.status, cyclic.body.code]).toEqual([400, "invalid_plan"]);
    const stranger = await call(alice, "PATCH", `/v1/tasks/${id}/plan`, {
      add: [{ key: "x", title: "X", agent: "Nobody" }],
    });
    expect(stranger.body.message).toContain("is not a member of this project");

    leadScripts.set("Draft the launch plan", [
      tool("get_plan"),
      tool("finish_task", { summary: "Not today.", status: "stopped" }),
      { content: "Closed." },
    ]);
    const committed = await call(alice, "POST", `/v1/tasks/${id}:commit`, { caller_session_id: "chat" });
    expect(committed.body).toMatchObject({ task_id: id, status: "active" });
    expect(committed.body.lead_session_id).toBeTruthy();
    await until(id, "stopped");
    // The lead was handed the plan the person wrote.
    await eventually(async () => toolResults("Draft the launch plan").length >= 1);
    expect(toolResults("Draft the launch plan")[0].subtasks.map((n: Json) => n.key)).toEqual(["outline", "polish"]);
    expect((await call(alice, "POST", `/v1/tasks/${id}:commit`, { caller_session_id: "chat" })).body.code).toBe(
      "task_not_draft",
    );

    const other = (
      await call(alice, "POST", `/v1/projects/${projectId}/tasks:draft`, {
        goal: "Never mind",
        lead_agent_slug: "Analyst",
        originating_session_id: "chat",
      })
    ).body;
    expect(
      (
        await call(alice, "POST", `/v1/tasks/${other.task_id}:abandon`, {
          caller_session_id: "chat",
          reason: "changed my mind",
        })
      ).body,
    ).toEqual({ task_id: other.task_id, status: "abandoned" });
    expect((await call(alice, "POST", `/v1/tasks/${other.task_id}:commit`, { caller_session_id: "chat" })).status).toBe(
      409,
    );
  });

  it("shows what is in flight, and deleting a task takes its runs' conversations with it", async () => {
    const id = await kickoff("To be deleted", [
      tool("plan_task", { subtasks: [{ key: "slow", title: "Slow", agent: "Researcher" }] }),
      tool("dispatch", { subtask_key: "slow" }),
      tool("await_members", { timeout_s: 60 }),
    ]);
    await eventually(
      async () =>
        (await call(alice, "GET", `/v1/tasks/${id}/plan`)).body.subtasks[0]?.internal_status === "in_progress",
    );
    const running = (await call(alice, "GET", "/v1/runs?status=running")).body.runs;
    expect(running.filter((r: Json) => r.task_id === id).map((r: Json) => [r.source_kind, r.origin, r.status])).toEqual(
      expect.arrayContaining([["task", "task", "running"]]),
    );
    const sessionIds = (await detail(id)).runs.map((r: Json) => r.session_id);

    expect((await call(bob, "DELETE", `/v1/tasks/${id}`)).status).toBe(403);
    expect((await call(alice, "DELETE", `/v1/tasks/${id}`)).status).toBe(204);
    expect((await call(alice, "GET", `/v1/tasks/${id}`)).status).toBe(404);
    for (const sessionId of sessionIds)
      expect((await call(alice, "GET", `/v1/sessions/${sessionId}`)).status).toBe(404);
  });
});
