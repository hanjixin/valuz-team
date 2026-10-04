import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("a member sees and switches their memory settings in the app", async ({ page, request }) => {
  const account = await register(request, "memory");
  await signIn(page, account);
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400 && res.url().includes("/v1/memory")) failures.push(`${res.status()} ${res.url()}`);
  });
  const stored = async () =>
    (await (await request.get("/v1/memory", { headers: account.headers })).json()) as { auto_extract: boolean };

  await page.goto("/settings");
  await page.getByRole("button", { name: "个性化" }).click();
  await expect(page.getByText("启用记忆").first()).toBeVisible();
  await expect(page.getByText("暂无记忆").first()).toBeVisible();
  expect((await stored()).auto_extract).toBe(true);

  // The background review is the member's to switch off.
  const row = page
    .getByText("后台自动记忆", { exact: true })
    .locator("xpath=ancestor::*[.//button[@role='switch']][1]");
  await row.getByRole("switch").click();
  await expect.poll(async () => (await stored()).auto_extract).toBe(false);
  await page.screenshot({ path: "test-results/memory.png", fullPage: true });
  expect(failures).toEqual([]);
});
