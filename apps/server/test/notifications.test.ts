import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notify } from "../src/modules/notifications/service.ts";
import { registerShareable } from "../src/modules/sharing/service.ts";
import { type Account, type TestServer, eventually, joinOrg, signUp, startTestServer } from "./harness.ts";

describe("notifications", () => {
  let t: TestServer;
  let url: string;
  let alice: Account;
  let bob: Account;

  const call = (account: Account, method: string, path: string, body?: object) =>
    t.call(method, path, { token: account.token, ...(body ? { body } : {}) });
  const inboxOf = async (account: Account) => (await call(account, "GET", "/v1/notifications")).body;

  beforeAll(async () => {
    t = await startTestServer();
    url = await t.listen();
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
  });
  afterAll(() => t?.stop());

  it("tells a member, in their own language, when something is shared with them by name", async () => {
    const agent = (await call(alice, "POST", "/v1/agents", { name: "Analyst" })).body;
    const share = (principal: object) => call(alice, "PUT", `/v1/shares/agent/${agent.id}`, principal);
    await share({ principal_type: "user", principal_id: bob.userId, permission: "use" });

    const inbox = await inboxOf(bob);
    expect(inbox.unread).toBe(1);
    expect(inbox.entries[0]).toMatchObject({
      kind: "shared",
      title: "alice 向你共享了一个智能体",
      body: "你可使用它。",
      route: "/agents",
      action: "none",
      urgency: "info",
      read_at: null,
      resolved_at: null,
      payload: { resource_type: "agent", resource_id: agent.id, permission: "use" },
    });

    await call(bob, "PATCH", "/v1/settings/preferences", { default_locale: "en-US" });
    await share({ principal_type: "user", principal_id: bob.userId, permission: "edit" });
    expect((await inboxOf(bob)).entries[0]).toMatchObject({
      title: "alice shared an agent with you",
      body: "You can edit it.",
    });
    // Sharing with everyone, or with yourself, is not news to anyone in particular.
    await share({ principal_type: "org", permission: "view" });
    await share({ principal_type: "user", principal_id: alice.userId, permission: "view" });
    expect((await inboxOf(bob)).entries).toHaveLength(2);
    expect((await inboxOf(alice)).entries).toEqual([]);
  });

  it("is each member's own: read, dismiss and history act on nobody else's", async () => {
    const [newer, older] = (await inboxOf(bob)).entries;
    expect((await call(alice, "POST", `/v1/notifications/${older.id}:read`)).body).toEqual({ ok: true });
    expect((await inboxOf(bob)).unread).toBe(2); // alice's call touched nothing

    await call(bob, "POST", `/v1/notifications/${older.id}:read`);
    const afterRead = await inboxOf(bob);
    expect(afterRead.unread).toBe(1);
    expect(afterRead.entries.find((e: { id: string }) => e.id === older.id).read_at).toBeGreaterThan(0);

    await call(bob, "POST", `/v1/notifications/${newer.id}:dismiss`);
    expect((await inboxOf(bob)).entries.map((e: { id: string }) => e.id)).toEqual([older.id]);
    // Dismissed is out of the inbox, not out of the record.
    const history = (await call(bob, "GET", "/v1/notifications/history?limit=1")).body;
    expect(history).toMatchObject({ has_more: true, entries: [{ id: newer.id }] });
    expect(history.entries[0].resolved_at).toBeGreaterThan(0);
    const page2 = (await call(bob, "GET", `/v1/notifications/history?limit=1&before=${history.entries[0].created_at}`))
      .body;
    expect(page2).toMatchObject({ has_more: false, entries: [{ id: older.id }] });

    await call(bob, "POST", "/v1/notifications:dismiss-all");
    expect(await inboxOf(bob)).toEqual({ entries: [], unread: 0 });
    expect((await call(bob, "POST", "/v1/notifications/not-a-uuid:read")).status).toBe(200);
  });

  it("streams the inbox as it is, then each change as it happens", async () => {
    const controller = new AbortController();
    const res = await fetch(`${url}/v1/notifications/stream`, {
      headers: { authorization: `Bearer ${bob.token}` },
      signal: controller.signal,
    });
    const frames: {
      event: string;
      payload: { entries?: unknown[]; entry?: { id: string; read_at: number | null }; id?: string };
    }[] = [];
    const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      let event = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) frames.push({ event, payload: JSON.parse(line.slice(5)).payload });
        }
      }
    })();
    await eventually(async () => frames.some((f) => f.event === "snapshot"));
    expect(frames[0]).toEqual({ event: "snapshot", payload: { entries: [] } });

    await notify(t.server.ctx, { orgId: bob.orgId, userId: bob.userId }, { kind: "info", title: "Build finished" });
    await eventually(async () => frames.some((f) => f.event === "added"));
    const added = frames.find((f) => f.event === "added")?.payload.entry;
    await call(bob, "POST", "/v1/notifications:read-all");
    await call(bob, "POST", `/v1/notifications/${added?.id}:dismiss`);
    await eventually(async () => frames.some((f) => f.event === "resolved"));
    controller.abort();

    expect(frames.map((f) => f.event)).toEqual(["snapshot", "added", "updated", "resolved"]);
    expect(frames[2]?.payload.entry?.read_at).toBeGreaterThan(0);
    expect(frames[3]?.payload).toEqual({ id: added?.id });
  });

  it("a notification that cannot be delivered never fails what it reports on", async () => {
    const db = t.server.ctx.db;
    await sql`CREATE TABLE things (id uuid PRIMARY KEY, org_id uuid NOT NULL, owner_id uuid NOT NULL)`.execute(db);
    const thing = crypto.randomUUID();
    await sql`INSERT INTO things VALUES (${thing}, ${alice.orgId}, ${alice.userId})`.execute(db);
    registerShareable("file", "things");
    await sql`ALTER TABLE notifications RENAME TO notifications_broken`.execute(db);
    try {
      const res = await call(alice, "PUT", `/v1/shares/file/${thing}`, {
        principal_type: "user",
        principal_id: bob.userId,
        permission: "view",
      });
      expect(res.status).toBe(200);
    } finally {
      await sql`ALTER TABLE notifications_broken RENAME TO notifications`.execute(db);
    }
  });
});
