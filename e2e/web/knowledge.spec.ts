import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("a member creates a knowledge base, uploads a document and reads what was parsed", async ({ page, request }) => {
  const account = await register(request, "knowledge");
  await signIn(page, account);
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400 && /\/v1\/(kb|docs)/.test(res.url())) failures.push(`${res.status()} ${res.url()}`);
  });

  await page.goto("/knowledge");
  await page.getByRole("button", { name: "添加知识库" }).click();
  await page.getByPlaceholder("输入知识库名称").fill("员工手册");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByText("员工手册").first()).toBeVisible();

  // Open it and upload through the page's own file input.
  await page
    .getByRole("button", { name: /员工手册/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "上传文件" })).toBeVisible();
  await page
    .getByTestId("shell-main")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "leave.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 休假制度\n\n年假二十五天，未休年假可顺延至次年三月。"),
    });
  await expect(page.getByText("leave.md").first()).toBeVisible();

  // The server parsed it: the document opens to its text.
  await expect
    .poll(async () => {
      const res = await request.get("/v1/docs", { headers: account.headers });
      return ((await res.json()) as { documents: { status: string }[] }).documents.map((doc) => doc.status);
    })
    .toEqual(["ready"]);
  await page.getByText("leave.md").first().click();
  await expect(page.getByText("年假二十五天").first()).toBeVisible();
  await page.screenshot({ path: "test-results/knowledge.png", fullPage: true });
  expect(failures).toEqual([]);
});
