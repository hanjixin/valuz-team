import { expect, test } from "@playwright/test";

test("an agent created on the server appears in the app's agent library", async ({ page, request }) => {
  const account = await (
    await request.post("/v1/auth/register", {
      data: { email: "agents@example.com", password: "e2e-password-1", name: "Agents" },
    })
  ).json();
  const created = await request.post("/v1/agents", {
    headers: { authorization: `Bearer ${account.access_token}` },
    data: { name: "E2E Analyst", description: "Reads the filings nobody else does" },
  });
  expect(created.status()).toBe(201);

  await page.goto("/");
  await page.evaluate((session) => localStorage.setItem("agent-base.session", JSON.stringify(session)), {
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    org_id: account.org_id,
  });
  await page.goto("/");
  await page.getByText("智能体", { exact: true }).first().click();
  await expect(page.getByText("E2E Analyst").first()).toBeVisible();
  await page.screenshot({ path: "test-results/agents.png", fullPage: true });
});
