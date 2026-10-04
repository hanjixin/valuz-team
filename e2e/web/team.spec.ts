import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Page, expect, test } from "@playwright/test";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/host/dist/cli.js");
const run = promisify(execFile);
const password = "e2e-password-1";

/**
 * Open a settings section. A new member may be offered the first-run tour
 * instead; these tests are not about it, so it is skipped and the page reopened.
 */
const openSettings = async (page: Page, section: string) => {
  const entry = page.getByText(section, { exact: true }).first();
  const skip = page.getByRole("button", { name: "跳过引导" });
  await page.goto("/settings");
  await expect(entry.or(skip)).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.goto("/settings");
  }
  await entry.click();
};

/**
 * The collaboration story in the browser: invite a colleague, share a linked
 * computer with them, and have them reach into it — only as far as its owner allowed.
 */
test("a colleague is invited, a desktop is shared with them, and they browse its shared folder", async ({
  browser,
  request,
  baseURL,
}) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "ab-team-")));
  const shared = path.join(home, "shared");
  await mkdir(path.join(shared, "reports"), { recursive: true });
  await writeFile(path.join(shared, "plan.md"), "# plan");
  const env = { ...process.env, AGENT_BASE_HOME: home, AGENT_BASE_PASSWORD: password };
  let host: ChildProcess | undefined;
  const ownerContext = await browser.newContext();
  const mateContext = await browser.newContext();
  try {
    // The owner signs up in the browser and links their computer, sharing one folder of it.
    const owner = await ownerContext.newPage();
    await owner.goto("/");
    await owner.getByRole("tab", { name: /注册|Create account/ }).click();
    await owner.locator("#auth-name").fill("Olivia");
    await owner.locator("#auth-email").fill("olivia@example.com");
    await owner.locator("#auth-password").fill(password);
    await owner.locator("button[type=submit]").click();
    await expect(owner.locator("#auth-email")).toHaveCount(0);

    await run(
      process.execPath,
      [cli, "login", "--server", baseURL as string, "--email", "olivia@example.com", "--name", "Olivia's Mac"],
      { env },
    );
    await run(process.execPath, [cli, "share", "add", shared], { env });
    host = spawn(process.execPath, [cli, "run"], { env, stdio: "ignore" });

    // Invite a colleague from Settings → Organization.
    await openSettings(owner, "组织与成员");
    await owner.getByPlaceholder("同事的邮箱").fill("marco@example.com");
    await owner.getByRole("button", { name: "发送邀请" }).click();
    const link = await owner.getByTestId("invite-link").innerText();
    expect(link).toContain("/?invite=inv_");

    // The colleague opens the link, registers, and is in the same organization.
    const mate = await mateContext.newPage();
    await mate.goto(link);
    await mate.locator("#auth-name").fill("Marco");
    await mate.locator("#auth-email").fill("marco@example.com");
    await mate.locator("#auth-password").fill(password);
    await mate.locator("button[type=submit]").click();
    await expect(mate.locator("#auth-email")).toHaveCount(0);
    await openSettings(owner, "组织与成员");
    await expect(owner.getByRole("cell", { name: "marco@example.com" })).toBeVisible();

    // Until it is shared, the colleague sees no device.
    await openSettings(mate, "设备");
    await expect(mate.getByText("还没有链接任何设备")).toBeVisible();

    // The owner sees their computer online and shares it for remote control.
    await openSettings(owner, "设备");
    await expect(owner.getByText("Olivia's Mac")).toBeVisible();
    await expect(owner.getByText("在线", { exact: true })).toBeVisible({ timeout: 15_000 });
    // (The settings navigation has an entry of the same name; the device's own button is in the page body.)
    await owner.locator("button[data-slot=button]", { hasText: /^共享$/ }).click();
    const dialog = owner.getByRole("dialog");
    await dialog.locator("#share-with").selectOption("user");
    await dialog.getByLabel("成员", { exact: true }).selectOption({ label: "Marco · marco@example.com" });
    await dialog.getByLabel("角色").selectOption("control");
    await dialog.getByRole("button", { name: "共享", exact: true }).click();
    await expect(dialog.getByText("Marco", { exact: true })).toBeVisible();
    await expect(dialog.getByText("可远程控制").last()).toBeVisible();

    // The colleague now sees it, opens its shared folder, and walks into a subfolder…
    await openSettings(mate, "设备");
    await expect(mate.getByText("Olivia's Mac")).toBeVisible();
    await mate.getByRole("button", { name: "浏览文件" }).click();
    const files = mate.getByRole("dialog");
    await files.getByRole("button", { name: "打开", exact: true }).click();
    await expect(files.getByTestId("device-files")).toContainText("plan.md");
    await files.getByRole("button", { name: /reports/ }).click();
    await expect(files.getByLabel("目录路径")).toHaveValue(path.join(shared, "reports"));

    // …but not out of it: the device's owner decides, and the server cannot overrule them.
    await files.getByLabel("目录路径").fill(home);
    await files.getByRole("button", { name: "打开", exact: true }).click();
    await expect(files.getByRole("alert")).toContainText("outside the folders the device owner has shared");
    await mate.screenshot({ path: "test-results/team-remote.png", fullPage: true });

    // The whole exchange is in the organization's audit trail.
    const login = await (
      await request.post("/v1/auth/login", { data: { email: "olivia@example.com", password } })
    ).json();
    const logs = await (
      await request.get("/v1/org/audit-logs?limit=100", { headers: { authorization: `Bearer ${login.access_token}` } })
    ).json();
    const actions = logs.logs.map((log: { action: string }) => log.action);
    expect(actions).toEqual(expect.arrayContaining(["invite.create", "member.join", "share.grant", "device.fs.list"]));
  } finally {
    host?.kill("SIGKILL");
    await ownerContext.close();
    await mateContext.close();
    await rm(home, { recursive: true, force: true });
  }
});
