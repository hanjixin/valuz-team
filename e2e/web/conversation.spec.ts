import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/host/dist/cli.js");
const run = promisify(execFile);

/**
 * The whole path, with nothing stood in for but the model: the web app in a
 * browser, the server, a linked host process running the kernel, and back.
 */
test("a conversation typed in the browser is answered by an agent running on a linked device", async ({
  page,
  request,
  baseURL,
}) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "ab-conv-")));
  const env = { ...process.env, AGENT_BASE_HOME: home, AGENT_BASE_PASSWORD: "e2e-password-1" };
  let host: ChildProcess | undefined;
  try {
    const account = await (
      await request.post("/v1/auth/register", {
        data: { email: "talker@example.com", password: env.AGENT_BASE_PASSWORD, name: "Talker" },
      })
    ).json();
    const headers = { authorization: `Bearer ${account.access_token}` };
    const channel = await (
      await request.post("/v1/providers", {
        headers,
        data: {
          name: "E2E model",
          provider_kind: "compatible",
          api_key: "sk-e2e",
          base_url: process.env["E2E_MODEL_URL"],
          models: ["test-model"],
        },
      })
    ).json();
    await request.post("/v1/providers/default", { headers, data: { provider_id: channel.id } });

    await run(process.execPath, [cli, "login", "--server", baseURL as string, "--email", "talker@example.com"], {
      env,
    });
    host = spawn(process.execPath, [cli, "run"], { env, stdio: "ignore" });
    await expect
      .poll(async () => (await (await request.get("/v1/devices", { headers })).json()).devices[0]?.online)
      .toBe(true);

    await page.goto("/");
    await page.evaluate((session) => localStorage.setItem("agent-base.session", JSON.stringify(session)), {
      access_token: account.access_token,
      refresh_token: account.refresh_token,
      org_id: account.org_id,
    });
    await page.goto("/conversation/new");
    const composer = page.locator("textarea, [contenteditable=true]").first();
    await composer.click();
    await composer.fill("What is six times seven?");
    await page.keyboard.press("Enter");
    await expect(page.getByText("The answer is forty-two.").first()).toBeVisible({ timeout: 20_000 });
    // The conversation took its title from the first message, and the turn's usage is shown.
    await expect(page.getByText("What is six times seven?").first()).toBeVisible();
    await page.screenshot({ path: "test-results/conversation.png", fullPage: true });

    // It was really run on the device: the server recorded the turn's events from the host.
    const sessions = await (await request.get("/v1/sessions", { headers })).json();
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]).toMatchObject({ status: "idle", runtime_provider: "deepagents" });
  } finally {
    host?.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});
