// Captures real browser screenshots of the running web app into docs/screenshots/{portfolio,qa}.
// Run with `pnpm e2e:screenshots`; kept out of the normal QA run so tracked images are not rewritten.
// Everything except login.png is rendered from the mocked API in mock.ts (fixture data, no live integrations).
// login.png is the real login page served by the real API and Supabase configuration (no credentials involved).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installMock, type MockApi, type MockOptions } from "./mock";


const ROOT = new URL("../docs/screenshots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(`${ROOT}portfolio`, { recursive: true });
mkdirSync(`${ROOT}qa`, { recursive: true });

const M = (n: number) => `/meetings/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500); // entrance animations are reduced by the config; this lets layout settle
  // Fail rather than capture a loading skeleton.
  await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0);
}

async function go(page: Page, path: string, opts?: MockOptions): Promise<MockApi> {
  const api = await installMock(page, opts);
  await page.goto(path);
  return api;
}

const shot = (page: Page, dir: "portfolio" | "qa", name: string, full = false) =>
  page.screenshot({ path: `${ROOT}${dir}/${name}.png`, fullPage: full, animations: "disabled" });

async function scrollTo(page: Page, heading: RegExp | string) {
  const h = page.getByRole("heading", { name: heading }).first();
  await h.scrollIntoViewIfNeeded();
  await h.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -24));
}

test.describe("portfolio (1440x900)", () => {
  test("login (real server)", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await settle(page);
    await shot(page, "portfolio", "login");
  });

  test("dashboard", async ({ page }) => {
    await go(page, "/");
    await expect(page.getByText("Atlas kickoff")).toBeVisible();
    await settle(page);
    await shot(page, "portfolio", "dashboard");
  });

  test("new meeting", async ({ page }) => {
    await go(page, "/meetings/new");
    await page.getByLabel("Title").fill("Atlas planning sync");
    await page.getByLabel("Meeting date").fill("2026-10-27");
    await page.getByLabel("Participants").fill("Sam, Ana, Priya");
    await page.locator("#transcript-input").fill(
      "Sam: Given the security review, let's move the beta to November 22.\nAna: Ana, push the announcement out a week.\nPriya: We might need to raise the infra budget, maybe four thousand.\nPriya: Priya, release notes by the 19th.",
    );
    await settle(page);
    await page.mouse.move(0, 0);
    await shot(page, "portfolio", "new-meeting", true);
  });

  test("ai extraction", async ({ page }) => {
    await go(page, M(2));
    await expect(page.getByRole("heading", { name: /^Decisions/ })).toBeVisible();
    await settle(page);
    await shot(page, "portfolio", "ai-extraction", true);
  });

  test("decisions (approved history)", async ({ page }) => {
    await go(page, M(1));
    await expect(page.getByRole("heading", { name: /^Decisions/ })).toBeVisible();
    await settle(page);
    await shot(page, "portfolio", "decisions", true);
  });

  test("approvals + tasks + linear sync", async ({ page }) => {
    await go(page, "/approvals");
    await expect(page.getByRole("heading", { name: /Conflicts to resolve/ })).toBeVisible();
    await settle(page);
    await shot(page, "portfolio", "conflict-detected");
    await scrollTo(page, /Proposed decisions/);
    await settle(page);
    await shot(page, "portfolio", "approvals");
    await scrollTo(page, /Proposed tasks/);
    await shot(page, "portfolio", "tasks");
    await scrollTo(page, /Linear sync/);
    await shot(page, "portfolio", "linear-sync");
  });

  test("conflict resolved (accept new, then meeting view)", async ({ page }) => {
    await go(page, "/approvals");
    await page.getByRole("button", { name: "Accept new decision" }).first().click();
    await expect(page.getByText("Changes an earlier decision")).toHaveCount(0);
    await page.getByRole("link", { name: "Atlas planning sync" }).first().click();
    await expect(page.getByText("Resolved · replaced by new decision")).toBeVisible();
    await settle(page);
    await scrollTo(page, /Conflicts with earlier decisions/);
    await shot(page, "portfolio", "conflict-resolved");
  });

  test("reminders and weekly digest", async ({ page }) => {
    await go(page, "/reminders");
    await expect(page.getByRole("heading", { name: /Reminder inbox/ })).toBeVisible();
    await settle(page);
    await shot(page, "portfolio", "reminders", true);
    await page.getByRole("tab", { name: "Weekly digests" }).click();
    await expect(page.getByRole("heading", { name: /^Week of/ })).toBeVisible();
    await settle(page);
    await shot(page, "portfolio", "weekly-digest", true);
  });
});

const SIZES = [
  { tag: "tablet", width: 768, height: 1024 },
  { tag: "mobile", width: 390, height: 844 },
  { tag: "small-mobile", width: 375, height: 812 },
] as const;

test.describe("qa: responsive", () => {
  for (const s of SIZES) {
    test(`${s.tag}`, async ({ page }) => {
      await page.setViewportSize({ width: s.width, height: s.height });
      await go(page, "/");
      await expect(page.getByText("Atlas kickoff")).toBeVisible();
      await settle(page);
      await shot(page, "qa", `${s.tag}-dashboard`);
      const pages: [string, string, string | RegExp][] = [
        ["approvals", "/approvals", "Conflicts to resolve"],
        ["meeting-detail", M(2), "Decisions"],
        ["new-meeting", "/meetings/new", "New meeting"],
        ["reminders", "/reminders", "Reminders & digests"],
      ];
      for (const [name, path, ready] of pages) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: ready }).first()).toBeVisible();
        await settle(page);
        await shot(page, "qa", `${s.tag}-${name}`, name !== "new-meeting");
      }
    });
  }

  test("mobile login", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await settle(page);
    await shot(page, "qa", "mobile-login");
  });
});

test.describe("qa: validation, empty, loading and failure states", () => {
  test("login: invalid credentials (mocked Supabase rejection)", async ({ page }) => {
    await go(page, "/login", { signedIn: false });
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await settle(page);
    await shot(page, "qa", "validation-login-invalid-credentials");
  });

  test("login: session expired notice", async ({ page }) => {
    const api = await go(page, "/");
    await expect(page.getByText("Atlas kickoff")).toBeVisible();
    api.override(/GET \/approvals/, () => ({ status: 401, body: { error: "expired", code: "session_expired" } }));
    await page.getByRole("link", { name: "Approvals" }).click();
    await expect(page.getByRole("alert")).toContainText("session has expired");
    await settle(page);
    await shot(page, "qa", "failure-session-expired");
  });

  test("new meeting: transcript over the limit", async ({ page }) => {
    await go(page, "/meetings/new");
    await page.getByLabel("Title").fill("Over the limit");
    await page.locator("#transcript-input").fill("Sam: " + "word ".repeat(10_100));
    await expect(page.getByRole("button", { name: "Save and analyze" })).toBeDisabled();
    await settle(page);
    await page.locator("#transcript-input").evaluate((el) => ((el as HTMLTextAreaElement).scrollTop = 0));
    await shot(page, "qa", "validation-transcript-too-long");
  });

  test("new meeting: save error", async ({ page }) => {
    const api = await go(page, "/meetings/new");
    api.override(/POST \/meetings$/, () => ({ status: 500, body: { error: "Could not save the meeting right now." } }));
    await page.getByLabel("Title").fill("Will fail");
    await page.locator("#transcript-input").fill("Sam: hello there everyone.");
    await page.getByRole("button", { name: "Save and analyze" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await settle(page);
    await shot(page, "qa", "failure-new-meeting-save-error");
  });

  test("empty states", async ({ page }) => {
    const api = await go(page, "/");
    api.override(/GET \/meetings$/, () => ({ body: [] }));
    api.override(/GET \/approvals/, () => ({ body: { linearConfigured: true, decisions: [], tasks: [], conflicts: [], sync: [] } }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "No meetings yet" })).toBeVisible();
    await settle(page);
    await shot(page, "qa", "empty-meetings");
    await page.getByRole("link", { name: "Approvals" }).click();
    await expect(page.getByRole("heading", { name: "Nothing waiting for approval" })).toBeVisible();
    await settle(page);
    await shot(page, "qa", "empty-approvals");
    const empty = { mode: "in-app", externalDelivery: "not_available", note: "Reminders and digests are visible in Recall only; no email or chat provider is connected." };
    api.override(/GET \/reminders\/preview/, () => ({ body: { windowHours: 24, asOf: "2026-11-01T09:00:00.000Z", delivery: empty, items: [], counts: { new: 0, alreadyGenerated: 0 } } }));
    api.override(/GET \/reminders$/, () => ({ body: { delivery: empty, reminders: [], unread: 0 } }));
    await page.getByRole("link", { name: "Reminders & digests" }).click();
    await expect(page.getByRole("heading", { name: "No reminders yet" })).toBeVisible();
    await settle(page);
    await shot(page, "qa", "empty-reminders");
  });

  test("loading state (slow API)", async ({ page }) => {
    const api = await go(page, "/meetings/new");
    await expect(page.getByRole("heading", { name: "New meeting" })).toBeVisible();
    api.override(/GET \/meetings$/, async () => {
      await new Promise((r) => setTimeout(r, 4000));
      return { body: api.summaries() };
    });
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Loading meetings");
    await page.waitForTimeout(300);
    await shot(page, "qa", "loading-meetings");
  });

  test("API unreachable", async ({ page }) => {
    const api = await go(page, "/");
    await expect(page.getByText("Atlas kickoff")).toBeVisible();
    api.override(/GET \/meetings$/, () => ({ abort: true }));
    api.override(/GET \/health/, () => ({ abort: true }));
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Could not reach the Recall server");
    await settle(page);
    await shot(page, "qa", "failure-api-unreachable");
  });

  test("analysis failed and not found", async ({ page }) => {
    await go(page, M(4));
    await expect(page.getByRole("alert")).toContainText("Analysis failed");
    await settle(page);
    await shot(page, "qa", "failure-analysis-failed");
    await page.goto("/does-not-exist");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await settle(page);
    await shot(page, "qa", "failure-not-found");
  });

  test("approval refused (already approved)", async ({ page }) => {
    const api = await go(page, "/approvals");
    api.override(/POST \/decisions\/.+\/approve/, () => ({ status: 409, body: { error: "This decision is no longer awaiting approval.", code: "conflict" } }));
    const item = page.locator("li.item", { hasText: "Increase the Atlas infrastructure budget" });
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(item.getByRole("alert")).toBeVisible();
    await settle(page);
    await item.scrollIntoViewIfNeeded();
    await shot(page, "qa", "failure-duplicate-approval-refused");
  });
});

test.describe("qa: conflict outcomes", () => {
  test("resolved history (kept new, kept old, dismissed)", async ({ page }) => {
    await go(page, M(3));
    await expect(page.getByText("Dismissed · not a conflict")).toBeVisible();
    await settle(page);
    await shot(page, "qa", "conflict-outcomes-resolved-history", true);
  });

  test("uncertain conflict awaiting review", async ({ page }) => {
    await go(page, "/approvals");
    await expect(page.getByText("Possible conflict · needs review")).toBeVisible();
    await settle(page);
    await page.getByText("Possible conflict · needs review").scrollIntoViewIfNeeded();
    await shot(page, "qa", "conflict-uncertain");
  });

  test("keep old decision", async ({ page }) => {
    await go(page, "/approvals");
    await page.getByRole("button", { name: "Keep old decision" }).first().click();
    await expect(page.getByText("Changes an earlier decision")).toHaveCount(0);
    await page.getByRole("link", { name: "Atlas planning sync" }).first().click();
    await expect(page.getByText("Resolved · earlier decision kept")).toBeVisible();
    await settle(page);
    await scrollTo(page, /Conflicts with earlier decisions/);
    await shot(page, "qa", "conflict-keep-old");
  });

  test("dismissed as not a conflict", async ({ page }) => {
    await go(page, "/approvals");
    await page.getByRole("button", { name: "Not a conflict" }).click();
    await expect(page.getByText("Possible conflict · needs review")).toHaveCount(0);
    await page.getByRole("link", { name: "Atlas planning sync" }).first().click();
    await expect(page.getByText("Dismissed · not a conflict")).toBeVisible();
    await settle(page);
    await scrollTo(page, /Conflicts with earlier decisions/);
    await shot(page, "qa", "conflict-dismissed");
  });

  test("linear sync failed + not configured", async ({ page }) => {
    await go(page, "/approvals");
    await scrollTo(page, /Linear sync/);
    await settle(page);
    await shot(page, "qa", "linear-sync-failed-retry");
    const p2 = await page.context().newPage();
    await installMock(p2, { linearConfigured: false });
    await p2.goto("/approvals");
    await expect(p2.getByRole("heading", { name: /Linear sync/ })).toBeVisible();
    await p2.getByRole("heading", { name: /Linear sync/ }).scrollIntoViewIfNeeded();
    await settle(p2);
    await p2.screenshot({ path: `${ROOT}qa/linear-not-configured.png`, animations: "disabled" });
  });
});
