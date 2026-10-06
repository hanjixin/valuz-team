import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("a skill created on the server appears in the app's skill library", async ({ page, request }) => {
  const account = await register(request, "skills");
  const created = await request.post("/v1/skills", {
    headers: account.headers,
    data: { name: "E2E Valuation", description: "Value a company from its cash flows" },
  });
  expect(created.status()).toBe(201);

  await signIn(page, account);
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400 && res.url().includes("/v1/skills")) failures.push(`${res.status()} ${res.url()}`);
  });
  await page.goto("/skills");
  await expect(page.getByText("E2E Valuation").first()).toBeVisible();
  await page.screenshot({ path: "test-results/skills.png", fullPage: true });
  expect(failures).toEqual([]);
});

test("a member switches off skills their agents write themselves", async ({ page, request }) => {
  const account = await register(request, "skill-learning");
  const stored = async () =>
    (await (await request.get("/v1/skills/settings", { headers: account.headers })).json()) as { auto_learn: boolean };
  await signIn(page, account);
  await page.goto("/plugins");
  const row = page.getByTestId("skill-auto-learn");
  await expect(row.getByText("让智能体自己积累技能")).toBeVisible();
  expect((await stored()).auto_learn).toBe(true);
  await row.getByRole("switch").click();
  await expect.poll(async () => (await stored()).auto_learn).toBe(false);
  // It is remembered: the page shows it off when opened again.
  await page.reload();
  await expect(page.getByTestId("skill-auto-learn").getByRole("switch")).toHaveAttribute("aria-checked", "false");
});
