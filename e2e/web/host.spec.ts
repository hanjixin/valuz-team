import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/host/dist/cli.js");
const run = promisify(execFile);

/** The built host CLI, as a user would run it: link a machine, then reach it through the server. */
test("the host CLI links this machine and the server can reach its files", async ({ request, baseURL }) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "ab-host-")));
  const env = { ...process.env, AGENT_BASE_HOME: home, AGENT_BASE_PASSWORD: "e2e-password-1" };
  let host: ChildProcess | undefined;
  try {
    const account = await request.post("/v1/auth/register", {
      data: { email: "host-owner@example.com", password: env.AGENT_BASE_PASSWORD, name: "Host owner" },
    });
    const headers = { authorization: `Bearer ${(await account.json()).access_token}` };

    const login = await run(
      process.execPath,
      [cli, "login", "--server", baseURL as string, "--email", "host-owner@example.com", "--name", "E2E box"],
      { env },
    );
    expect(login.stdout).toContain("linked as device");
    // The config holds the device token, so only its owner may read it.
    expect((await stat(path.join(home, "host.json"))).mode & 0o777).toBe(0o600);
    const status = JSON.parse((await run(process.execPath, [cli, "status"], { env })).stdout);
    expect(status).toMatchObject({ device_token: "<hidden>", shared_roots: [], allow_exec: false });

    host = spawn(process.execPath, [cli, "run"], { env, stdio: "ignore" });
    await expect
      .poll(async () => (await (await request.get(`/v1/devices/${status.device_id}`, { headers })).json()).online)
      .toBe(true);

    await writeFile(path.join(home, "note.txt"), "read through the link");
    const read = await request.post(`/v1/devices/${status.device_id}/fs/read`, {
      headers,
      data: { path: path.join(home, "note.txt") },
    });
    expect(await read.json()).toMatchObject({ content: "read through the link", encoding: "utf8" });

    host.kill("SIGTERM");
    await expect
      .poll(async () => (await (await request.get(`/v1/devices/${status.device_id}`, { headers })).json()).online)
      .toBe(false);
  } finally {
    host?.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});
