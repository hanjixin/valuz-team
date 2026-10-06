import { expect, test } from "@playwright/test";
import { register, signIn } from "./helpers";

test("the bottom-left corner says who is signed in and where, and is the way to another organization and out", async ({
  page,
  request,
}) => {
  const account = await register(request, "account");
  // A second organization of theirs, with something in it to tell the two apart.
  const second = (await (
    await request.post("/v1/orgs", { headers: account.headers, data: { name: "Second Org" } })
  ).json()) as { id: string };
  await request.post("/v1/projects", {
    headers: { ...account.headers, "x-org-id": second.id },
    data: { name: "Only In Second" },
  });

  await signIn(page, account);
  await page.goto("/");
  const menu = page.getByTestId("account-menu");
  await expect(menu).toContainText("account");
  await expect(menu).not.toContainText("Second Org");
  await expect(page.getByText("Only In Second")).toHaveCount(0);

  // Move to the other organization: the app starts over there.
  await menu.click();
  await page.getByRole("menuitem", { name: "Second Org" }).click();
  await expect(page.getByTestId("account-menu")).toContainText("Second Org");
  await expect(page.getByText("Only In Second").first()).toBeVisible();
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem("agent-base.session") ?? "{}"));
  expect(session.org_id).toBe(second.id);

  // Out of the account: the sign-in page, and the session is gone from this browser and the server.
  await page.getByTestId("account-menu").click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page.locator("#auth-email")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("agent-base.session"))).toBeNull();
  const refreshed = await request.post("/v1/auth/refresh", { data: { refresh_token: account.refresh_token } });
  expect(refreshed.status()).toBe(401);
});
