import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Host } from "@agent-base/host";
import { type ModelGateway, startModelGateway } from "@agent-base/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Account, type TestServer, eventually, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Automations: an agent's work started by the clock or by hand, run as the
 * member who set it up, on a real device, and recorded run by run.
 */
describe("automations", () => {
  let t: TestServer;
  let url: string;
  let model: ModelGateway;
  let dir: string;
  let host: Host;
  let alice: Account;
  let bob: Account;
  let projectId: string;
  let daily: Json; // a conversation automation on a cron
  let teamwork: Json; // a task automation in a project

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const runOf = async (automation: string, run: string) =>
    (await call(alice, "GET", `/v1/automations/${automation}/runs/${run}`)).body;
  const settled = (automation: string, run: string) =>
    eventually(async () => {
      const current = await runOf(automation, run);
      return current.status !== "running" && current;
    }, 20_000);

  beforeAll(async () => {
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    url = await t.listen();
    model = await startModelGateway();
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "ab-automations-")));
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
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
    await call(alice, "POST", "/v1/providers/default", { provider_id: channel.id });
    await call(alice, "POST", "/v1/agents", {
      name: "Analyst",
      instructions: "You are the analyst.",
      runtime: "deepagents",
      model: "test-model",
      provider_id: channel.id,
    });
    projectId = (await call(alice, "POST", "/v1/projects", { name: "Report" })).body.id;
    await call(alice, "POST", `/v1/projects/${projectId}/agents:deploy`, { source_agent_slug: "Analyst" });
  });
  afterAll(async () => {
    await host?.stop();
    await model?.stop();
    await t?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    model.replies.length = 0;
  });

  it("checks a schedule before it is saved, and says it in words", async () => {
    const cron = await call(alice, "POST", "/v1/automations/validate-cron", {
      expr: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
    });
    expect(cron.body).toMatchObject({ valid: true, human_readable: "在09:00, 星期一至星期五", error_message: null });
    expect(cron.body.next_runs).toHaveLength(5);
    expect(new Date(cron.body.next_runs[0]).getUTCHours()).toBe(1); // 09:00 in Shanghai
    const bad = async (expr: string, timezone = "UTC") =>
      (await call(alice, "POST", "/v1/automations/validate-cron", { expr, timezone })).body;
    expect(await bad("every day")).toMatchObject({ valid: false, next_runs: [] });
    expect((await bad("* * * * * *")).error_message).toMatch(/five fields/);
    expect((await bad("0 9 * * *", "Mars/Olympus")).error_message).toMatch(/unknown timezone/);

    const interval = async (seconds: number) =>
      (await call(alice, "POST", "/v1/automations/validate-interval", { seconds })).body;
    expect(await interval(7200)).toMatchObject({ valid: true, human_readable: "每 2 小时" });
    expect(await interval(90)).toMatchObject({ valid: true, human_readable: "每 90 秒" });
    expect(await interval(5)).toMatchObject({ valid: false, error_message: "an interval is at least 30 seconds" });
  });

  it("is created in a conversation of its own or in a project, and put on the clock", async () => {
    expect((await call(alice, "GET", "/v1/automations/project-targets")).body.targets).toEqual([
      { id: "chat-default", name: "Chat", kind: "chat", project_id: null },
      { id: projectId, name: "Report", kind: "project", project_id: projectId },
    ]);
    const created = await call(alice, "POST", "/v1/automations", {
      name: "Daily brief",
      project_kind: "chat",
      project_id: null,
      agent_kind: "library_agent",
      agent_slug: "Analyst",
      prompt_template: "Write today's brief.",
      trigger: { kind: "cron", cron_expr: "0 9 * * *", timezone: "Asia/Shanghai" },
    });
    expect(created.status).toBe(201);
    daily = created.body;
    expect(daily).toMatchObject({
      name: "Daily brief",
      project_kind: "chat",
      project_name: "Daily brief",
      agent_slug: "Analyst",
      agent_name: "Analyst",
      action_kind: "chat",
      execution: { kind: "agent", mode: "chat" },
      trigger: { kind: "cron", cron_expr: "0 9 * * *", timezone: "Asia/Shanghai" },
      trigger_human_readable: "在09:00",
      status: "enabled",
      last_run_at: null,
      total_runs: 0,
      owner_id: alice.userId,
      editable: true,
    });
    expect(daily.next_run_at).toBeGreaterThan(Date.now());
    expect(daily.next_run_at - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);

    teamwork = (
      await call(alice, "POST", "/v1/automations", {
        name: "Weekly report",
        project_kind: "project",
        project_id: projectId,
        agent_kind: "project_member",
        agent_slug: "Analyst",
        action_kind: "task",
        prompt_template: "Produce the weekly report.",
        trigger: { kind: "manual" },
      })
    ).body;
    expect(teamwork).toMatchObject({ project_name: "Report", project_kind: "project", next_run_at: null });
    expect(teamwork.trigger_human_readable).toBe("手动触发");

    const groups = (await call(alice, "GET", "/v1/automations")).body.groups;
    expect(groups.map((group: Json) => [group.project_name, group.automations.map((a: Json) => a.name)])).toEqual(
      expect.arrayContaining([
        ["Daily brief", ["Daily brief"]],
        ["Report", ["Weekly report"]],
      ]),
    );
    expect((await call(alice, "GET", `/v1/automations?project_id=${projectId}`)).body.groups).toHaveLength(1);
  });

  it("refuses what this server cannot run, when it is asked for", async () => {
    const base = { name: "x", project_kind: "chat", prompt_template: "p", trigger: { kind: "manual" } };
    const refused = async (extra: object) => {
      const res = await call(alice, "POST", "/v1/automations", { ...base, ...extra });
      return [res.status, res.body.code];
    };
    expect(await refused({ execution: { kind: "code", runtime: "shell", entry: "x" } })).toEqual([
      400,
      "unsupported_execution",
    ]);
    expect(await refused({ trigger: { kind: "event" } })).toEqual([400, "unsupported_trigger"]);
    expect(await refused({ trigger: { kind: "cron", cron_expr: "nope" } })).toEqual([400, "invalid_cron"]);
    expect(await refused({ trigger: { kind: "interval", seconds: 1 } })).toEqual([400, "invalid_interval"]);
    expect(await refused({ action_kind: "task" })).toEqual([400, "project_required"]);
    expect(await refused({ agent_slug: "Nobody" })).toEqual([400, "agent_unavailable"]);
    expect(await refused({ project_kind: "project", project_id: projectId, action_kind: "task" })).toEqual([
      400,
      "agent_required",
    ]);
    expect((await call(alice, "GET", "/v1/automations/event-sources")).body).toEqual({ sources: [] });
  });

  it("runs when asked: a conversation with the agent, as the owner, recorded as a run", async () => {
    model.replies.push({ content: "Brief: all quiet." });
    const accepted = await call(alice, "POST", `/v1/automations/${daily.automation_id}/run-now`, {
      input: "Focus on Asia.",
    });
    expect(accepted.body).toMatchObject({ automation_id: daily.automation_id, status: "running" });
    const run = await settled(daily.automation_id, accepted.body.run_id);
    expect(run).toMatchObject({
      status: "success",
      trigger_type: "manual",
      result_summary: "Brief: all quiet.",
      error_message: null,
      has_input: true,
      input: "Focus on Asia.",
      task_id: null,
    });
    expect(run.duration_ms).toBeGreaterThanOrEqual(0);
    // The agent was given the prompt and this run's input, under its own instructions.
    const turn = model.requests.at(-1);
    expect(turn?.messages[0]?.content).toContain("You are the analyst.");
    expect(turn?.messages.at(-1)?.content).toContain("Write today's brief.\n\nFocus on Asia.");
    // It left a conversation behind — the owner's, marked as started by an automation.
    const session = (await call(alice, "GET", `/v1/sessions/${run.session_id}`)).body;
    expect(session).toMatchObject({ origin: "automation", owner_id: alice.userId, project_id: daily.project_id });
    expect(session.name).toMatch(/^Daily brief · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const feed = (await call(alice, "GET", "/v1/activity?tab=automation")).body.items;
    expect(feed).toEqual([expect.objectContaining({ id: run.session_id, is_automation: true })]);
    expect((await call(alice, "GET", "/v1/activity?tab=chat")).body.items).toEqual([]);
    // …and a note in the owner's inbox.
    const inbox = (await call(alice, "GET", "/v1/notifications")).body.entries;
    expect(inbox[0]).toMatchObject({ kind: "automation_completed", title: "自动化已完成：Daily brief" });

    const detail = (await call(alice, "GET", `/v1/automations/${daily.automation_id}`)).body;
    expect(detail).toMatchObject({ total_runs: 1, recent_failures: 0, last_run_status: "success" });
    expect(detail.last_run_at).toBe(run.triggered_at);
    const runs = (await call(alice, "GET", `/v1/automations/${daily.automation_id}/runs`)).body.runs;
    expect(runs.map((item: Json) => item.run_id)).toEqual([run.run_id]);
  });

  it("hands a goal to a project's team as a task", async () => {
    const accepted = await call(alice, "POST", `/v1/automations/${teamwork.automation_id}/run-now`, {
      wait_seconds: 10,
    });
    const run = accepted.body.run;
    expect(run).toMatchObject({ status: "success", session_id: null, task_status: "active" });
    expect(run.task_title).toMatch(/^Weekly report · /);
    const task = (await call(alice, "GET", `/v1/tasks/${run.task_id}`)).body.task;
    expect(task).toMatchObject({ goal: "Produce the weekly report.", lead_agent_slug: "Analyst" });
  });

  it("stops a run that is still going", async () => {
    model.replies.push({ hang: true });
    const accepted = (await call(alice, "POST", `/v1/automations/${daily.automation_id}/run-now`)).body;
    const going = await eventually(async () => {
      const run = await runOf(daily.automation_id, accepted.run_id);
      return run.session_id && run;
    });
    await eventually(
      async () => (await call(alice, "GET", `/v1/sessions/${going.session_id}`)).body.status === "running",
    );
    const cancelled = await call(alice, "POST", `/v1/automations/${daily.automation_id}/runs/${going.run_id}/cancel`);
    expect(cancelled.body).toMatchObject({ status: "cancelled" });
    expect(cancelled.body.cancel_requested_at).toBeTruthy();
    await eventually(async () => (await call(alice, "GET", `/v1/sessions/${going.session_id}`)).body.status === "idle");
    expect((await runOf(daily.automation_id, going.run_id)).status).toBe("cancelled");
    const again = await call(alice, "POST", `/v1/automations/${daily.automation_id}/runs/${going.run_id}/cancel`);
    expect([again.status, again.body.code]).toEqual([409, "run_ended"]);
  });

  it("pauses, resumes and changes: the clock follows", async () => {
    const paused = (await call(alice, "POST", `/v1/automations/${daily.automation_id}/pause`)).body;
    expect(paused).toMatchObject({ status: "paused", next_run_at: null });
    const resumed = (await call(alice, "POST", `/v1/automations/${daily.automation_id}/resume`)).body;
    expect(resumed.status).toBe("enabled");
    expect(resumed.next_run_at).toBeGreaterThan(Date.now());

    const changed = await call(alice, "PATCH", `/v1/automations/${daily.automation_id}`, {
      name: "Hourly brief",
      prompt_template: "Write this hour's brief.",
      trigger: { kind: "interval", seconds: 3600 },
    });
    expect(changed.body).toMatchObject({
      name: "Hourly brief",
      prompt_template: "Write this hour's brief.",
      trigger: { kind: "interval", seconds: 3600 },
      trigger_human_readable: "每 1 小时",
    });
    expect(changed.body.next_run_at - Date.now()).toBeLessThanOrEqual(3600 * 1000);
    // Putting it on the clock does not run it: the first firing is an interval away.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await call(alice, "GET", `/v1/automations/${daily.automation_id}`)).body.total_runs).toBe(2);
    const manual = await call(alice, "PATCH", `/v1/automations/${daily.automation_id}`, {
      trigger: { kind: "manual" },
    });
    expect(manual.body.next_run_at).toBeNull();
    expect(
      (await call(alice, "PATCH", `/v1/automations/${daily.automation_id}`, { agent_slug: "Nobody" })).body.code,
    ).toBe("agent_unavailable");
  });

  it("fires by the clock, one run at a time, until it is paused", async () => {
    // A server whose shortest interval is a second, on the same database and Redis.
    const fast = await startTestServer({ ...t.env, AUTOMATION_MIN_INTERVAL_SECONDS: "1" });
    try {
      const ticking = (
        await fast.call("POST", "/v1/automations", {
          token: alice.token,
          body: {
            name: "Ticker",
            project_kind: "chat",
            agent_slug: "Analyst",
            prompt_template: "tick",
            trigger: { kind: "interval", seconds: 1 },
          },
        })
      ).body;
      const runs = async () =>
        (await call(alice, "GET", `/v1/automations/${ticking.automation_id}/runs`)).body.runs as Json[];
      // The first firing starts a turn that does not end; the firings after it find it still going.
      model.handler = (request) => (request.messages.at(-1)?.content?.includes("tick") ? { hang: true } : undefined);
      const seen = await eventually(async () => {
        const all = await runs();
        return all.filter((run) => run.status === "skipped").length >= 2 && all;
      }, 15_000);
      expect(seen.filter((run) => run.status === "running")).toHaveLength(1);
      expect(seen.every((run) => run.trigger_type === "interval")).toBe(true);
      expect(seen.find((run) => run.status === "skipped")).toMatchObject({ error_code: "previous_run_active" });
      // A skipped firing is not what "last run" means.
      const detail = (await call(alice, "GET", `/v1/automations/${ticking.automation_id}`)).body;
      expect(detail.last_run_status).toBe("running");

      // Paused: the clock stops; the run in flight is left to finish, or to be stopped.
      await call(alice, "POST", `/v1/automations/${ticking.automation_id}/pause`);
      const count = (await runs()).length;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect((await runs()).length).toBe(count);
      const going = (await runs()).find((run) => run.status === "running");
      await call(alice, "POST", `/v1/automations/${ticking.automation_id}/runs/${going?.run_id}/cancel`);
      await call(alice, "DELETE", `/v1/automations/${ticking.automation_id}`);
    } finally {
      model.handler = null;
      await fast.stop();
    }
  });

  it("is seen by whoever sees its project, and changed by its owner or the project's editors", async () => {
    expect((await call(bob, "GET", "/v1/automations")).body.groups).toEqual([]);
    expect((await call(bob, "GET", `/v1/automations/${teamwork.automation_id}`)).status).toBe(404);
    const share = (permission: string) =>
      call(alice, "PUT", `/v1/shares/project/${projectId}`, {
        principal_type: "user",
        principal_id: bob.userId,
        permission,
      });
    await share("view");
    const seen = (await call(bob, "GET", `/v1/automations/${teamwork.automation_id}`)).body;
    expect(seen).toMatchObject({ name: "Weekly report", editable: false });
    expect((await call(bob, "GET", `/v1/automations/${teamwork.automation_id}/runs`)).body.runs).toHaveLength(1);
    expect((await call(bob, "POST", `/v1/automations/${teamwork.automation_id}/pause`)).status).toBe(403);
    expect((await call(bob, "POST", `/v1/automations/${teamwork.automation_id}/run-now`)).status).toBe(403);
    expect((await call(bob, "DELETE", `/v1/automations/${teamwork.automation_id}`)).status).toBe(403);
    await share("edit");
    expect((await call(bob, "POST", `/v1/automations/${teamwork.automation_id}/pause`)).body.status).toBe("paused");
    // Alice's own conversation automation stays hers.
    expect((await call(bob, "GET", `/v1/automations/${daily.automation_id}`)).status).toBe(404);
  });

  it("records a run that could not start, tells the owner, and forgets its runs when deleted", async () => {
    await host.stop();
    await eventually(async () =>
      (await call(alice, "GET", "/v1/devices")).body.devices.every((d: Json) => d.online === false),
    );
    const accepted = (await call(alice, "POST", `/v1/automations/${daily.automation_id}/run-now`)).body;
    const run = await settled(daily.automation_id, accepted.run_id);
    expect(run).toMatchObject({
      status: "failed",
      error_code: "device_offline",
      error_message: "the device is offline",
    });
    const inbox = (await call(alice, "GET", "/v1/notifications")).body.entries;
    expect(inbox[0]).toMatchObject({ kind: "automation_failed", title: "自动化运行失败：Hourly brief" });
    expect((await call(alice, "GET", `/v1/automations/${daily.automation_id}`)).body).toMatchObject({
      last_run_status: "failed",
      recent_failures: 1,
    });

    expect((await call(alice, "DELETE", `/v1/automations/${daily.automation_id}`)).status).toBe(204);
    expect((await call(alice, "GET", `/v1/automations/${daily.automation_id}`)).status).toBe(404);
    expect((await call(alice, "GET", `/v1/automations/${daily.automation_id}/runs`)).status).toBe(404);
    const actions = (await call(alice, "GET", "/v1/org/audit-logs?limit=200")).body.logs.map(
      (entry: Json) => entry.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["automation.create", "automation.delete"]));
  });
});
