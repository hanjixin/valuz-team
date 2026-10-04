import { type ModelGateway, startModelGateway } from "@agent-base/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The activity feed: a member's conversations and their projects' tasks, as one list, newest first. */
describe("activity", () => {
  let t: TestServer;
  let model: ModelGateway;
  let alice: Account;
  let bob: Account;
  let projectId: string;
  const made: string[] = []; // titles, oldest first

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const feed = async (account: Account, query = "") => (await call(account, "GET", `/v1/activity${query}`)).body;
  const titles = (page: Json): string[] => page.items.map((item: Json) => item.title);

  beforeAll(async () => {
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    model = await startModelGateway();
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
    await call(alice, "POST", "/v1/devices", { name: "Alice's Mac" });
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
      runtime: "deepagents",
      model: "test-model",
      provider_id: channel.id,
    });
    projectId = (await call(alice, "POST", "/v1/projects", { name: "Report" })).body.id;
    await call(alice, "POST", `/v1/projects/${projectId}/agents:deploy`, { source_agent_slug: "Analyst" });

    // Conversations and tasks, made in turn so each is newer than the last.
    const chat = async (title: string, project = "chat-default") => {
      const res = await call(alice, "POST", "/v1/sessions", { project_id: project, title });
      expect(res.status).toBe(201);
      made.push(title);
    };
    const task = async (title: string) => {
      const res = await call(alice, "POST", `/v1/projects/${projectId}/tasks:draft`, {
        title,
        goal: "g",
        lead_agent_slug: "Analyst",
        originating_session_id: "chat",
      });
      expect(res.status).toBe(201);
      made.push(title);
    };
    await chat("chat one");
    await task("task one");
    await chat("chat in project", projectId);
    await task("task two");
    await chat("chat two");
  });
  afterAll(async () => {
    await model?.stop();
    await t?.stop();
  });

  it("interleaves conversations and tasks, newest first", async () => {
    const page = await feed(alice);
    expect(titles(page)).toEqual([...made].reverse());
    expect(page.next_cursor).toBeNull();
    expect(page.items[0]).toMatchObject({ kind: "chat", is_automation: false, project_name: null, status: "created" });
    expect(page.items[1]).toMatchObject({ kind: "task", project_id: projectId, project_name: "Report" });
    expect(page.items[2]).toMatchObject({ kind: "chat", project_name: "Report" });
    expect(page.items.map((item: Json) => item.sort_at)).toEqual(
      [...page.items.map((item: Json) => item.sort_at)].sort((a: number, b: number) => b - a),
    );
  });

  it("pages with a cursor, without skipping or repeating", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Json = await feed(alice, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...titles(page));
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual([...made].reverse());
    expect(pages).toBe(3);
    expect((await call(alice, "GET", "/v1/activity?cursor=garbage")).status).toBe(400);
  });

  it("narrows to one kind or one project", async () => {
    expect(titles(await feed(alice, "?tab=chat"))).toEqual(["chat two", "chat in project", "chat one"]);
    expect(titles(await feed(alice, "?tab=task"))).toEqual(["task two", "task one"]);
    expect(titles(await feed(alice, "?tab=automation"))).toEqual([]);
    expect(titles(await feed(alice, `?project_id=${projectId}`))).toEqual(["task two", "chat in project", "task one"]);
    expect(titles(await feed(alice, "?project_id=nope"))).toEqual([]);
  });

  it("shows a member only what they can see", async () => {
    expect(titles(await feed(bob))).toEqual([]);
    await call(alice, "PUT", `/v1/shares/project/${projectId}`, {
      principal_type: "user",
      principal_id: bob.userId,
      permission: "view",
    });
    expect(titles(await feed(bob))).toEqual(["task two", "chat in project", "task one"]);
  });
});
