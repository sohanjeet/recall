// REAL: sign-in with the dedicated test account against the real Supabase Auth project of the isolated test setup.
// Skipped unless RECALL_REAL_E2E=1 and the safety gate in config.ts passes.
import { expect, test } from "@playwright/test";
import { api, readyConfig, signIn, skipUnlessReal } from "./helpers";

test.describe("Real: authentication", () => {
  skipUnlessReal(test);
  const real = readyConfig();

  test("a wrong password is rejected with a clear message", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(real!.account.email);
    await page.getByLabel("Password").fill(`${real!.account.password}-wrong`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect.");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the test account signs in, the API accepts the session, it survives a reload and sign-out ends it", async ({ page }) => {
    await signIn(page, real!.account);
    await expect(page.getByText(real!.account.email, { exact: false }).first()).toBeVisible();

    const me = await api<{ email: string }>(page, "GET", "/me");
    expect(me.email.toLowerCase()).toBe(real!.account.email.toLowerCase());

    await page.reload();
    await expect(page.getByRole("heading", { name: "Meetings", level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/approvals");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("protected API routes reject a request without a session", async ({ request }) => {
    expect((await request.get("/api/meetings")).status()).toBe(401);
  });
});
