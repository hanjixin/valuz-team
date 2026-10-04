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
