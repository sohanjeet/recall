// Live checks against the real API (:8787), the real Supabase Auth project and the real web app (:5173).
// Run with RECALL_LIVE=1. Read-only: no test account credentials are used and nothing is written to the database.
// An authenticated live walkthrough needs a dedicated test account, which this repository does not provide.
import { expect, test } from "@playwright/test";

test.describe("Live integration (unauthenticated)", () => {
  test("API health reports the database and integrations", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.services.database).toBe("ok");
  });

  test("protected API routes reject missing and malformed tokens", async ({ request }) => {
    for (const path of ["/api/meetings", "/api/approvals", "/api/reminders", "/api/digests/preview", "/api/me"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(401);
    }
    const bad = await request.get("/api/meetings", { headers: { Authorization: "Bearer not-a-real-token" } });
    expect(bad.status()).toBe(401);
  });

  test("auth config exposes only public values", async ({ request }) => {
    const body = await (await request.get("/api/auth/config")).json();
    expect(body.enabled).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["enabled", "supabaseAnonKey", "supabaseUrl"]);
  });

  test("protected pages redirect to the real login page", async ({ page }) => {
    for (const path of ["/", "/approvals", "/reminders", "/meetings/new"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    }
  });

  test("real Supabase rejects an unknown account with a clear message", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("qa-nonexistent-account@example.invalid");
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect.");
    await expect(page).toHaveURL(/\/login$/);
  });
});
