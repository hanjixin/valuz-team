import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("the app shows no door to what this server does not provide", async ({ page, request }) => {
  await signIn(page, await register(request, "navigation"));
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.status() === 501) failures.push(new URL(res.url()).pathname);
  });

  // The resource page opens on skills, with the built-in ones already there; plugin bundles are not offered.
  await page.goto("/plugins");
  const tabs = page.getByRole("tablist").first().getByRole("tab");
  await expect(tabs).toHaveText(["技能", "连接器"]);
  await expect(page.getByText("skill-creator").first()).toBeVisible();

  // The marketplace is: agents, skills and connectors — without plugin bundles.
  await page.goto("/marketplace");
  await expect(page.getByRole("tablist").first().getByRole("tab")).toHaveText(["智能体", "技能", "连接器"]);

  // Automations stand alone: no playbooks beside them, no template library.
  await page.goto("/automations");
  await expect(page.getByRole("button", { name: "自动化", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "执行手册" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "模板库" })).toHaveCount(0);

  // Settings list only what has a server behind it.
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "模型" })).toBeVisible();
  for (const gone of ["备份", "浏览器", "文档解析"])
    await expect(page.getByRole("button", { name: gone })).toHaveCount(0);

  await page.goto("/agents");
  await expect(page.getByRole("button", { name: "添加智能体" })).toBeVisible();
  await page.screenshot({ path: "test-results/navigation.png", fullPage: true });
  // None of these pages asked the server for something it answers "not implemented" to.
  expect(failures).toEqual([]);
});
