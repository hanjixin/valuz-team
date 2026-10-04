import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("a connector added on the server appears in the app", async ({ page, request }) => {
  const account = await register(request, "connectors");
  const created = await request.post("/v1/connectors", {
    headers: account.headers,
    data: {
      display_name: "E2E Catalogue",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      description: "Looks things up",
    },
  });
  expect(created.status()).toBe(201);

  await signIn(page, account);
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400 && res.url().includes("/v1/connectors")) failures.push(`${res.status()} ${res.url()}`);
  });
  await page.goto("/connectors");
  await expect(page.getByText("E2E Catalogue").first()).toBeVisible();
  await page.screenshot({ path: "test-results/connectors.png", fullPage: true });
  expect(failures).toEqual([]);
});
