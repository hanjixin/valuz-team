import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("an agent created on the server appears in the app's agent library", async ({ page, request }) => {
  const account = await register(request, "agents");
  const created = await request.post("/v1/agents", {
    headers: account.headers,
    data: { name: "E2E Analyst", description: "Reads the filings nobody else does" },
  });
  expect(created.status()).toBe(201);

  await signIn(page, account);
  await page.goto("/");
  await page.getByText("智能体", { exact: true }).first().click();
  await expect(page.getByText("E2E Analyst").first()).toBeVisible();
  await page.screenshot({ path: "test-results/agents.png", fullPage: true });
});
