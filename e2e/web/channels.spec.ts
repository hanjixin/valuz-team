import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("a model channel added on the server shows up in the app's settings", async ({ page, request }) => {
  const account = await register(request, "channels");
  const created = await request.post("/v1/providers", {
    headers: account.headers,
    data: {
      name: "E2E Channel",
      provider_kind: "compatible",
      api_key: process.env["E2E_VENDOR_KEY"],
      base_url: process.env["E2E_VENDOR_URL"],
      models: ["alpha-1"],
    },
  });
  expect(created.status()).toBe(201);

  await signIn(page, account);
  await page.goto("/settings");
  await page.getByText("模型", { exact: true }).first().click();
  await expect(page.getByText("E2E Channel").first()).toBeVisible();
  await page.screenshot({ path: "test-results/settings-models.png", fullPage: true });
});
