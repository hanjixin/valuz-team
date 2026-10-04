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
  const bindings: number[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/v1/channels/feishu/bindings/")) bindings.push(res.status());
  });
  await page.goto("/");
  await page.getByText("智能体", { exact: true }).first().click();
  await expect(page.getByText("E2E Analyst").first()).toBeVisible();
  await page.screenshot({ path: "test-results/agents.png", fullPage: true });

  // Its detail panel reads the agent's chat-app binding: unbound, but answered.
  await page.getByRole("tab", { name: "通道" }).click();
  await expect(page.getByText("飞书机器人").first()).toBeVisible();
  expect(bindings).toEqual([200]);
  await page.screenshot({ path: "test-results/agent-detail.png", fullPage: true });
});
