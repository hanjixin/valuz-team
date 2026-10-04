import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("an automation shows in the app with its schedule in words, and opens to its detail", async ({
  page,
  request,
}) => {
  const account = await register(request, "automations");
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
  const created = await request.post("/v1/automations", {
    headers: account.headers,
    data: {
      name: "E2E morning brief",
      project_kind: "chat",
      prompt_template: "Write the morning brief.",
      trigger: { kind: "cron", cron_expr: "30 8 * * 1-5", timezone: "Asia/Shanghai" },
    },
  });
  expect(created.status()).toBe(201);
  const automation = (await created.json()) as { automation_id: string };

  await signIn(page, account);
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400 && res.url().includes("/v1/automations")) failures.push(`${res.status()} ${res.url()}`);
  });
  await page.goto("/automations");
  const main = page.getByTestId("shell-main");
  await expect(main.getByText("E2E morning brief").first()).toBeVisible();
  await page.screenshot({ path: "test-results/automations.png", fullPage: true });

  await page.goto(`/automations/${automation.automation_id}`);
  await expect(page.getByText("Write the morning brief.").first()).toBeVisible();
  await expect(page.getByText("在08:30, 星期一至星期五").first()).toBeVisible();
  await page.screenshot({ path: "test-results/automation-detail.png", fullPage: true });
  expect(failures).toEqual([]);
});
