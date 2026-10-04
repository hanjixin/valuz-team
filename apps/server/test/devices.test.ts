import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Host } from "@agent-base/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Server, buildServer } from "../src/app.ts";
import { loadConfig } from "../src/infra/config.ts";
import { type Account, type TestServer, eventually, joinOrg, signUp, startTestServer } from "./harness.ts";

describe("devices", () => {
  let t: TestServer;
  let url: string;
  let owner: Account; // owns the machine
  let mate: Account; // another member of the organization
  let dir: string; // the machine's disk, as far as this test goes
  let shared: string;
  let device: { id: string; token: string; owner_id: string };
  let host: Host;
  const hostLog: string[] = [];

  const startHost = async (overrides: { device_token?: string; allow_exec?: boolean } = {}) => {
    const started = new Host({
      config: {
        server_url: url,
        device_id: device.id,
        device_token: device.token,
        owner_user_id: device.owner_id,
        shared_roots: [shared],
        allow_exec: false,
        ...overrides,
      },
      dataDir: path.join(dir, "data"),
      log: (line) => hostLog.push(line),
    });
    await started.start();
    return started;
  };
  const view = async (account: Account, on = t) =>
    await on.call("GET", `/v1/devices/${device.id}`, { token: account.token });
  const remote = (account: Account, op: string, body: object = {}, on = t) =>
    on.call("POST", `/v1/devices/${device.id}/${op}`, { token: account.token, body });
  const online = (expected: boolean) => eventually(async () => (await view(owner)).body.online === expected);

  beforeAll(async () => {
    t = await startTestServer();
    url = await t.listen();
    owner = await signUp(t, "owner");
    mate = await joinOrg(t, owner, "mate");
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "ab-device-")));
    shared = path.join(dir, "shared");
    await mkdir(shared);
    await writeFile(path.join(dir, "private.txt"), "owner only");
  });
  afterAll(async () => {
    await host?.stop();
    await t?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("registers a device, shows its token once, and reports it online once its host links", async () => {
    const created = await t.call("POST", "/v1/devices", { token: owner.token, body: { name: "Studio Mac" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Studio Mac", owner_id: owner.userId, link_path: "/v1/devices/link" });
    expect(created.body.token).toMatch(/^dev_/);
    device = created.body;

    const before = await view(owner);
    expect(before.body).toMatchObject({ online: false, permission: "admin", owner_name: "owner", info: {} });
    expect(JSON.stringify(before.body)).not.toContain("dev_");

    host = await startHost();
    await online(true);
    const linked = await eventually(async () => {
      const { body } = await view(owner);
      return body.info.hostname ? body : null;
    });
    expect(linked.info).toMatchObject({ shared_roots: [shared], allow_exec: false, host_version: "0.1.0" });
    expect(linked.last_seen_at).toBeTruthy();
    expect((await t.call("GET", "/v1/devices", { token: owner.token })).body.devices).toHaveLength(1);
  });

  it("refuses a link that does not present a valid device token", async () => {
    const before = hostLog.length;
    const impostor = await startHost({ device_token: "dev_wrong" });
    await eventually(async () => hostLog.slice(before).some((line) => line.startsWith("link rejected")));
    await impostor.stop();
    expect((await view(owner)).body.online).toBe(true); // the real host is untouched
  });

  it("lets the owner reach the whole machine: files and commands", async () => {
    const file = path.join(dir, "notes", "hello.txt");
    const written = await remote(owner, "fs/write", { path: file, content: "hello from afar" });
    expect(written.body).toMatchObject({ path: file, size: 15 });
    expect(await readFile(file, "utf8")).toBe("hello from afar");

    expect((await remote(owner, "fs/read", { path: file })).body).toEqual({
      path: file,
      size: 15,
      encoding: "utf8",
      content: "hello from afar",
    });
    const listing = await remote(owner, "fs/list", { path: dir });
    expect(listing.body.entries.map((e: { name: string; kind: string }) => [e.name, e.kind])).toEqual([
      ["notes", "dir"],
      ["private.txt", "file"],
      ["shared", "dir"],
    ]);
    const ran = await remote(owner, "exec", { command: "echo out; echo err >&2; exit 3", cwd: dir });
    expect(ran.body).toEqual({ exit_code: 3, output: "out\nerr\n", timed_out: false, truncated: false });
    const slow = await remote(owner, "exec", { command: "sleep 5", cwd: dir, timeout_ms: 1000 });
    expect(slow.body).toMatchObject({ timed_out: true });
    expect((await remote(owner, "info")).body).toMatchObject({ shared_roots: [shared] });
  });

  it("is invisible to other members until shared, and `use` is not remote control", async () => {
    expect((await view(mate)).status).toBe(404);
    expect((await t.call("GET", "/v1/devices", { token: mate.token })).body.devices).toEqual([]);
    expect((await remote(mate, "fs/list", { path: shared })).status).toBe(404);

    const share = (permission: string) =>
      t.call("PUT", `/v1/shares/device/${device.id}`, {
        token: owner.token,
        body: { principal_type: "user", principal_id: mate.userId, permission },
      });
    expect((await share("use")).status).toBe(200);
    expect((await view(mate)).body).toMatchObject({ permission: "use", online: true });
    const denied = await remote(mate, "fs/list", { path: shared });
    expect([denied.status, denied.body.message]).toEqual([403, 'this needs "control" permission on the device']);
    expect((await t.call("PATCH", `/v1/devices/${device.id}`, { token: mate.token, body: { name: "x" } })).status).toBe(
      403,
    );
    expect((await share("control")).status).toBe(200);
  });

  it("with `control`, another member is still held to what the owner shared on the machine itself", async () => {
    await writeFile(path.join(shared, "plan.md"), "# plan");
    expect((await remote(mate, "fs/read", { path: path.join(shared, "plan.md") })).body.content).toBe("# plan");

    const outside = await remote(mate, "fs/read", { path: path.join(dir, "private.txt") });
    expect([outside.status, outside.body.code]).toEqual([403, "forbidden"]);
    // Neither `..` nor a symlink leads out of the shared folder.
    const dotdot = await remote(mate, "fs/read", { path: `${shared}/../private.txt` });
    expect(dotdot.status).toBe(403);
    await remote(owner, "exec", { command: "ln -s ../private.txt shared/escape", cwd: dir });
    expect((await remote(mate, "fs/read", { path: path.join(shared, "escape") })).status).toBe(403);

    const exec = await remote(mate, "exec", { command: "id", cwd: shared });
    expect([exec.status, exec.body.message]).toEqual([
      403,
      "the device owner has not enabled remote command execution",
    ]);
    await host.stop();
    host = await startHost({ allow_exec: true });
    await eventually(async () => (await remote(mate, "exec", { command: "echo ok", cwd: shared })).status === 200);
    expect((await remote(mate, "exec", { command: "echo ok", cwd: dir })).status).toBe(403); // cwd outside
  });

  it("writes every remote-control call to the audit trail, without file contents", async () => {
    const logs = (await t.call("GET", "/v1/org/audit-logs?limit=200", { token: owner.token })).body.logs;
    const write = logs.find((l: { action: string }) => l.action === "device.fs.write");
    expect(write).toMatchObject({ actor_name: "owner", resource_type: "device", resource_id: device.id });
    expect(write.detail).toMatchObject({ content: "<15 chars>" });
    const execs = logs.filter((l: { action: string }) => l.action === "device.exec.run");
    expect(
      execs.some(
        (l: { actor_name: string; detail: { command: string } }) =>
          l.actor_name === "mate" && l.detail.command === "id",
      ),
    ).toBe(true);
  });

  it("reaches a device linked to another replica", async () => {
    const replica: Server = await buildServer(loadConfig(t.env));
    await replica.app.ready();
    try {
      const res = await replica.app.inject({
        method: "POST",
        url: `/v1/devices/${device.id}/fs/read`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { path: path.join(dir, "private.txt") },
      });
      expect([res.statusCode, res.json().content]).toEqual([200, "owner only"]);
      const seen = await replica.app.inject({
        method: "GET",
        url: `/v1/devices/${device.id}`,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(seen.json().online).toBe(true);
    } finally {
      await replica.close();
    }
  });

  it("answers plainly when the device is offline", async () => {
    await host.stop();
    await online(false);
    const res = await remote(owner, "fs/list", { path: dir });
    expect([res.status, res.body.code]).toEqual([503, "device_offline"]);
    host = await startHost();
    await online(true);
  });

  it("revoking a device drops its link for good and ends its shares", async () => {
    const before = hostLog.length;
    expect((await t.call("DELETE", `/v1/devices/${device.id}`, { token: mate.token })).status).toBe(403);
    expect((await t.call("DELETE", `/v1/devices/${device.id}`, { token: owner.token })).status).toBe(204);
    await eventually(async () => hostLog.slice(before).some((line) => line.startsWith("link rejected")));
    expect((await view(owner)).status).toBe(404);
    expect((await view(mate)).status).toBe(404);
    expect(await t.server.ctx.db.selectFrom("resource_shares").select("id").execute()).toEqual([]);

    // The token is dead: a restarted host is refused at the door.
    const mark = hostLog.length;
    const again = await startHost();
    await eventually(async () => hostLog.slice(mark).some((line) => line.startsWith("link rejected")));
    await again.stop();
  });

  it("a member who leaves takes their machines out of the organization", async () => {
    const mine = await t.call("POST", "/v1/devices", { token: mate.token, body: { name: "Mate's laptop" } });
    expect((await t.call("GET", "/v1/devices", { token: owner.token })).body.devices).toHaveLength(1); // org owner sees it
    await t.call("DELETE", `/v1/org/members/${mate.userId}`, { token: mate.token });
    expect((await t.call("GET", "/v1/devices", { token: owner.token })).body.devices).toEqual([]);
    const row = await t.server.ctx.db
      .selectFrom("devices")
      .select("revoked_at")
      .where("id", "=", mine.body.id)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).toBeInstanceOf(Date);
  });
});
