/**
 * End to end: a real server (Postgres + Redis), a real host process linked over
 * WebSocket, the native runtime talking to a fake model gateway, and — when
 * the `minio` binary is installed — a real S3 bucket. Nothing here is mocked
 * except the model.
 *
 * Needs `pnpm infra:up` (deploy/docker-compose.dev.yml).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { type Server as HttpServer, createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Host } from "../../host/src/executor.ts";
import { type Server, buildServer } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { migrateDown, migrateUp } from "../src/migrate.ts";

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://agentbase:agentbase@127.0.0.1:55432/agentbase";
const REDIS_URL = process.env["TEST_REDIS_URL"] ?? "redis://127.0.0.1:56379/1";
const dbName = `agentbase_test_${Date.now()}`;
const MINIO_PORT = 59000;

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
interface User {
  token: string;
  refresh: string;
  id: string;
  org: string;
}

let server: Server;
let base: string;
let gateway: HttpServer;
let gatewayUrl: string;
let work: string;
let host: Host;
let minio: ChildProcess | null = null;
type ModelReply = { content?: string; tool?: { name: string; args: unknown }; delayMs?: number };
type ModelRequest = { messages: { role: string; content: string }[]; auth: string };
const modelReplies: ModelReply[] = [];
const modelRequests: ModelRequest[] = [];
/** When set, decides the reply from the request itself (concurrent sessions cannot share a FIFO). */
let modelHandler: ((req: ModelRequest) => ModelReply | undefined) | null = null;

