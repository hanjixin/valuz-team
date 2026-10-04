import { expect, test } from "@playwright/test";

test("a model channel added on the server shows up in the app's settings", async ({ page, request }) => {
  const account = await (
    await request.post("/v1/auth/register", {
      data: { email: "channels@example.com", password: "e2e-password-1", name: "Channels" },
    })
  ).json();
  const created = await request.post("/v1/providers", {
    headers: { authorization: `Bearer ${account.access_token}` },
    data: {
      name: "E2E Channel",
      provider_kind: "compatible",
      api_key: process.env["E2E_VENDOR_KEY"],
      base_url: process.env["E2E_VENDOR_URL"],
      models: ["alpha-1"],
    },
  });
  expect(created.status()).toBe(201);

  // Sign the browser in with the same account, then open a deep link.
  await page.goto("/");
  await page.evaluate((session) => localStorage.setItem("agent-base.session", JSON.stringify(session)), {
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    org_id: account.org_id,
  });
  const listed = page.waitForResponse((res) => new URL(res.url()).pathname === "/v1/providers" && res.ok());
  await page.goto("/settings");
  await listed;
  await page.getByText("模型", { exact: true }).first().click();
  await expect(page.getByText("E2E Channel").first()).toBeVisible();
  await page.screenshot({ path: "test-results/settings-models.png", fullPage: true });
});
