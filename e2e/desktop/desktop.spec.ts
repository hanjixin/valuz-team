import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, test } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, "../../apps/desktop");
const hostCli = path.resolve(here, "../../apps/host/dist/cli.js");
const SERVER = "http://127.0.0.1:18790";

/**
 * A new desktop, start to finish: it asks which server it belongs to, the
 * member signs in, links this computer, and a conversation typed in the app is
 * answered by an agent running here — under the host the app itself keeps
 * running. Nothing is stood in for but the model.
 */
test("a new desktop connects to the team's server, links this computer, and runs a conversation on it", async ({
  request,
}) => {
  const userData = await realpath(await mkdtemp(path.join(tmpdir(), "ab-desktop-")));
  // The member and their model channel exist on the server already.
  const account = await (
    await request.post("/v1/auth/register", {
      data: { email: "desk@example.com", password: "e2e-password-1", name: "Desk" },
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

  const env = { ...process.env, AGENT_BASE_HOST_CLI: hostCli } as Record<string, string>;
  delete env["AGENT_BASE_SERVER_URL"];
  delete env["VITE_DEV_SERVER_URL"];
  const app = await _electron.launch({ args: [appPath, `--user-data-dir=${userData}`], cwd: appPath, env });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // 1. Which server? A wrong address is refused with a reason; the right one is taken.
    await expect(page.getByTestId("connect-screen")).toBeVisible();
    const address = page.getByTestId("connect-screen").locator("input");
    await address.fill("http://127.0.0.1:9");
    await page.getByTestId("connect-screen").locator("button[type=submit]").click();
    await expect(page.getByText(/no agent-base server answers/)).toBeVisible();
    await address.fill(SERVER);
    await page.getByTestId("connect-screen").locator("button[type=submit]").click();

    // 2. Sign in — against that server, through the app's own local address.
    await page.locator("#auth-email").fill("desk@example.com");
    await page.locator("#auth-password").fill("e2e-password-1");
    await page.evaluate(() => localStorage.setItem("valuz-onboarded", "1"));
    await page.locator("button[type=submit]").click();
    await expect(page.locator("#auth-email")).toHaveCount(0);

    // 3. Link this computer from Settings → Devices; the app starts the host and it connects.
    await page.evaluate(() => (window.location.hash = "#/settings"));
    await page.getByRole("button", { name: "设备" }).click();
    const computer = page.getByTestId("this-computer");
    await expect(computer.getByText("未链接")).toBeVisible();
    await computer.getByRole("button", { name: "链接这台电脑" }).click();
    await expect(computer.getByText("已连接")).toBeVisible({ timeout: 30_000 });
    const devices = (await (await request.get("/v1/devices", { headers })).json()).devices as {
      online: boolean;
      owner_id: string;
    }[];
    expect(devices).toHaveLength(1);
    expect(devices[0]?.online).toBe(true);

    // 4. A conversation typed here is answered by an agent running on this computer.
    await page.evaluate(() => (window.location.hash = "#/conversation/new"));
    const composer = page.locator("textarea, [contenteditable=true]").first();
    await composer.click();
    await composer.fill("What is six times seven?");
    await page.keyboard.press("Enter");
    await expect(page.getByText("The answer is forty-two.").first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "test-results/desktop-conversation.png" });
    const sessions = (await (await request.get("/v1/sessions", { headers })).json()).sessions as { status: string }[];
    expect(sessions).toHaveLength(1);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