async function call(method: string, route: string, user?: User | null, body?: unknown, org?: string): Promise<Res> {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(user ? { authorization: `Bearer ${user.token}` } : {}),
      ...(org ? { "x-org-id": org } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function register(name: string, invite?: string): Promise<User> {
  const res = await call("POST", "/v1/auth/register", null, {
    email: `${name}@example.com`,
    password: "correct horse battery",
    name,
    ...(invite ? { invite_token: invite } : {}),
  });
  expect(res.status).toBe(201);
  return { token: res.body.access_token, refresh: res.body.refresh_token, id: res.body.user.id, org: res.body.org_id };
}

/** Follow a session's SSE stream until `session_update`, returning every event. */
async function streamTurn(user: User, sessionId: string, afterSeq = 0): Promise<any[]> {
  const res = await fetch(`${base}/v1/sessions/${sessionId}/events/stream?after_seq=${afterSeq}`, {
    headers: { authorization: `Bearer ${user.token}` },
  });
  expect(res.status).toBe(200);
  const events: any[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const data = buffer.slice(0, end).split("\n").find((l) => l.startsWith("data: "));
      buffer = buffer.slice(end + 2);
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      events.push(event);
      if (event.type === "session_update") return events;
    }
  }
  throw new Error("stream ended before session_update");
}

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  work = await mkdtemp(path.join(tmpdir(), "agent-base-e2e-"));
  await mkdir(path.join(work, "shared/project"), { recursive: true });
  await mkdir(path.join(work, "private"), { recursive: true });
  await writeFile(path.join(work, "private/secret.txt"), "top secret");

  gateway = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      modelRequests.push({ ...JSON.parse(body), auth: req.headers.authorization ?? "" });
      const reply = modelHandler?.(modelRequests.at(-1) as ModelRequest) ?? modelReplies.shift() ?? { content: "ok" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      setTimeout(() => {
        if (reply.tool) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${modelRequests.length}`, function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] } }] });
        }
        if (reply.content) send({ choices: [{ delta: { content: reply.content } }] });
        send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        res.end("data: [DONE]\n\n");
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`;

  const databaseUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`);
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL,
    APP_SECRET: "test-secret-test-secret-test-secret-0123",
    DATA_DIR: path.join(work, "server-data"),
    LOG_LEVEL: "silent",
    PORT: "0",
  });
  const db = new Db(databaseUrl);
  // The schema must build, tear down, and build again.
  expect(await migrateUp(db)).toEqual(["0001_init", "0002_tasks", "0003_automations", "0004_documents", "0005_notifications", "0006_session_queue", "0007_channels", "0008_channel_mode", "0009_versions_memory"]);
  expect(await migrateDown(db, 9)).toEqual(["0009_versions_memory", "0008_channel_mode", "0007_channels", "0006_session_queue", "0005_notifications", "0004_documents", "0003_automations", "0002_tasks", "0001_init"]);
  expect(await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'")).toHaveLength(0);
  expect(await migrateUp(db)).toEqual(["0001_init", "0002_tasks", "0003_automations", "0004_documents", "0005_notifications", "0006_session_queue", "0007_channels", "0008_channel_mode", "0009_versions_memory"]);
  await db.close();

  server = await buildServer(config);
  await server.ctx.pubsub.redis.flushdb();
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  server.ctx.config.PUBLIC_URL = base;

  // A real S3 service: the `minio` binary if it is installed, else the test is skipped.
  try {
    execFileSync("minio", ["--version"], { stdio: "ignore" });
    minio = spawn("minio", ["server", path.join(work, "minio"), "--address", `127.0.0.1:${MINIO_PORT}`, "--quiet"], {
      env: { ...process.env, MINIO_ROOT_USER: "minioadmin", MINIO_ROOT_PASSWORD: "minioadmin" },
      stdio: "ignore",
    });
  } catch {
    minio = null;
  }
});

afterAll(async () => {
  await host?.stop();
  await server?.close();
  gateway?.closeAllConnections();
  await new Promise((r) => gateway.close(r));
  minio?.kill("SIGKILL");
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  await rm(work, { recursive: true, force: true });
});

describe("agent-base end to end", () => {
  let alice: User;
  let bob: User;
  let carol: User;
  let providerId: string;
  let deviceId: string;
  let sessionId: string;

  it("signs up, invites a teammate, and keeps other organizations out", async () => {
    alice = await register("alice");
    carol = await register("carol");
    expect(carol.org).not.toBe(alice.org);

    const invite = await call("POST", "/v1/org/invites", alice, { email: "bob@example.com" });
    expect(invite.status).toBe(201);
    // An invite is bound to the address it was sent to.
    const stolen = await call("POST", "/v1/invites/accept", carol, { token: invite.body.token });
    expect(stolen.status).toBe(403);
    bob = await register("bob", invite.body.token);
    expect(bob.org).toBe(alice.org);
    // …and is single-use.
    expect((await call("POST", "/v1/invites/accept", bob, { token: invite.body.token })).status).toBe(400);

    const members = await call("GET", "/v1/org/members", alice);
    expect(members.body.data.map((m: any) => [m.name, m.role])).toEqual([["alice", "owner"], ["bob", "member"]]);

    expect((await call("GET", "/v1/org/members", null)).status).toBe(401);
    expect((await call("GET", "/v1/org/members", carol, undefined, alice.org)).status).toBe(403);
    expect((await call("POST", "/v1/org/invites", bob, { email: "x@example.com" })).status).toBe(403);
    // The last owner cannot step down.
    expect((await call("PATCH", `/v1/org/members/${alice.id}`, alice, { role: "member" })).body.error.code).toBe("last_owner");
    expect((await call("POST", "/v1/auth/login", null, { email: "alice@example.com", password: "wrong-password" })).status).toBe(401);
  });

  it("rotates refresh tokens (a replayed one is dead)", async () => {
    const first = await call("POST", "/v1/auth/refresh", null, { refresh_token: alice.refresh });
    expect(first.status).toBe(200);
    expect((await call("POST", "/v1/auth/refresh", null, { refresh_token: alice.refresh })).status).toBe(401);
    alice.token = first.body.access_token;
    alice.refresh = first.body.refresh_token;
    expect((await call("GET", "/v1/me", alice)).body.user.email).toBe("alice@example.com");
  });

  it("keeps library resources private until shared, and never returns secrets", async () => {
    const provider = await call("POST", "/v1/providers", alice, {
      name: "Gateway", protocol: "openai_completion", base_url: gatewayUrl, default_model: "test-model", api_key: "sk-org-secret",
    });
    expect(provider.status).toBe(201);
    providerId = provider.body.id;
    expect(provider.body.has_secret).toBe(true);
    expect(JSON.stringify(provider.body)).not.toContain("sk-org-secret");
    expect(JSON.stringify(provider.body)).not.toContain("secret_enc");
    const stored = await server.ctx.db.one<{ secret_enc: string }>("SELECT secret_enc FROM providers WHERE id = $1", [providerId]);
    expect(stored?.secret_enc).not.toContain("sk-org-secret");

    const skill = await call("POST", "/v1/skills", alice, {
      name: "Weekly Report", files: [{ path: "SKILL.md", content: "---\nname: weekly-report\ndescription: Write the weekly report\n---\nSteps…" }],
    });
    expect(skill.body.slug).toBe("weekly-report");
    expect((await call("POST", "/v1/skills", alice, { name: "x", files: [{ path: "../SKILL.md", content: "" }] })).status).toBe(400);

    const connector = await call("POST", "/v1/connectors", alice, {
      name: "Tracker", config: { transport: "http", url: "https://mcp.example.com/mcp" }, secrets: { authorization: "Bearer mcp-secret" },
    });
    expect(connector.status).toBe(201);
    expect(JSON.stringify(connector.body)).not.toContain("mcp-secret");

    const agent = await call("POST", "/v1/agents", alice, {
      name: "Analyst", runtime: "valuz_agent", provider_id: providerId, instructions: "You are the analyst.", skills: ["weekly-report"],
    });
    expect(agent.status).toBe(201);
    expect((await call("POST", "/v1/agents", alice, { name: "Bad", skills: ["nope"] })).body.error.code).toBe("skill_unavailable");

    // Private by default: a teammate sees nothing.
    expect((await call("GET", "/v1/agents", bob)).body.data).toEqual([]);
    expect((await call("GET", "/v1/agents/analyst", bob)).status).toBe(404);
    expect((await call("GET", "/v1/providers", bob)).body.data).toEqual([]);

    // Share with the whole org at `use`: visible and runnable, not editable.
    expect((await call("PUT", "/v1/agents/analyst/shares", alice, { principal_type: "org", permission: "use" })).status).toBe(200);
    expect((await call("GET", "/v1/agents", bob)).body.data.map((a: any) => [a.slug, a.permission])).toEqual([["analyst", "use"]]);
    expect((await call("PATCH", "/v1/agents/analyst", bob, { name: "Hacked" })).status).toBe(403);
    expect((await call("PUT", "/v1/agents/analyst/shares", bob, { principal_type: "org", permission: "edit" })).status).toBe(403);
    expect((await call("DELETE", "/v1/agents/analyst", bob)).status).toBe(403);

    // A team grant at `edit` wins over the org grant.
    const team = await call("POST", "/v1/org/teams", alice, { name: "Research" });
    await call("PUT", `/v1/org/teams/${team.body.id}/members`, alice, { user_ids: [bob.id] });
    await call("PUT", "/v1/agents/analyst/shares", alice, { principal_type: "team", principal_id: team.body.id, permission: "edit" });
    expect((await call("PATCH", "/v1/agents/analyst", bob, { description: "edited by bob" })).status).toBe(200);
    // Editing an agent does not let you attach a model channel you cannot use.
    expect((await call("PATCH", "/v1/agents/analyst", bob, { provider_id: providerId })).status).toBe(404);

    // Copying makes Bob's own agent.
    const copy = await call("POST", "/v1/agents/analyst/copy", bob);
    expect(copy.body).toMatchObject({ slug: "analyst-copy", owner_id: bob.id, permission: "admin" });

    // Another org sees none of it, and cannot be granted a share.
    expect((await call("GET", "/v1/agents", carol)).body.data).toEqual([]);
    expect((await call("PUT", "/v1/agents/analyst/shares", alice, { principal_type: "user", principal_id: carol.id, permission: "use" })).status).toBe(400);
  });

  it("links a desktop host and reports it online", async () => {
    const device = await call("POST", "/v1/devices", alice, { name: "Alice's Mac" });
    expect(device.status).toBe(201);
    deviceId = device.body.id;
    expect((await call("GET", "/v1/devices", alice)).body.data[0].online).toBe(false);

    host = new Host({
      config: {
        server_url: base, device_id: deviceId, device_token: device.body.token, owner_user_id: alice.id,
        shared_roots: [path.join(work, "shared")], allow_exec: false,
      },
      dataDir: path.join(work, "host-data"),
    });
    await host.start();
    // Presence flips on connect; the device's self-description lands with its hello.
    await until(async () => {
      const d = (await call("GET", `/v1/devices/${deviceId}`, alice)).body;
      return d.online === true && d.info.host_version !== undefined;
    }, "device online");
    const info = (await call("GET", `/v1/devices/${deviceId}`, alice)).body.info;
    expect(info.shared_roots).toEqual([path.join(work, "shared")]);
    expect(info.runtimes.map((r: any) => r.runtime)).toContain("valuz_agent");

    // A device token is not a user token, and a wrong one cannot link.
    expect((await call("GET", "/v1/me", { ...alice, token: device.body.token })).status).toBe(401);
    expect((await call("GET", "/v1/devices", bob)).body.data).toEqual([]);
  });

  it("runs a session on the device and streams it live from the cloud", async () => {
    await writeFile(path.join(work, "shared/project/data.txt"), "revenue: 42\n");
    const created = await call("POST", "/v1/sessions", alice, {
      agent_slug: "analyst", device_id: deviceId, cwd: path.join(work, "shared/project"), title: "Q3",
    });
    expect(created.status).toBe(201);
    sessionId = created.body.id;
    expect(created.body.model).toBe("test-model");
    expect(JSON.stringify(created.body)).not.toContain("sk-org-secret");

    modelReplies.push({ tool: { name: "read_file", args: { path: "data.txt" } } }, { content: "Revenue is 42." });
    const stream = streamTurn(alice, sessionId);
    const sent = await call("POST", `/v1/sessions/${sessionId}/messages`, alice, { text: "What is revenue?" });
    expect(sent.status).toBe(202);
    const events = await stream;

    expect(events.map((e) => e.type)).toEqual([
      "user_message", "turn_phase", "turn_phase", "tool_use", "tool_result", "turn_phase", "text_delta", "assistant_message",
      "usage_update", "session_idle", "session_update",
    ]);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(events.find((e) => e.type === "tool_result").data.content).toContain("revenue: 42");

    // The model credential reached the device only for the call, decrypted from the vault.
    expect(modelRequests[0]?.auth).toBe("Bearer sk-org-secret");
    const system = modelRequests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("You are the analyst.");
    expect(system).toContain("weekly-report: Write the weekly report"); // the shared skill was materialized
    expect(await readFile(path.join(work, "host-data/skills", sessionId, "skills/weekly-report/SKILL.md"), "utf8")).toContain("Steps…");

    await until(async () => (await call("GET", `/v1/sessions/${sessionId}`, alice)).body.status === "idle", "session idle");
    const messages = (await call("GET", `/v1/sessions/${sessionId}/messages`, alice)).body.data;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: "completed", assistant_message: "Revenue is 42.", input_tokens: 100, actor_name: "alice", id: sent.body.message_id });
    expect((await call("GET", `/v1/sessions/${sessionId}`, alice)).body.runtime_session_id).toBe(sessionId);

    // Paging replays exactly what the live stream delivered.
    const replay = await call("GET", `/v1/sessions/${sessionId}/events?after_seq=${seqs[3]}`, alice);
    expect(replay.body.data.map((e: any) => e.seq)).toEqual(seqs.slice(4));
  });

  it("lets a teammate take remote control only after the device is shared", async () => {
    // Before sharing: Alice's session and device do not exist for Bob.
    expect((await call("GET", `/v1/sessions/${sessionId}`, bob)).status).toBe(404);
    expect((await call("POST", `/v1/sessions/${sessionId}/messages`, bob, { text: "hi" })).status).toBe(404);
    expect((await call("POST", `/v1/devices/${deviceId}/fs/list`, bob, { path: work })).status).toBe(404);
    expect((await call("POST", "/v1/sessions", bob, { agent_slug: "analyst", device_id: deviceId, cwd: work })).status).toBe(404);

    // `use` lets Bob start his own sessions there, but not drive Alice's or browse files.
    await call("PUT", `/v1/devices/${deviceId}/shares`, alice, { principal_type: "user", principal_id: bob.id, permission: "use" });
    expect((await call("POST", `/v1/devices/${deviceId}/fs/list`, bob, { path: path.join(work, "shared") })).status).toBe(403);
    expect((await call("GET", `/v1/sessions/${sessionId}`, bob)).status).toBe(404);

    // `control` is remote control.
    await call("PUT", `/v1/devices/${deviceId}/shares`, alice, { principal_type: "user", principal_id: bob.id, permission: "control" });
    expect((await call("GET", `/v1/sessions/${sessionId}`, bob)).body.permission).toBe("control");
    expect((await call("GET", "/v1/sessions", bob)).body.data.map((s: any) => s.id)).toEqual([sessionId]);

    modelReplies.push({ content: "Continuing for Bob." });
    const lastSeq = (await call("GET", `/v1/sessions/${sessionId}/events?limit=1000`, bob)).body.next_seq;
    const stream = streamTurn(bob, sessionId, lastSeq);
    expect((await call("POST", `/v1/sessions/${sessionId}/messages`, bob, { text: "And next quarter?" })).status).toBe(202);
    const events = await stream;
    expect(events.find((e) => e.type === "assistant_message").data.text).toBe("Continuing for Bob.");
    // The thread continued: the model saw the earlier turn.
    expect(modelRequests.at(-1)?.messages.some((m) => m.content === "Revenue is 42.")).toBe(true);
    await until(async () => (await call("GET", `/v1/sessions/${sessionId}`, alice)).body.status === "idle", "session idle");
    const messages = (await call("GET", `/v1/sessions/${sessionId}/messages`, alice)).body.data;
    expect(messages.map((m: any) => m.actor_name)).toEqual(["alice", "bob"]);

    // Remote files — inside the shared folder only; the owner's machine has the last word.
    const listed = await call("POST", `/v1/devices/${deviceId}/fs/list`, bob, { path: path.join(work, "shared/project") });
    expect(listed.body.entries.map((e: any) => e.name)).toEqual(["data.txt"]);
    const written = await call("POST", `/v1/devices/${deviceId}/fs/write`, bob, { path: path.join(work, "shared/project/note.md"), content: "from bob" });
    expect(written.status).toBe(200);
    expect(await readFile(path.join(work, "shared/project/note.md"), "utf8")).toBe("from bob");
    expect((await call("POST", `/v1/devices/${deviceId}/fs/read`, bob, { path: path.join(work, "shared/project/note.md") })).body.content).toBe("from bob");

    for (const escape of [path.join(work, "private/secret.txt"), path.join(work, "shared/../private/secret.txt")]) {
      const res = await call("POST", `/v1/devices/${deviceId}/fs/read`, bob, { path: escape });
      expect([res.status, res.body.error.code]).toEqual([403, "forbidden"]);
    }
    // A symlink inside the shared folder cannot be used to climb out of it.
    await symlink(path.join(work, "private"), path.join(work, "shared/leak"));
    expect((await call("POST", `/v1/devices/${deviceId}/fs/read`, bob, { path: path.join(work, "shared/leak/secret.txt") })).status).toBe(403);
    // Commands are off until the owner enables them — but the owner may always run them.
    expect((await call("POST", `/v1/devices/${deviceId}/exec`, bob, { command: "echo hi", cwd: path.join(work, "shared") })).status).toBe(403);
    const own = await call("POST", `/v1/devices/${deviceId}/exec`, alice, { command: "echo hi", cwd: path.join(work, "private") });
    expect(own.body).toMatchObject({ exit_code: 0, output: "hi\n" });
    expect((await call("POST", `/v1/devices/${deviceId}/fs/read`, alice, { path: path.join(work, "private/secret.txt") })).body.content).toBe("top secret");

    // Every remote-control action is on the audit trail, attributed to who did it.
    const logs = (await call("GET", "/v1/org/audit-logs?limit=200", alice)).body.data;
    const bobs = logs.filter((l: any) => l.actor_name === "bob").map((l: any) => l.action);
    expect(bobs).toEqual(expect.arrayContaining(["device.fs.write", "device.fs.read", "device.exec.run", "session.remote_send"]));
    expect(JSON.stringify(logs)).not.toContain("from bob"); // file contents are not logged
    expect((await call("GET", "/v1/org/audit-logs", bob)).status).toBe(403);
  });

  it("refuses a second turn while one runs, and interrupts remotely", async () => {
    modelReplies.push({ content: "slow answer", delayMs: 3000 });
    const stream = streamTurn(alice, sessionId, (await call("GET", `/v1/sessions/${sessionId}/events?limit=1000`, alice)).body.next_seq);
    expect((await call("POST", `/v1/sessions/${sessionId}/messages`, alice, { text: "think hard" })).status).toBe(202);
    const busy = await call("POST", `/v1/sessions/${sessionId}/messages`, bob, { text: "me too" });
    expect([busy.status, busy.body.error.code]).toEqual([409, "session_busy"]);

    await new Promise((r) => setTimeout(r, 200));
    expect((await call("POST", `/v1/sessions/${sessionId}/interrupt`, bob)).body).toEqual({ interrupted: true });
    const events = await stream;
    expect(events.at(-1).data.stop_reason).toEqual({ type: "user_interrupt" });
    await until(async () => (await call("GET", `/v1/sessions/${sessionId}`, alice)).body.status === "idle", "session idle");
    const messages = (await call("GET", `/v1/sessions/${sessionId}/messages`, alice)).body.data;
    expect(messages.at(-1).status).toBe("cancelled");
  });

  it("shares a project so the team works in one place", async () => {
    const project = await call("POST", "/v1/projects", alice, {
      name: "Q3 Research", device_id: deviceId, root_path: path.join(work, "shared/project"), instructions_md: "Cite every number.",
    });
    expect(project.status).toBe(201);
    const deployed = await call("POST", `/v1/projects/${project.body.id}/agents:deploy`, alice, { agent_slugs: ["analyst"] });
    expect(deployed.body.data.map((a: any) => a.slug)).toEqual(["analyst"]);

    await call("PUT", `/v1/devices/${deviceId}/shares`, alice, { principal_type: "user", principal_id: bob.id, permission: "use" });
    expect((await call("GET", `/v1/projects/${project.body.id}`, bob)).status).toBe(404);
    await call("PUT", `/v1/projects/${project.body.id}/shares`, alice, { principal_type: "org", permission: "edit" });
    await call("PUT", `/v1/providers/${providerId}/shares`, alice, { principal_type: "org", permission: "use" });
    expect((await call("GET", "/v1/providers", bob)).body.data[0]).toMatchObject({ permission: "use", has_secret: true });

    // Bob starts a session in the shared project: device and folder come from the project.
    const session = await call("POST", "/v1/sessions", bob, { agent_slug: "analyst", project_id: project.body.id });
    expect(session.status).toBe(201);
    expect(session.body.cwd).toBe(path.join(work, "shared/project"));
    modelReplies.push({ content: "Project answer." });
    const stream = streamTurn(alice, session.body.id); // Alice watches Bob's session through the project
    expect((await call("POST", `/v1/sessions/${session.body.id}/messages`, bob, { text: "start" })).status).toBe(202);
    await stream;
    expect(modelRequests.at(-1)?.messages[0]?.content).toContain("## Project: Q3 Research\nCite every number.");
    expect(modelRequests.at(-1)?.auth).toBe("Bearer sk-org-secret"); // Bob ran on the shared key without ever seeing it
    expect((await call("GET", `/v1/sessions/${session.body.id}`, alice)).body.permission).toBe("admin");

    // A session cannot be pointed outside the shared folder: the server accepts it, the device refuses.
    const outside = await call("POST", "/v1/sessions", bob, { agent_slug: "analyst", device_id: deviceId, cwd: path.join(work, "private") });
    expect(outside.status).toBe(201);
    const denied = await call("POST", `/v1/sessions/${outside.body.id}/messages`, bob, { text: "read the secrets" });
    expect([denied.status, denied.body.error.code]).toEqual([403, "forbidden"]);
    expect((await call("GET", `/v1/sessions/${outside.body.id}`, bob)).body.status).toBe("idle");
    expect((await call("GET", `/v1/sessions/${outside.body.id}/messages`, bob)).body.data).toEqual([]);
  });

  it("stores shared files on the server disk by default", async () => {
    expect((await call("GET", "/v1/storage/config", alice)).body).toEqual({ driver: "local" });
    const created = await call("POST", "/v1/files", alice, { name: "report Q3.md", content_type: "text/markdown" });
    expect(created.status).toBe(201);
    const fileId = created.body.file.id;
    expect((await call("POST", `/v1/files/${fileId}/complete`, alice)).body.error.code).toBe("not_uploaded");

    const put = await fetch(created.body.upload.url, { method: "PUT", headers: created.body.upload.headers, body: "# Q3\nrevenue 42" });
    expect(put.status).toBe(204);
    expect((await call("POST", `/v1/files/${fileId}/complete`, alice)).body).toMatchObject({ status: "ready", size: 15 });

    expect((await call("GET", `/v1/files/${fileId}/download`, bob)).status).toBe(404);
    await call("PUT", `/v1/files/${fileId}/shares`, alice, { principal_type: "user", principal_id: bob.id, permission: "view" });
    const link = await call("GET", `/v1/files/${fileId}/download`, bob);
    expect(await (await fetch(link.body.url)).text()).toBe("# Q3\nrevenue 42");
    // A tampered link is refused.
    expect((await fetch(link.body.url.replace(/sig=.{6}/, "sig=AAAAAA"))).status).toBe(403);
    expect((await fetch(link.body.url.replace("op=get", "op=put"), { method: "PUT", body: "x" })).status).toBe(403);
  });

  it("stores files in the organization's own S3 bucket once configured", async (ctx) => {
    if (!minio) return ctx.skip();
    const endpoint = `http://127.0.0.1:${MINIO_PORT}`;
    const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" } });
    await until(() => s3.send(new CreateBucketCommand({ Bucket: "team-files" })).then(() => true, () => false), "minio ready");

    const settings = { driver: "s3", endpoint, bucket: "team-files", prefix: "agent-base", access_key_id: "minioadmin", force_path_style: true };
    expect((await call("PUT", "/v1/storage/config", bob, { ...settings, secret_access_key: "minioadmin" })).status).toBe(403);
    // A bucket the server cannot write to is rejected at save time.
    const wrong = await call("PUT", "/v1/storage/config", alice, { ...settings, secret_access_key: "wrong-secret" });
    expect([wrong.status, wrong.body.error.code]).toEqual([422, "storage_unreachable"]);
    const saved = await call("PUT", "/v1/storage/config", alice, { ...settings, secret_access_key: "minioadmin" });
    expect(saved.status).toBe(200);
    const shown = (await call("GET", "/v1/storage/config", alice)).body;
    expect(shown).toMatchObject({ driver: "s3", bucket: "team-files" });
    expect([saved.body.secret_access_key, shown.secret_access_key, shown.secret_enc]).toEqual([undefined, undefined, undefined]);

    const created = await call("POST", "/v1/files", bob, { name: "data.csv", content_type: "text/csv" });
    expect(created.body.file.driver).toBe("s3");
    expect(created.body.upload.url).toContain(`${endpoint}/team-files/agent-base/${bob.org}/`);
    const put = await fetch(created.body.upload.url, { method: "PUT", headers: created.body.upload.headers, body: "a,b\n1,2\n" });
    expect(put.status).toBe(200);
    expect((await call("POST", `/v1/files/${created.body.file.id}/complete`, bob)).body).toMatchObject({ status: "ready", size: 8 });
    const link = await call("GET", `/v1/files/${created.body.file.id}/download`, bob);
    expect(await (await fetch(link.body.url)).text()).toBe("a,b\n1,2\n");
    expect((await call("DELETE", `/v1/files/${created.body.file.id}`, bob)).status).toBe(204);
    expect((await fetch(link.body.url)).status).toBe(404);
  });

  it("delivers events exactly once across a dropped link", async () => {
    const before = (await call("GET", `/v1/sessions/${sessionId}/events?limit=1000`, alice)).body.next_seq;
    modelReplies.push({ content: "after reconnect", delayMs: 400 });
    expect((await call("POST", `/v1/sessions/${sessionId}/messages`, alice, { text: "go" })).status).toBe(202);
    // Kill the socket mid-turn; the host must reconnect and flush its outbox.
    (host.link as unknown as { socket: { terminate(): void } }).socket.terminate();
    await until(async () => {
      const events = (await call("GET", `/v1/sessions/${sessionId}/events?after_seq=${before}&limit=1000`, alice)).body.data;
      return events.some((e: any) => e.type === "session_update");
    }, "turn to finish after reconnect");
    const events = (await call("GET", `/v1/sessions/${sessionId}/events?after_seq=${before}&limit=1000`, alice)).body.data;
    const types = events.map((e: any) => e.type);
    expect(types.filter((t: string) => t === "assistant_message")).toHaveLength(1);
    expect(types.filter((t: string) => t === "session_update")).toHaveLength(1);
    expect(new Set(events.map((e: any) => e.event_uid)).size).toBe(events.length);
    await until(async () => (await call("GET", `/v1/sessions/${sessionId}`, alice)).body.status === "idle", "session idle");
    expect((await call("GET", `/v1/sessions/${sessionId}/messages`, alice)).body.data.at(-1)).toMatchObject({ status: "completed", assistant_message: "after reconnect" });
  });


  // ------------------------------------------------------------------ tasks
  describe("multi-agent tasks", () => {
    let projectId: string;
    /** Per-task lead scripts, keyed by task title; members answer from their brief. */
    const leadScripts = new Map<string, ModelReply[]>();
    const tool = (name: string, args: unknown = {}): ModelReply => ({ tool: { name: `mcp__task__${name}`, args } });
    const toolResults = (title: string): any[] =>
      (modelRequests.filter((r) => r.messages[0]?.content.includes(`### Task: ${title}`)).at(-1)?.messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => { try { return JSON.parse(m.content); } catch { return m.content; } });
    const task = async (id: string, as: User = alice) => (await call("GET", `/v1/tasks/${id}`, as)).body;
    const untilStatus = (id: string, status: string) => until(async () => (await task(id)).status === status, `task ${status}`);

    it("sets up a project team", async () => {
      for (const [name, description] of [["Researcher", "Finds facts and figures"], ["Writer", "Writes the final document"]]) {
        const created = await call("POST", "/v1/agents", alice, { name, description, runtime: "valuz_agent", provider_id: providerId });
        expect(created.status).toBe(201);
      }
      const project = await call("POST", "/v1/projects", alice, { name: "Report", device_id: deviceId, root_path: path.join(work, "shared/project") });
      projectId = project.body.id;
      // A task needs a team.
      expect((await call("POST", `/v1/projects/${projectId}/tasks`, alice, { goal: "x" })).body.error.code).toBe("no_members");
      await call("POST", `/v1/projects/${projectId}/agents:deploy`, alice, { agent_slugs: ["analyst", "researcher", "writer"] });
      expect((await call("POST", `/v1/projects/${projectId}/tasks`, alice, { goal: "x", lead_agent_slug: "analyst-copy" })).body.error.code).toBe("agent_unavailable");

      modelHandler = (req) => {
        const system = req.messages[0]?.content ?? "";
        const title = /### Task: (.+)/.exec(system)?.[1];
        if (title) return leadScripts.get(title)?.shift() ?? { content: "(lead has nothing more to say)" };
        if (!system.includes("You are a MEMBER")) return undefined;
        const brief = req.messages.map((m) => m.content).join("\n");
        if (brief.includes("key: slow")) return { content: "slow work finished", delayMs: 1500 };
        if (brief.includes("key: research")) return { content: "Research: revenue is 42." };
        if (brief.includes("asks for changes")) return { content: "Draft v2 — revenue is 42." };
        return { content: "Draft v1." };
      };
    });

    it("drives plan → dispatch → await → review → finish across a lead and two members", async () => {
      leadScripts.set("Quarterly report", [
        tool("list_members"),
        tool("dispatch", { subtask_key: "research" }), // before any plan exists
        tool("plan_task", {
          subtasks: [
            { key: "research", title: "Research", goal: "Find the revenue.", agent: "researcher", review_criteria: "States the number." },
            { key: "write", title: "Write", goal: "Write the report.", agent: "writer", depends_on: ["research"] },
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
      const created = await call("POST", `/v1/projects/${projectId}/tasks`, alice, { title: "Quarterly report", goal: "Produce the quarterly report." });
      expect(created.status).toBe(201);
      const id = created.body.id;
      expect(created.body).toMatchObject({ status: "active", lead_agent_slug: "analyst" });
      await untilStatus(id, "completed");

      const done = await task(id);
      expect(done.result).toEqual({ summary: "Report written; revenue is 42.", artifacts: ["report.md"] });
      expect(done.plan.map((n: any) => [n.key, n.status, n.attempts])).toEqual([["research", "completed", 1], ["write", "completed", 2]]);
      expect(done.unresolved).toEqual([]);
      // One lead + one run per member; the rework went back to the same writer session.
      expect(done.runs.map((r: any) => [r.kind, r.agent_slug, r.status])).toEqual([
        ["lead", "analyst", "completed"], ["subtask", "researcher", "completed"], ["subtask", "writer", "completed"],
      ]);

      // What the lead actually saw back from each tool call, in order (its last request follows the status change).
      await until(async () => toolResults("Quarterly report").length >= 14, "the lead's final request");
      const seen = toolResults("Quarterly report");
      expect(seen[0].members.map((m: any) => [m.slug, m.role_summary])).toEqual(
        expect.arrayContaining([["researcher", "Finds facts and figures"], ["writer", "Writes the final document"]]),
      );
      expect(seen[1]).toMatch(/no subtask with key "research"/);
      expect(seen[2].ready).toEqual(["research"]);
      expect(seen[3]).toMatch(/blocked on unfinished dependencies: research/);
      expect(seen[4]).toMatch(/cannot complete: unresolved subtasks remain \(research, write\)/);
      expect(seen[5]).toMatchObject({ status: "dispatched", subtask_key: "research", agent: "researcher" });
      expect(seen[6].results).toMatchObject([{ subtask_key: "research", status: "completed", summary: "Research: revenue is 42.", review_criteria: "States the number." }]);
      expect(seen[7]).toMatchObject({ status: "done", ready: ["write"] });
      expect(seen[9].results[0]).toMatchObject({ subtask_key: "write", summary: "Draft v1." });
      expect(seen[10]).toMatchObject({ status: "in_progress", session_id: seen[8].session_id });
      expect(seen[11].results[0]).toMatchObject({ subtask_key: "write", summary: "Draft v2 — revenue is 42." });
      expect(seen[13]).toMatchObject({ status: "completed" });

      // The member got a self-contained brief with the lead's acceptance bar, and no task toolkit.
      const memberRequest = modelRequests.find((r) => r.messages.some((m) => m.content?.includes("key: research")));
      expect(memberRequest?.messages[0]?.content).toContain("You are a MEMBER");
      expect(memberRequest?.messages.map((m) => m.content).join("\n")).toContain("## Acceptance criteria\nStates the number.");
      expect((memberRequest as any).tools.some((t: any) => t.function.name.startsWith("mcp__task__"))).toBe(false);

      const events = (await call("GET", `/v1/tasks/${id}/events`, alice)).body.data.map((e: any) => e.type);
      expect(events).toEqual([
        "task_drafted", "task_started", "plan_created", "subtask_dispatched", "subtask_reported", "subtask_approved",
        "subtask_dispatched", "subtask_reported", "subtask_rework", "subtask_reported", "subtask_approved", "task_completed",
      ]);

      // Teammates reach a task through its project; outsiders cannot see it.
      expect((await call("GET", `/v1/tasks/${id}`, bob)).status).toBe(404);
      await call("PUT", `/v1/projects/${projectId}/shares`, alice, { principal_type: "org", permission: "view" });
      expect((await call("GET", `/v1/tasks/${id}`, bob)).body.permission).toBe("view");
      expect((await call("POST", `/v1/tasks/${id}:inject`, bob, { text: "hi" })).status).toBe(403);
      expect((await call("GET", `/v1/tasks/${id}`, carol)).status).toBe(404);
      expect((await call("GET", `/v1/projects/${projectId}/tasks`, bob)).body.data[0]).toMatchObject({ id, subtask_count: 2, done_count: 2 });
      // The toolkit refuses anything but the lead's own token.
      const forged = await fetch(`${base}/v1/mcp/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${alice.token}` }, body: "{}" });
      expect(forged.status).toBe(401);
    });

    it("pauses a running task, resumes it, and takes a message from a teammate", async () => {
      leadScripts.set("Slow job", [
        tool("plan_task", { subtasks: [{ key: "slow", title: "Slow", goal: "Take your time.", agent: "researcher" }] }),
        tool("dispatch", { subtask_key: "slow" }),
        tool("await_members", { timeout_s: 60 }),
        // — paused inside that wait; after resume the lead is woken with the notice —
        tool("get_plan"),
        tool("dispatch", { subtask_key: "slow" }),
        tool("await_members", { timeout_s: 60 }),
        // — a teammate's message cuts that wait short —
        { content: "Let me read the new message." },
        tool("await_members", { timeout_s: 60 }),
        tool("review_subtask", { subtask_key: "slow", decision: "approve" }),
        tool("finish_task", { summary: "Closed at the user's request." }),
        { content: "Done." },
      ]);
      const id = (await call("POST", `/v1/projects/${projectId}/tasks`, alice, { title: "Slow job", goal: "Do the slow thing." })).body.id;
      /** The member is mid-turn and the lead is parked in await_members. */
      const memberWorking = async () => {
        const t = await task(id);
        const lead = modelRequests.filter((r) => r.messages[0]?.content.includes("### Task: Slow job"));
        return t.runs.some((r: any) => r.kind === "subtask" && r.session_status === "running") && lead.length >= (t.plan[0].attempts === 1 ? 3 : 6);
      };
      await until(memberWorking, "member running");
      const memberSession = (await task(id)).plan[0].latest_run_session_id;

      expect((await call("POST", `/v1/tasks/${id}:intervene`, alice, { action: "pause" })).body.status).toBe("paused");
      await until(async () => (await call("GET", `/v1/sessions/${memberSession}`, alice)).body.status === "idle", "member interrupted");
      const paused = await task(id);
      expect(paused.plan[0]).toMatchObject({ status: "paused", attempts: 1 });
      expect(paused.unresolved).toEqual(["slow"]); // parked work is still work
      expect((await call("POST", `/v1/tasks/${id}:inject`, alice, { text: "hello" })).body.error.code).toBe("task_not_active");
      expect((await call("POST", `/v1/tasks/${id}:intervene`, alice, { action: "pause" })).body.error.code).toBe("invalid_transition");
      // The interrupted member's dying turn must not be reported as a result.
      await new Promise((r) => setTimeout(r, 300));
      expect((await task(id)).plan[0].status).toBe("paused");

      expect((await call("POST", `/v1/tasks/${id}:intervene`, alice, { action: "resume" })).body.status).toBe("active");
      await until(async () => (await task(id)).plan[0].attempts === 2 && (await memberWorking()), "member re-dispatched after resume");
      // Re-dispatch reused the member's session rather than starting a stranger.
      expect((await task(id)).plan[0].latest_run_session_id).toBe(memberSession);

      // A teammate with `edit` on the project talks to the running task.
      await call("PUT", `/v1/projects/${projectId}/shares`, alice, { principal_type: "org", permission: "edit" });
      expect((await call("POST", `/v1/tasks/${id}:inject`, bob, { text: "That is enough — wrap it up." })).status).toBe(200);
      await untilStatus(id, "completed");
      const finished = await task(id);
      expect(finished.plan[0]).toMatchObject({ status: "completed", attempts: 2 });
      expect(finished.runs.filter((r: any) => r.kind === "subtask")).toHaveLength(1);
      const results = toolResults("Slow job");
      expect(results.some((r) => r?.task_status === "active" && r.ready?.includes("slow"))).toBe(true);
      // The parked await was released by the message instead of sleeping through it.
      expect(results.some((r) => r?.note?.includes("a new message is waiting"))).toBe(true);
      const leadMessages = modelRequests.filter((r) => r.messages[0]?.content.includes("### Task: Slow job")).at(-1)?.messages.map((m) => m.content).join("\n") ?? "";
      expect(leadMessages).toContain("<system_notice kind=\"task_resumed\">");
      expect(leadMessages).toContain("<user_message>\nThat is enough — wrap it up.\n</user_message>");
      expect((await call("GET", `/v1/tasks/${id}/events`, alice)).body.data.find((e: any) => e.type === "user_inject")).toMatchObject({ actor: "bob" });

      // A completed task can be reopened; a stopped one resumed; nothing leaves `abandoned`.
      const draft = (await call("POST", `/v1/projects/${projectId}/tasks`, alice, { goal: "maybe later", draft: true })).body;
      expect(draft).toMatchObject({ status: "draft", lead_session_id: null });
      expect((await call("POST", `/v1/tasks/${draft.id}:abandon`, alice)).body.status).toBe("abandoned");
      expect((await call("POST", `/v1/tasks/${draft.id}:commit`, alice)).body.error.code).toBe("invalid_transition");
    });

    it("blocks a task whose lead walks away, and reports a failed member as rework", async () => {
      leadScripts.set("Abandoned by lead", [
        tool("plan_task", { subtasks: [{ key: "only", title: "Only", agent: "writer" }] }),
        { content: "I think that is enough." },
        { content: "Still nothing to do." },
        { content: "Really, nothing." },
      ]);
      const id = (await call("POST", `/v1/projects/${projectId}/tasks`, alice, { title: "Abandoned by lead", goal: "Do it." })).body.id;
      await untilStatus(id, "blocked");
      const blocked = await task(id);
      expect(blocked.unresolved).toEqual(["only"]);
      const events = (await call("GET", `/v1/tasks/${id}/events`, alice)).body.data;
      expect(events.at(-1)).toMatchObject({ type: "task_blocked", payload: { unresolved: ["only"] } });
      // It was told twice exactly what was outstanding before the task gave up on it.
      const lead = modelRequests.filter((r) => r.messages[0]?.content.includes("### Task: Abandoned by lead")).at(-1)?.messages.map((m) => m.content).join("\n") ?? "";
      expect(lead.match(/kind="task_unfinished"/g)).toHaveLength(2);
      expect(lead).toContain("Ready to dispatch: only");

      // A member whose model call fails is not presented as a deliverable.
      const broken = await call("POST", "/v1/providers", alice, { name: "Dead", protocol: "openai_completion", base_url: "http://127.0.0.1:1/v1", default_model: "m", api_key: "k" });
      await call("POST", "/v1/agents", alice, { name: "Flaky", description: "Always fails", runtime: "valuz_agent", provider_id: broken.body.id });
      await call("POST", `/v1/projects/${projectId}/agents:deploy`, alice, { agent_slugs: ["flaky"] });
      leadScripts.set("With a failure", [
        tool("plan_task", { subtasks: [{ key: "risky", title: "Risky", agent: "flaky" }] }),
        tool("dispatch", { subtask_key: "risky" }),
        tool("await_members", { timeout_s: 30 }),
        tool("review_subtask", { subtask_key: "risky", decision: "approve" }),
        tool("finish_task", { summary: "Could not be done.", status: "stopped" }),
        { content: "Stopped." },
      ]);
      const failing = (await call("POST", `/v1/projects/${projectId}/tasks`, alice, { title: "With a failure", goal: "Try." })).body.id;
      await untilStatus(failing, "stopped");
      const seen = toolResults("With a failure");
      expect(seen[2].results[0]).toMatchObject({ subtask_key: "risky", status: "error" });
      expect(seen[2].results[0].summary).toMatch(/The member run failed/);
      const stopped = await task(failing);
      expect(stopped.plan[0]).toMatchObject({ internal_status: "done" }); // the lead chose to accept it; the record shows the failure
      expect(stopped.runs.find((r: any) => r.kind === "subtask").status).toBe("completed");
      modelHandler = null;
    });

    it("runs an automation on its schedule, on demand, and stops when paused", async () => {
      const base_ = { name: "Daily digest", agent_slug: "researcher", prompt: "Summarize today." };
      const bad = await call("POST", `/v1/projects/${projectId}/automations`, alice, { ...base_, cron: "not a cron" });
      expect([bad.status, bad.body.error.code]).toEqual([400, "invalid_cron"]);
      expect((await call("GET", `/v1/projects/${projectId}/automations`, alice)).body.data).toEqual([]);
      expect((await call("POST", `/v1/projects/${projectId}/automations`, alice, { ...base_, agent_slug: "analyst-copy", cron: "0 9 * * *" })).body.error.code).toBe("agent_unavailable");
      expect((await call("POST", `/v1/projects/${projectId}/automations`, carol, { ...base_, cron: "0 9 * * *" })).status).toBe(404);

      // Every second, so the test can watch real ticks.
      const created = await call("POST", `/v1/projects/${projectId}/automations`, alice, { ...base_, cron: "* * * * * *" });
      expect(created.status).toBe(201);
      const id = created.body.id;
      expect(created.body.next_run_at).toBeGreaterThan(Date.now() - 1000);
      const runs = async () => (await call("GET", `/v1/automations/${id}/runs`, alice)).body.data as any[];
      await until(async () => (await runs()).some((r) => r.status === "completed"), "a scheduled run to complete");
      const first = (await runs()).find((r) => r.status === "completed");
      expect(first).toMatchObject({ trigger: "schedule", summary: "ok", error: null });
      const session = (await call("GET", `/v1/sessions/${first.session_id}`, alice)).body;
      expect(session).toMatchObject({ project_id: projectId, owner_id: alice.id });
      expect(session.title).toMatch(/^Daily digest · \d{4}-/);
      expect(modelRequests.at(-1)?.messages.at(-1)?.content).toContain("Summarize today.");

      // Paused: the schedule is gone from Redis, so ticks stop.
      expect((await call("PATCH", `/v1/automations/${id}`, alice, { enabled: false })).body.next_run_at).toBeNull();
      await new Promise((r) => setTimeout(r, 1200)); // let an in-flight tick settle
      const paused = (await runs()).length;
      await new Promise((r) => setTimeout(r, 2500));
      expect((await runs()).length).toBe(paused);

      // A manual run works while paused.
      expect((await call("POST", `/v1/automations/${id}/run`, alice)).status).toBe(202);
      await until(async () => (await runs()).some((r) => r.trigger === "manual" && r.status === "completed"), "the manual run");

      // An unusable schedule is refused on update too, and the old row survives.
      expect((await call("PATCH", `/v1/automations/${id}`, alice, { cron: "nope", enabled: true })).body.error.code).toBe("invalid_cron");
      expect((await call("GET", `/v1/projects/${projectId}/automations`, bob)).body.data[0]).toMatchObject({ cron: "* * * * * *", enabled: false });
      expect((await call("DELETE", `/v1/automations/${id}`, alice)).status).toBe(204);
      expect((await call("GET", `/v1/automations/${id}/runs`, alice)).status).toBe(404);
    });
  });

  describe("knowledge base and notifications", () => {
    let kbProject: string;
    const upload = async (user: User, name: string, body: string | Uint8Array, projectId: string | null) => {
      const created = await call("POST", "/v1/files", user, { name });
      await fetch(created.body.upload.url, { method: "PUT", headers: created.body.upload.headers, body });
      await call("POST", `/v1/files/${created.body.file.id}/complete`, user);
      return call("POST", "/v1/documents", user, { file_id: created.body.file.id, project_id: projectId });
    };
    const ready = (user: User, id: string) =>
      until(async () => ["ready", "failed"].includes((await call("GET", `/v1/documents/${id}`, user)).body.status), "document parsed");

    it("parses uploads and finds passages, in English and Chinese", async () => {
      kbProject = (await call("POST", "/v1/projects", alice, { name: "KB", device_id: deviceId, root_path: path.join(work, "shared/project") })).body.id;
      await call("POST", `/v1/projects/${kbProject}/agents:deploy`, alice, { agent_slugs: ["analyst"] });

      const handbook = await upload(alice, "handbook.md", `# Travel policy\n\n${"Filler paragraph about nothing in particular. ".repeat(60)}\n\nReimbursement for hotels is capped at 800 yuan per night in tier-one cities.\n\n${"More filler text. ".repeat(80)}`, kbProject);
      expect(handbook.status).toBe(201);
      const policy = await upload(alice, "请假制度.txt", "员工每年享有十五天带薪年假。病假需要提供医院证明。", null); // org library
      await ready(alice, handbook.body.id);
      await ready(alice, policy.body.id);
      const parsed = (await call("GET", `/v1/documents/${handbook.body.id}`, alice)).body;
      expect(parsed).toMatchObject({ status: "ready", title: "handbook" });
      expect(parsed.chunk_count).toBeGreaterThan(1);
      // Reading pages through the exact extracted text.
      expect(parsed.preview).toMatchObject({ offset: 0, total_chars: parsed.text_chars, next_offset: null });
      expect(parsed.preview.text.startsWith("# Travel policy")).toBe(true);
      const page = (await call("GET", `/v1/documents/${handbook.body.id}?offset=${parsed.text_chars - 10}`, alice)).body.preview;
      expect(page.text).toBe(parsed.preview.text.slice(-10));
      expect(parsed.content).toBeUndefined(); // the full text is never shipped in a row

      const hits = (await call("GET", `/v1/documents/search?q=${encodeURIComponent("hotel reimbursement cap")}&project_id=${kbProject}`, alice)).body.data;
      expect(hits[0]).toMatchObject({ document_id: handbook.body.id, title: "handbook" });
      expect(hits[0].snippet).toContain("800 yuan per night");
      // Chinese has no spaces: a natural question still finds the passage.
      const zh = (await call("GET", `/v1/documents/search?q=${encodeURIComponent("年假有多少天")}&project_id=${kbProject}`, alice)).body.data;
      expect(zh[0]).toMatchObject({ document_id: policy.body.id });
      expect(zh[0].snippet).toContain("十五天带薪年假");
      // A LIKE wildcard in the query is a literal, not a pattern.
      expect((await call("GET", `/v1/documents/search?q=${encodeURIComponent("%%")}&project_id=${kbProject}`, alice)).body.data).toEqual([]);

      // Scope: the library is visible org-wide; a project's documents only to those who can see the project.
      const bobSees = (await call("GET", "/v1/documents", bob)).body.data.map((d: any) => d.filename);
      expect(bobSees).toEqual(["请假制度.txt"]);
      expect((await call("GET", `/v1/documents?project_id=${kbProject}`, bob)).status).toBe(404);
      expect((await call("GET", `/v1/documents/${handbook.body.id}`, bob)).status).toBe(404);
      expect((await call("DELETE", `/v1/documents/${policy.body.id}`, bob)).status).toBe(403);
      expect((await call("GET", "/v1/documents", carol)).body.data).toEqual([]);
    });

    it("parses a real Word document, and reports an unreadable file to its owner", async (ctx) => {
      let docx: Buffer;
      try {
        await writeFile(path.join(work, "memo.txt"), "Quarterly memo\n\nThe Shanghai office headcount grew to 47 engineers.\n");
        execFileSync("textutil", ["-convert", "docx", path.join(work, "memo.txt"), "-output", path.join(work, "memo.docx")], { stdio: "ignore" });
        docx = await readFile(path.join(work, "memo.docx"));
      } catch {
        return ctx.skip(); // no `textutil` (not macOS)
      }
      const memo = await upload(alice, "memo.docx", docx, kbProject);
      await ready(alice, memo.body.id);
      expect((await call("GET", `/v1/documents/${memo.body.id}`, alice)).body.status).toBe("ready");
      const hits = (await call("GET", `/v1/documents/search?q=headcount&project_id=${kbProject}`, alice)).body.data;
      expect(hits[0].snippet).toContain("47 engineers");

      expect((await upload(alice, "photo.png", "not really a png", kbProject)).body.error.code).toBe("unsupported_type");
      const broken = await upload(alice, "broken.docx", "this is not a zip archive", kbProject);
      await ready(alice, broken.body.id);
      const failed = (await call("GET", `/v1/documents/${broken.body.id}`, alice)).body;
      expect(failed.status).toBe("failed");
      expect(failed.error).toBeTruthy();
      // A failed document is never searchable, and its owner hears about it.
      await until(async () => (await call("GET", "/v1/notifications", alice)).body.data.some((n: any) => n.kind === "document_failed"), "failure notification");
      const inbox = (await call("GET", "/v1/notifications", alice)).body;
      expect(inbox.data.find((n: any) => n.kind === "document_failed")).toMatchObject({ title: "文档解析失败：broken", read_at: null });
      // Earlier work in this run left its own notices: a completed task, a blocked one, automation runs.
      expect(inbox.data.map((n: any) => n.kind)).toEqual(expect.arrayContaining(["task_completed", "task_blocked", "automation_completed"]));
      expect((await call("GET", "/v1/notifications", bob)).body.data.every((n: any) => !n.kind.startsWith("document"))).toBe(true);
      expect((await call("POST", "/v1/notifications/read-all", alice)).body.unread).toBe(0);
      expect((await call("GET", "/v1/notifications", alice)).body.unread).toBe(0);
    });

    it("gives a session the docs toolkit, scoped to what it may read", async () => {
      modelReplies.push(
        { tool: { name: "mcp__docs__doc_search", args: { query: "hotel reimbursement" } } },
        { tool: { name: "mcp__docs__list_doc_scope", args: {} } },
        { tool: { name: "mcp__docs__doc_read", args: { document_id: "00000000-0000-0000-0000-000000000000" } } },
        { content: "Hotels are capped at 800 yuan per night (handbook)." },
      );
      const session = (await call("POST", "/v1/sessions", alice, { agent_slug: "analyst", project_id: kbProject })).body;
      const stream = streamTurn(alice, session.id);
      await call("POST", `/v1/sessions/${session.id}/messages`, alice, { text: "What is the hotel cap?" });
      const events = await stream;
      const results = events.filter((e) => e.type === "tool_result").map((e) => e.data);
      expect(JSON.parse(results[0].content).results[0].snippet).toContain("800 yuan per night");
      expect(JSON.parse(results[1].content).documents.map((d: any) => [d.filename, d.scope])).toEqual(
        expect.arrayContaining([["handbook.md", "project"], ["请假制度.txt", "organization"]]),
      );
      expect(results[2]).toMatchObject({ is_error: true });
      expect(results[2].content).toMatch(/no readable document/);
      expect(modelRequests.at(-1)?.messages[0]?.content).toContain("## Knowledge base");

      // A session outside the project sees the library only — never another project's documents.
      modelReplies.push({ tool: { name: "mcp__docs__doc_search", args: { query: "hotel reimbursement" } } }, { content: "Nothing found." });
      const other = (await call("POST", "/v1/sessions", alice, { agent_slug: "analyst", device_id: deviceId, cwd: path.join(work, "shared/project") })).body;
      const otherStream = streamTurn(alice, other.id);
      await call("POST", `/v1/sessions/${other.id}/messages`, alice, { text: "hotel cap?" });
      const outside = (await otherStream).find((e) => e.type === "tool_result").data;
      expect(JSON.parse(outside.content).results).toEqual([]);
    });
  });

  it("queues messages typed during a turn and sends them in order", async () => {
    const session = (await call("POST", "/v1/sessions", alice, { agent_slug: "analyst", device_id: deviceId, cwd: path.join(work, "shared/project") })).body;
    modelReplies.push({ content: "first answer", delayMs: 700 }, { content: "second answer" }, { content: "third answer" });
    expect((await call("POST", `/v1/sessions/${session.id}/messages`, alice, { text: "one" })).status).toBe(202);
    // Mid-turn: these wait instead of being refused.
    expect((await call("POST", `/v1/sessions/${session.id}/queue`, alice, { text: "two" })).body.sent).toBe(false);
    const third = await call("POST", `/v1/sessions/${session.id}/queue`, alice, { text: "three" });
    const dropped = await call("POST", `/v1/sessions/${session.id}/queue`, alice, { text: "never mind" });
    expect((await call("GET", `/v1/sessions/${session.id}/queue`, alice)).body.data.map((q: any) => q.text)).toEqual(["two", "three", "never mind"]);
    expect((await call("DELETE", `/v1/sessions/${session.id}/queue/${dropped.body.id}`, alice)).status).toBe(204);
    expect(third.status).toBe(201);

    const messages = async () => (await call("GET", `/v1/sessions/${session.id}/messages`, alice)).body.data as any[];
    await until(async () => (await messages()).filter((m) => m.status === "completed").length === 3, "all three turns");
    expect((await messages()).map((m) => [m.user_message.text, m.assistant_message])).toEqual([
      ["one", "first answer"], ["two", "second answer"], ["three", "third answer"],
    ]);
    expect((await call("GET", `/v1/sessions/${session.id}/queue`, alice)).body.data).toEqual([]);
    // On an idle session a queued message goes straight out.
    modelReplies.push({ content: "fourth answer" });
    expect((await call("POST", `/v1/sessions/${session.id}/queue`, alice, { text: "four" })).body.sent).toBe(true);
    await until(async () => (await messages()).filter((m) => m.status === "completed").length === 4, "the fourth turn");

    // An interrupt leaves the queue waiting until someone resumes it.
    modelReplies.push({ content: "slow", delayMs: 3000 }, { content: "after resume" });
    await call("POST", `/v1/sessions/${session.id}/messages`, alice, { text: "slow one" });
    await call("POST", `/v1/sessions/${session.id}/queue`, alice, { text: "later" });
    await new Promise((r) => setTimeout(r, 200));
    await call("POST", `/v1/sessions/${session.id}/interrupt`, alice);
    await until(async () => (await call("GET", `/v1/sessions/${session.id}`, alice)).body.status === "idle", "interrupted");
    await new Promise((r) => setTimeout(r, 300));
    expect((await call("GET", `/v1/sessions/${session.id}/queue`, alice)).body.data.map((q: any) => q.text)).toEqual(["later"]);
    modelReplies.length = 0;
    modelReplies.push({ content: "after resume" });
    expect((await call("POST", `/v1/sessions/${session.id}/queue/resume`, alice)).body.sent).toBe(true);
    await until(async () => (await messages()).at(-1)?.assistant_message === "after resume", "the resumed turn");

    // Feedback is per person and can be withdrawn.
    const target = (await messages())[0].id;
    expect((await call("PUT", `/v1/sessions/${session.id}/feedback`, alice, { message_id: target, rating: "down", comment: "wrong figure" })).status).toBe(200);
    expect((await messages())[0].my_rating).toBe("down");
    await call("PUT", `/v1/sessions/${session.id}/feedback`, alice, { message_id: target, rating: null });
    expect((await messages())[0].my_rating).toBeNull();
    expect((await call("PUT", `/v1/sessions/${sessionId}/feedback`, alice, { message_id: target, rating: "up" })).status).toBe(404); // not that session's message
  });

  it("answers Feishu chats through a bot bound to an agent", async () => {
    // A stand-in for the Feishu open platform: token issuing and message sending.
    const sent: { chat: string; text: string; auth: string }[] = [];
    const endpointCalls: any[] = [];
    const platform = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        res.setHeader("content-type", "application/json");
        if (req.url?.includes("/auth/v3/tenant_access_token/internal")) {
          return res.end(JSON.stringify(body.app_secret === "good-secret" ? { code: 0, msg: "ok", tenant_access_token: "t-token", expire: 7200 } : { code: 10014, msg: "app secret invalid" }));
        }
        if (req.url?.includes("/callback/ws/endpoint")) {
          endpointCalls.push(body);
          const ok = body.AppSecret === "good-secret";
          return res.end(JSON.stringify(ok
            ? { code: 0, msg: "ok", data: { URL: `ws://127.0.0.1:${(platform.address() as AddressInfo).port}/ws?device_id=d1&service_id=s1`, ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 } } }
            : { code: 1000040345, msg: "app secret invalid" }));
        }
        if (req.url?.includes("/im/v1/messages")) {
          sent.push({ chat: body.receive_id, text: JSON.parse(body.content).text, auth: String(req.headers.authorization) });
          return res.end(JSON.stringify({ code: 0, msg: "ok", data: { message_id: `om_${sent.length}` } }));
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    // …and the long-connection gateway the SDK dials after asking for an endpoint.
    const gateway = new WebSocketServer({ server: platform, path: "/ws" });
    const live = new Set<unknown>();
    gateway.on("connection", (socket) => {
      live.add(socket);
      socket.on("close", () => live.delete(socket));
    });
    await new Promise<void>((r) => platform.listen(0, "127.0.0.1", r));
    const apiBase = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
    try {
      const project = (await call("POST", "/v1/projects", alice, { name: "Support", device_id: deviceId, root_path: path.join(work, "shared/project") })).body.id;
      await call("POST", `/v1/projects/${project}/agents:deploy`, alice, { agent_slugs: ["analyst"] });
      const base_ = { name: "客服机器人", project_id: project, agent_slug: "analyst", app_id: "cli_test", api_base: apiBase, mode: "webhook" };

      // A channel whose events cannot be authenticated is refused.
      expect((await call("POST", "/v1/channels", alice, { ...base_, app_secret: "good-secret" })).body.error.code).toBe("unverifiable_channel");
      const wrong = await call("POST", "/v1/channels", alice, { ...base_, app_id: "cli_wrong", app_secret: "bad-secret", verification_token: "vtoken" });
      expect((await call("POST", `/v1/channels/${wrong.body.id}/test`, alice)).body.error.code).toBe("channel_credentials_rejected");
      await call("DELETE", `/v1/channels/${wrong.body.id}`, alice);

      const created = await call("POST", "/v1/channels", alice, { ...base_, app_secret: "good-secret", verification_token: "vtoken" });
      expect(created.status).toBe(201);
      const channelId = created.body.id;
      expect(created.body.callback_url).toBe(`${base}/v1/channels/feishu/${channelId}/callback`);
      expect(JSON.stringify(created.body)).not.toMatch(/good-secret|vtoken|secret_enc/);
      expect((await call("POST", `/v1/channels/${channelId}/test`, alice)).body).toEqual({ ok: true });
      expect((await call("GET", `/v1/projects/${project}/channels`, bob)).status).toBe(404);

      const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${base}/v1/channels/feishu/${channelId}/callback`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      let n = 0;
      const event = (message: Record<string, unknown>, token = "vtoken", id = `ev_${++n}`) => ({
        schema: "2.0",
        header: { event_id: id, event_type: "im.message.receive_v1", token, app_id: "cli_test" },
        event: { sender: { sender_id: { open_id: "ou_1" } }, message: { message_id: `om_in_${n}`, chat_type: "p2p", message_type: "text", ...message } },
      });
      const text = (t: string) => JSON.stringify({ text: t });

      // The platform's URL check, and a forged request.
      expect(await (await post({ type: "url_verification", challenge: "abc", token: "vtoken" })).json()).toEqual({ challenge: "abc" });
      expect((await post({ type: "url_verification", challenge: "abc", token: "nope" })).status).toBe(403);
      expect((await post(event({ chat_id: "oc_1", content: text("hi") }, "forged"))).status).toBe(403);
      expect(sent).toEqual([]);

      // A direct message becomes a session; the answer goes back to the chat.
      modelReplies.push({ content: "您好，我能帮您什么？" });
      const first = event({ chat_id: "oc_1", content: text("你好") });
      expect((await post(first)).status).toBe(200);
      await until(async () => sent.length === 1, "the reply to reach the chat");
      expect(sent[0]).toEqual({ chat: "oc_1", text: "您好，我能帮您什么？", auth: "Bearer t-token" });
      // The platform redelivers the same event: it is handled once.
      await post(first);
      const sessions = async () => (await call("GET", `/v1/sessions?project_id=${project}`, alice)).body.data as any[];
      expect(await sessions()).toHaveLength(1);
      expect((await sessions())[0].title).toBe("飞书 · 客服机器人");

      // Same chat, same session — the agent keeps the thread.
      modelReplies.push({ content: "第二个回答" });
      await post(event({ chat_id: "oc_1", content: text("继续") }));
      await until(async () => sent.length === 2, "the second reply");
      expect(modelRequests.at(-1)?.messages.some((m) => m.content === "您好，我能帮您什么？")).toBe(true);
      expect(await sessions()).toHaveLength(1);

      // In a group it answers only when mentioned, and strips the mention.
      await post(event({ chat_id: "oc_group", chat_type: "group", content: text("大家好") }));
      modelReplies.push({ content: "群里的回答" });
      await post(event({ chat_id: "oc_group", chat_type: "group", content: text("@_user_1 帮我看看"), mentions: [{ key: "@_user_1", name: "客服机器人" }] }));
      await until(async () => sent.length === 3, "the group reply");
      expect(sent[2]).toMatchObject({ chat: "oc_group", text: "群里的回答" });
      expect(modelRequests.at(-1)?.messages.at(-1)?.content).toMatch(/帮我看看$/);
      expect(modelRequests.at(-1)?.messages.at(-1)?.content).not.toContain("@_user_1");
      expect(await sessions()).toHaveLength(2);

      // Things it cannot do are said in the chat rather than dropped silently.
      await post(event({ chat_id: "oc_1", message_type: "image", content: "{}" }));
      await until(async () => sent.length === 4, "the unsupported-type notice");
      expect(sent[3]?.text).toBe("目前只支持文本消息。");
      await post(event({ chat_id: "oc_1", content: text("/new") }));
      await until(async () => sent.length === 5, "the /new confirmation");
      modelReplies.push({ content: "全新的开始" });
      await post(event({ chat_id: "oc_1", content: text("重新来") }));
      await until(async () => sent.length === 6, "the reply in the fresh session");
      expect(await sessions()).toHaveLength(3);
      expect(modelRequests.at(-1)?.messages.some((m) => m.content === "第二个回答")).toBe(false);

      // With an Encrypt Key, events are encrypted and signed; a bad signature is refused.
      await call("PATCH", `/v1/channels/${channelId}`, alice, { encrypt_key: "ekey" });
      const sealed = (payload: unknown) => {
        const iv = randomBytes(16);
        const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update("ekey").digest(), iv);
        const body = { encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString("base64") };
        const signature = createHash("sha256").update(`1700000000nonce1ekey${JSON.stringify(body)}`).digest("hex");
        return { body, headers: { "x-lark-request-timestamp": "1700000000", "x-lark-request-nonce": "nonce1", "x-lark-signature": signature } };
      };
      modelReplies.push({ content: "加密通道的回答" });
      const enc = sealed(event({ chat_id: "oc_1", content: text("加密的消息") }));
      expect((await post(enc.body, { ...enc.headers, "x-lark-signature": "0".repeat(64) })).status).toBe(403);
      expect((await post(event({ chat_id: "oc_1", content: text("明文绕过") }))).status).toBe(403); // unsigned plaintext no longer accepted
      expect((await post(enc.body, enc.headers)).status).toBe(200);
      await until(async () => sent.length === 7, "the reply over the encrypted channel");
      expect(sent[6]?.text).toBe("加密通道的回答");

      // Long connection: no public URL and no token needed — the server dials the platform itself.
      expect((await call("POST", "/v1/channels", alice, { name: "x", project_id: project, agent_slug: "analyst", app_id: "cli_ws", app_secret: "good-secret", api_base: apiBase })).body.error.code).toBe("invalid_app_id");
      const ws = await call("POST", "/v1/channels", alice, { name: "长连接机器人", project_id: project, agent_slug: "analyst", app_id: "cli_a1b2c3d4e5f6a7b8", app_secret: "good-secret", api_base: apiBase });
      expect(ws.status).toBe(201);
      expect(ws.body).toMatchObject({ mode: "websocket", callback_url: null });
      await until(async () => live.size === 1, "the long connection to open");
      expect(endpointCalls.at(-1)).toMatchObject({ AppID: "cli_a1b2c3d4e5f6a7b8", AppSecret: "good-secret" });
      // Its webhook URL does not exist: events only arrive over the connection.
      const direct = await fetch(`${base}/v1/channels/feishu/${ws.body.id}/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event({ chat_id: "oc_9", content: text("hi") })) });
      expect([direct.status, ((await direct.json()) as any).error.code]).toEqual([409, "not_a_webhook_channel"]);
      // Disabling hangs up; enabling dials again; deleting hangs up for good.
      await call("PATCH", `/v1/channels/${ws.body.id}`, alice, { enabled: false });
      await until(async () => live.size === 0, "the connection to close when disabled");
      await call("PATCH", `/v1/channels/${ws.body.id}`, alice, { enabled: true });
      await until(async () => live.size === 1, "the connection to reopen");
      await call("DELETE", `/v1/channels/${ws.body.id}`, alice);
      await until(async () => live.size === 0, "the connection to close when deleted");

      // A disabled channel stops answering.
      await call("PATCH", `/v1/channels/${channelId}`, alice, { enabled: false });
      const off = sealed(event({ chat_id: "oc_1", content: text("还在吗") }));
      expect((await post(off.body, off.headers)).status).toBe(404);
    } finally {
      gateway.close();
      platform.closeAllConnections();
      await new Promise((r) => platform.close(r));
    }
  });

  it("keeps every version of a skill and restores one as a new version", async () => {
    const v1 = "---\nname: weekly-report\ndescription: Write the weekly report\n---\nSteps…";
    const v2 = v1.replace("Steps…", "Steps, revised.");
    expect((await call("PATCH", "/v1/skills/weekly-report", alice, { files: [{ path: "SKILL.md", content: v2 }] })).body.version).toBe(2);
    // A rename alone is not a new version of the content.
    expect((await call("PATCH", "/v1/skills/weekly-report", alice, { description: "Weekly report writer" })).body.version).toBe(2);
    const history = (await call("GET", "/v1/skills/weekly-report/versions", alice)).body;
    expect(history.current).toBe(2);
    expect(history.data.map((v: any) => [v.version, v.created_by_name])).toEqual([[2, "alice"], [1, "alice"]]);
    expect((await call("GET", "/v1/skills/weekly-report/versions/1", alice)).body.files[0].content).toBe(v1);

    const restored = (await call("POST", "/v1/skills/weekly-report/versions/1/restore", alice)).body;
    expect(restored.version).toBe(3);
    expect(restored.files[0].content).toBe(v1);
    // History only grows: version 2 is still there.
    expect((await call("GET", "/v1/skills/weekly-report/versions/2", alice)).body.files[0].content).toBe(v2);
    expect((await call("GET", "/v1/skills/weekly-report/versions/9", alice)).status).toBe(404);
    expect((await call("GET", "/v1/skills/weekly-report/versions", carol)).status).toBe(404);
  });

  it("moves agents between organizations as a pack, without credentials", async () => {
    expect((await call("POST", "/v1/agent-packs/export", alice, { agent_slugs: ["nope"] })).status).toBe(404);
    const pack = (await call("POST", "/v1/agent-packs/export", alice, { agent_slugs: ["analyst", "researcher"] })).body;
    expect(pack.format).toBe("agent-base.pack/v1");
    expect(pack.agents.map((a: any) => a.slug).sort()).toEqual(["analyst", "researcher"]);
    expect(pack.skills.map((k: any) => k.slug)).toEqual(["weekly-report"]);
    // No model channel, no keys, no ids from the source organization.
    expect(JSON.stringify(pack)).not.toMatch(/sk-org-secret|provider_id|secret_enc|owner_id|org_id/);

    const imported = await call("POST", "/v1/agent-packs/import", carol, { pack });
    expect(imported.status).toBe(201);
    expect(imported.body.created.sort()).toEqual(["agent:analyst", "agent:researcher", "skill:weekly-report"]);
    expect(imported.body.needs_attention).toEqual(expect.arrayContaining(['agent "analyst" needs a model channel before it can run']));
    const carols = (await call("GET", "/v1/agents", carol)).body.data;
    expect(carols.map((a: any) => [a.slug, a.owner_id, a.provider_id, a.skills]).sort()).toEqual([
      ["analyst", carol.id, null, ["weekly-report"]], ["researcher", carol.id, null, []],
    ]);
    expect((await call("GET", "/v1/skills/weekly-report/versions", carol)).body.data).toHaveLength(1);
    // Importing again changes nothing.
    const again = (await call("POST", "/v1/agent-packs/import", carol, { pack })).body;
    expect([again.created, again.skipped.length]).toEqual([[], 3]);
    // A tampered pack cannot smuggle a path out of a skill bundle.
    const evil = structuredClone(pack);
    evil.skills[0].slug = "evil";
    evil.skills[0].files.push({ path: "../../escape", content: "x" });
    expect((await call("POST", "/v1/agent-packs/import", carol, { pack: evil })).status).toBe(400);
  });

  it("carries project memory into later sessions and lets a chat agent start a task", async () => {
    const project = (await call("POST", "/v1/projects", alice, { name: "Memory", device_id: deviceId, root_path: path.join(work, "shared/project") })).body.id;
    await call("POST", `/v1/projects/${project}/agents:deploy`, alice, { agent_slugs: ["analyst", "researcher"] });
    expect((await call("POST", `/v1/projects/${project}/memory`, alice, { content: "The client prefers metric units." })).status).toBe(201);
    expect((await call("POST", `/v1/projects/${project}/memory`, carol, { content: "x" })).status).toBe(404);

    // The agent records a fact, and starts a task for the team, from an ordinary chat.
    modelHandler = (req) => {
      const system = req.messages[0]?.content ?? "";
      if (system.includes("### Task: Collect figures")) {
        const done = req.messages.filter((m) => m.role === "tool").length;
        return done === 0 ? { tool: { name: "mcp__task__finish_task", args: { summary: "Figures collected." } } } : { content: "Closed." };
      }
      return undefined;
    };
    modelReplies.push(
      { tool: { name: "mcp__project__remember", args: { content: "Reports are due every Friday." } } },
      { tool: { name: "mcp__project__remember", args: { content: "Reports are due every Friday." } } },
      { tool: { name: "mcp__project__create_task", args: { goal: "Collect the quarterly figures.", title: "Collect figures", lead_agent: "researcher" } } },
      { tool: { name: "mcp__project__create_task", args: { goal: "x", lead_agent: "nobody" } } },
      { content: "Noted, and the team is on it." },
    );
    const session = (await call("POST", "/v1/sessions", alice, { agent_slug: "analyst", project_id: project })).body;
    const stream = streamTurn(alice, session.id);
    await call("POST", `/v1/sessions/${session.id}/messages`, alice, { text: "Remember the deadline and get the figures collected." });
    const results = (await stream).filter((e) => e.type === "tool_result").map((e) => e.data);
    expect(JSON.parse(results[0].content)).toEqual({ remembered: true });
    expect(JSON.parse(results[1].content).remembered).toBe(false); // already known
    const started = JSON.parse(results[2].content);
    // (this scripted lead finishes at once, so the task may already be done when the tool returns)
    expect(started.lead_agent).toBe("researcher");
    expect(["active", "completed"]).toContain(started.status);
    expect(results[3]).toMatchObject({ is_error: true });
    expect(results[3].content).toMatch(/"nobody" is not a member of this project/);
    await until(async () => (await call("GET", `/v1/tasks/${started.task_id}`, alice)).body.status === "completed", "the chat-started task");
    expect((await call("GET", `/v1/projects/${project}/tasks`, alice)).body.data[0]).toMatchObject({ title: "Collect figures", owner_id: alice.id });
    modelHandler = null;

    const memory = (await call("GET", `/v1/projects/${project}/memory`, alice)).body.data;
    expect(memory.map((m: any) => [m.content, m.source])).toEqual([["The client prefers metric units.", "user"], ["Reports are due every Friday.", "agent"]]);

    // A brand-new session of the project starts out knowing both facts.
    modelReplies.push({ content: "ok" });
    const next = (await call("POST", "/v1/sessions", alice, { agent_slug: "analyst", project_id: project })).body;
    const second = streamTurn(alice, next.id);
    await call("POST", `/v1/sessions/${next.id}/messages`, alice, { text: "hello" });
    await second;
    const system = modelRequests.at(-1)?.messages[0]?.content ?? "";
    expect(system).toContain("## Project memory");
    expect(system).toContain("- The client prefers metric units.\n- Reports are due every Friday.");
    // A forgotten fact is gone from the next turn.
    await call("DELETE", `/v1/projects/${project}/memory/${memory[0].id}`, alice);
    modelReplies.push({ content: "ok" });
    const third = streamTurn(alice, next.id, (await call("GET", `/v1/sessions/${next.id}/events?limit=1000`, alice)).body.next_seq);
    await call("POST", `/v1/sessions/${next.id}/messages`, alice, { text: "again" });
    await third;
    expect(modelRequests.at(-1)?.messages[0]?.content).not.toContain("metric units");
  });

  it("forks a session: same history, separate futures", async () => {
    const source = (await call("POST", "/v1/sessions", alice, { agent_slug: "analyst", device_id: deviceId, cwd: path.join(work, "shared/project"), title: "Pricing" })).body;
    expect((await call("POST", `/v1/sessions/${source.id}/fork`, alice)).body.error.code).toBe("nothing_to_fork");
    modelReplies.push({ content: "The base price is 100." });
    let done = streamTurn(alice, source.id);
    await call("POST", `/v1/sessions/${source.id}/messages`, alice, { text: "What is the base price?" });
    await done;
    await until(async () => (await call("GET", `/v1/sessions/${source.id}`, alice)).body.status === "idle", "source idle");

    const fork = (await call("POST", `/v1/sessions/${source.id}/fork`, alice)).body;
    expect(fork).toMatchObject({ title: "Pricing（分叉）", runtime_session_id: null, status: "idle", device_id: deviceId });
    // The fork shows the conversation it was branched from…
    const copied = (await call("GET", `/v1/sessions/${fork.id}/messages`, alice)).body.data;
    expect(copied.map((m: any) => [m.user_message.text, m.assistant_message])).toEqual([["What is the base price?", "The base price is 100."]]);
    const types = (await call("GET", `/v1/sessions/${fork.id}/events?limit=1000`, alice)).body.data.map((e: any) => e.type);
    expect(types.slice(0, 2)).toEqual(["user_message", "turn_phase"]);
    expect(types).toContain("assistant_message");

    // …and the model, on the fork's first turn, remembers it.
    modelReplies.push({ content: "With the discount it is 80." });
    done = streamTurn(alice, fork.id, (await call("GET", `/v1/sessions/${fork.id}/events?limit=1000`, alice)).body.next_seq);
    await call("POST", `/v1/sessions/${fork.id}/messages`, alice, { text: "Apply a 20% discount." });
    await done;
    const forkRequest = modelRequests.at(-1)?.messages.map((m) => m.content) ?? [];
    expect(forkRequest).toContain("The base price is 100.");
    await until(async () => (await call("GET", `/v1/sessions/${fork.id}`, alice)).body.runtime_session_id === fork.id, "the fork's own thread");

    // The source went nowhere: its next turn knows nothing of the fork's.
    modelReplies.push({ content: "Still 100." });
    done = streamTurn(alice, source.id, (await call("GET", `/v1/sessions/${source.id}/events?limit=1000`, alice)).body.next_seq);
    await call("POST", `/v1/sessions/${source.id}/messages`, alice, { text: "And now?" });
    await done;
    const sourceRequest = modelRequests.at(-1)?.messages.map((m) => m.content) ?? [];
    expect(sourceRequest).toContain("The base price is 100.");
    expect(sourceRequest).not.toContain("With the discount it is 80.");
    expect((await call("GET", `/v1/sessions/${source.id}/messages`, alice)).body.data).toHaveLength(2);
    expect((await call("GET", `/v1/sessions/${fork.id}/messages`, alice)).body.data).toHaveLength(2);
    expect((await call("POST", `/v1/sessions/${source.id}/fork`, carol)).status).toBe(404);
  });

  it("serves a device linked to another replica through Redis", async () => {
    // A second server process-equivalent on the same Postgres + Redis; the host is linked to the first.
    const replica = await buildServer({ ...server.ctx.config });
    await replica.app.listen({ host: "127.0.0.1", port: 0 });
    const first = base;
    try {
      base = `http://127.0.0.1:${(replica.app.server.address() as AddressInfo).port}`;
      expect((await call("GET", `/v1/devices/${deviceId}`, alice)).body.online).toBe(true);
      // RPC: replica B → Redis → replica A → device → back.
      const listed = await call("POST", `/v1/devices/${deviceId}/fs/list`, alice, { path: path.join(work, "private") });
      expect(listed.body.entries.map((e: any) => e.name)).toEqual(["secret.txt"]);
      const denied = await call("POST", `/v1/devices/${deviceId}/fs/read`, bob, { path: path.join(work, "private/secret.txt") });
      expect(denied.status).toBe(403); // bob sees the device (`use`) but may not control it

      // A turn dispatched through B, streamed from B, while events are ingested by A.
      modelReplies.push({ content: "via replica" });
      const after = (await call("GET", `/v1/sessions/${sessionId}/events?limit=1000`, alice)).body.next_seq;
      const stream = streamTurn(alice, sessionId, after);
      expect((await call("POST", `/v1/sessions/${sessionId}/messages`, alice, { text: "hello from B" })).status).toBe(202);
      const events = await stream;
      expect(events.find((e) => e.type === "assistant_message").data.text).toBe("via replica");
      await until(async () => (await call("GET", `/v1/sessions/${sessionId}`, alice)).body.status === "idle", "session idle");
    } finally {
      base = first;
      await replica.close();
    }
  });

  it("cuts access when a member leaves and when a device is revoked", async () => {
    expect((await call("DELETE", `/v1/org/members/${bob.id}`, alice)).status).toBe(204);
    expect((await call("GET", "/v1/agents", bob)).body.error.code).toBe("no_organization");
    const shares = await server.ctx.db.query("SELECT 1 FROM resource_shares WHERE principal_type = 'user' AND principal_id = $1", [bob.id]);
    expect(shares).toHaveLength(0);

    expect((await call("DELETE", `/v1/devices/${deviceId}`, alice)).status).toBe(204);
    await until(async () => !host.link.online, "link dropped");
    expect((await call("GET", "/v1/devices", alice)).body.data).toEqual([]);
    const sent = await call("POST", `/v1/sessions/${sessionId}/messages`, alice, { text: "anyone there?" });
    expect([sent.status, sent.body.error.code]).toEqual([503, "device_offline"]);
    // The failed dispatch left no ghost turn behind.
    expect((await call("GET", `/v1/sessions/${sessionId}`, alice)).body.status).toBe("idle");
  });
});
