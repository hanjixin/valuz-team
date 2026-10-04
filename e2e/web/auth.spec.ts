import { expect, test } from "@playwright/test";

test.describe("sign in", () => {
  test("shows the server's reason when the password is wrong", async ({ page }) => {
    await page.goto("/");
    await page.locator("#auth-email").fill("nobody@example.com");
    await page.locator("#auth-password").fill("wrong-password");
    await page.locator("button[type=submit]").click();
    await expect(page.getByRole("alert")).toHaveText("incorrect email or password");
  });

  test("registers, lands in the app, and stays signed in across a reload", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/");
    await page.getByRole("tab", { name: /注册|Create account/ }).click();
    await page.locator("#auth-name").fill("Owner");
    await page.locator("#auth-email").fill("owner@example.com");
    await page.locator("#auth-password").fill("e2e-password-1");
    await page.locator("button[type=submit]").click();

    await expect(page.locator("#auth-email")).toHaveCount(0);
    // Every request the app makes from here on carries the session.
    const me = await page.evaluate(async () => {
      const session = JSON.parse(localStorage.getItem("agent-base.session") ?? "null");
      const res = await fetch("/v1/me", { headers: { authorization: `Bearer ${session.access_token}` } });
      return res.json();
    });
    expect(me).toMatchObject({ user: { email: "owner@example.com", name: "Owner" }, role: "owner" });

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#auth-email")).toHaveCount(0);
    // Modules that are not ported yet answer 501; anything else is a real failure.
    expect(pageErrors.filter((message) => !message.endsWith("is not implemented yet"))).toEqual([]);
  });

  test("a session whose tokens are gone falls back to the sign-in page", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() =>
      localStorage.setItem(
        "agent-base.session",
        JSON.stringify({ access_token: "expired", refresh_token: "rt_revoked", org_id: "" }),
      ),
    );
    await page.reload();
    // The first API call gets 401, the refresh is refused, and the gate returns.
    await expect(page.locator("#auth-email")).toBeVisible();
  });
});
