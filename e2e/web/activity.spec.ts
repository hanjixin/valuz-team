import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("the activity page lists a member's conversations", async ({ page, request }) => {
  const account = await register(request, "activity");
  await request.post("/v1/devices", { headers: account.headers, data: { name: "E2E Mac" } });
  const channel = await (
    await request.post("/v1/providers", {
      headers: account.headers,
      data: {
        name: "E2E model",
        provider_kind: "compatible",
        api_key: "sk-e2e",
        base_url: process.env["E2E_MODEL_URL"],
        models: ["test-model"],
      },
    })
  ).json();
  await request.post("/v1/providers/default", { headers: account.headers, data: { provider_id: channel.id } });
  const created = await request.post("/v1/sessions", {
    headers: account.headers,
    data: { project_id: "chat-default", title: "E2E quarterly review" },
  });
  expect(created.status()).toBe(201);

  await signIn(page, account);
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400 && res.url().includes("/v1/activity")) failures.push(`${res.status()} ${res.url()}`);
  });
  await page.goto("/activity");
  await expect(page.getByTestId("shell-main").getByText("E2E quarterly review").first()).toBeVisible();
  await page.screenshot({ path: "test-results/activity.png", fullPage: true });
  expect(failures).toEqual([]);
});
