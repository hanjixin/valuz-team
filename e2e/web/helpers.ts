import type { APIRequestContext, Page } from "@playwright/test";

export interface Account {
  access_token: string;
  refresh_token: string;
  org_id: string;
  headers: { authorization: string };
}

export const PASSWORD = "e2e-password-1";

/** Create an account through the API. `name` doubles as the local part of its address. */
export async function register(request: APIRequestContext, name: string): Promise<Account> {
  const res = await request.post("/v1/auth/register", {
    data: { email: `${name}@example.com`, password: PASSWORD, name },
  });
  const body = (await res.json()) as Omit<Account, "headers">;
  return { ...body, headers: { authorization: `Bearer ${body.access_token}` } };
}

/**
 * Put the browser in the state of a member who has signed in and already been
 * through the first-run tour — these specs are about what comes after it.
 */
export async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    (session) => {
      localStorage.setItem("agent-base.session", JSON.stringify(session));
      localStorage.setItem("valuz-onboarded", "1");
    },
    { access_token: account.access_token, refresh_token: account.refresh_token, org_id: account.org_id },
  );
}
