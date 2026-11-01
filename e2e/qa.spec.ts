// Browser QA against the real web app with a mocked API (see mock.ts). Deterministic; never touches Supabase,
// Groq, Linear or the production database.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installMock, MOCK_USER, type MockApi, type MockOptions } from "./mock";

const M = (n: number) => `/meetings/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function open(page: Page, path: string, opts?: MockOptions) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const api = await installMock(page, opts);
  await page.goto(path);
  return { api, errors };
}

/** Console errors that are the intended result of a failure-injection test (browser logs failed HTTP loads). */
const noUnexpected = (errors: string[]) => errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(e));

test.describe("A. Authentication", () => {
  test("protected route redirects to login and back after sign-in is required", async ({ page }) => {
    await open(page, "/approvals", { signedIn: false });
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("login form: submit disabled until both fields filled; invalid credentials show an error and clear the password", async ({ page }) => {
    const { errors } = await open(page, "/login", { signedIn: false });
    const submit = page.getByRole("button", { name: "Sign in" });
    await expect(submit).toBeDisabled();
    await page.getByLabel("Email").fill("someone@example.com");
    await expect(submit).toBeDisabled();
    await page.getByLabel("Password").fill("not-the-password");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect.");
    await expect(page.getByLabel("Password")).toHaveValue("");
    expect(noUnexpected(errors)).toEqual([]);
  });

  test("login form: invalid email is blocked by the browser", async ({ page }) => {
    await open(page, "/login", { signedIn: false });
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel("Password").fill("x");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.getByLabel("Email").evaluate((el: HTMLInputElement) => el.validity.typeMismatch)).toBe(true);
  });

  test("session persists across reload; sign out returns to login and re-protects routes", async ({ page }) => {
    const { api } = await open(page, "/");
    await expect(page.getByRole("heading", { name: "Meetings" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Meetings" })).toBeVisible();
    await expect(page.locator(`text=${MOCK_USER.email} >> visible=true`).first()).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem("recall.auth"))).toBeNull();
    await page.goto("/approvals");
    await expect(page).toHaveURL(/\/login$/);
    expect(api.calls).toContain("GET /me");
  });

  test("a 401 from the API ends the session with an explanation", async ({ page }) => {
    const { api } = await open(page, "/", { signedIn: true });
    await expect(page.getByRole("heading", { name: "Meetings" })).toBeVisible();
    api.override(/GET \/approvals/, () => ({ status: 401, body: { error: "Your session has expired. Sign in again.", code: "session_expired" } }));
    await page.getByRole("link", { name: "Approvals" }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("alert")).toContainText("session has expired");
  });

  test("a 403 (account not allow-listed) shows the access message", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const api = await installMock(page);
    api.override(/GET \/me/, () => ({ status: 403, body: { error: "Forbidden", code: "forbidden" } }));
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("alert")).toContainText("does not have access");
  });
});

test.describe("B. Meetings dashboard", () => {
  test("lists meetings with counts and status, and opens a meeting", async ({ page }) => {
    const { errors } = await open(page, "/");
    await expect(page.getByRole("heading", { name: "Meetings", level: 1 })).toBeVisible();
    const rows = page.locator("ul.divide-y > li");
    await expect(rows).toHaveCount(5);
    await expect(rows.filter({ hasText: "Atlas planning sync" })).toContainText("3 decisions · 3 tasks");
    await expect(rows.filter({ hasText: "Atlas retro" })).toContainText("Analysis failed");
    await expect(rows.filter({ hasText: "Atlas standup" })).toContainText("Not analyzed");
    await page.getByRole("link", { name: /Atlas kickoff/ }).click();
    await expect(page).toHaveURL(new RegExp(`${M(1)}$`));
    await expect(page.getByRole("heading", { name: "Atlas kickoff", level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("empty state", async ({ page }) => {
    const { api } = await open(page, "/");
    api.override(/GET \/meetings$/, () => ({ body: [] }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "No meetings yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Add your first meeting" })).toBeVisible();
  });

  test("slow API shows a loading status, then the list", async ({ page }) => {
    await open(page, "/", { delayMs: 1200 });
    await expect(page.getByRole("status")).toContainText("Loading meetings");
    await expect(page.getByText("Atlas kickoff")).toBeVisible({ timeout: 8000 });
  });

  test("API unavailable shows an error with working retry", async ({ page }) => {
    const { api, errors } = await open(page, "/");
    let down = true;
    api.override(/GET \/meetings$/, () => (down ? { abort: true } : undefined));
    // Overrides returning undefined must still be answered; fall back to the default by clearing the override.
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Could not reach the Recall server");
    down = false;
    api.overrides.shift();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Atlas kickoff")).toBeVisible();
    expect(noUnexpected(errors)).toEqual([]);
  });

  test("unknown route renders the in-app not-found page", async ({ page }) => {
    await open(page, "/does-not-exist");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await page.getByRole("link", { name: "Back to meetings" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("unknown meeting id shows a not-found error without a retry button", async ({ page }) => {
    await open(page, M(999));
    await expect(page.getByRole("alert")).toContainText("Meeting not found");
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });
});

test.describe("C. New meeting", () => {
  test("required fields block submission", async ({ page }) => {
    const { api } = await open(page, "/meetings/new");
    await page.getByRole("button", { name: "Save and analyze" }).click();
    await expect(page).toHaveURL(/\/meetings\/new$/);
    expect(await page.getByLabel("Title").evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    expect(api.calls).not.toContain("POST /meetings");
  });

  test("detects speakers, lets the user correct them, saves and analyzes", async ({ page }) => {
    const { api, errors } = await open(page, "/meetings/new");
    await page.getByLabel("Title").fill("QA fixture meeting");
    await page.getByLabel("Participants").fill("Sam, Ana");
    await page.locator("#transcript-input").fill("Sam: Let's ship on Monday.\nAna: I'll write the notes by Friday.\nSam: Agreed.");
    await expect(page.getByText("Detected speakers")).toBeVisible();
    await expect(page.getByText("Sam · 2 segments")).toBeVisible();
    await page.getByLabel("Real name for Sam").fill("Samuel");
    await page.getByRole("button", { name: "Save and analyze" }).click();
    await expect(page).toHaveURL(/\/meetings\/00000000/);
    expect(api.calls).toEqual(expect.arrayContaining(["POST /meetings", expect.stringMatching(/POST \/meetings\/.+\/analyze/)]));
    expect(errors).toEqual([]);
  });

  test("unlabelled dictation is reported as one segment", async ({ page }) => {
    await open(page, "/meetings/new");
    await page.locator("#transcript-input").fill("We decided to ship on Monday and Ana will write the notes.");
    await expect(page.getByText("No speaker labels")).toBeVisible();
  });

  test("a server error is shown and the form stays editable", async ({ page }) => {
    const { api, errors } = await open(page, "/meetings/new");
    api.override(/POST \/meetings$/, () => ({ status: 500, body: { error: "Could not save the meeting right now." } }));
    await page.getByLabel("Title").fill("Will fail");
    await page.locator("#transcript-input").fill("Sam: hello there everyone.");
    await page.getByRole("button", { name: "Save and analyze" }).click();
    await expect(page.getByRole("alert")).toContainText("Could not save the meeting right now.");
    await expect(page.getByLabel("Title")).toBeEnabled();
    expect(noUnexpected(errors)).toEqual([]);
  });

  test("a very long transcript is rejected client-side with a visible count", async ({ page }) => {
    await open(page, "/meetings/new");
    await page.getByLabel("Title").fill("Long");
    await page.locator("#transcript-input").fill("Sam: " + "word ".repeat(10_100));
    await expect(page.getByText(/50,000 characters/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save and analyze" })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("analysis in progress shows a busy state and locks the form", async ({ page }) => {
    const { api } = await open(page, "/meetings/new");
    api.override(/POST \/meetings\/.+\/analyze/, async ({ route }) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "x" }) });
    });
    await page.getByLabel("Title").fill("Slow analysis");
    await page.locator("#transcript-input").fill("Sam: hello there everyone.");
    await page.getByRole("button", { name: "Save and analyze" }).click();
    await expect(page.getByRole("button", { name: "Extracting decisions and tasks…" })).toBeDisabled();
    await expect(page.getByLabel("Title")).toBeDisabled();
  });
});

test.describe("D. AI meeting analysis display", () => {
  test("decisions, tasks, owners, due dates and evidence", async ({ page }) => {
    const { errors } = await open(page, M(2));
    await expect(page.getByRole("heading", { name: /^Decisions/ })).toBeVisible();
    await expect(page.getByText("Move the Atlas beta launch to November 22").first()).toBeVisible();
    await expect(page.getByText("“Given the security review, let's move the beta to November 22.”").first()).toBeVisible();
    const tasks = page.locator("section", { has: page.getByRole("heading", { name: /^Tasks/ }) });
    await expect(tasks).toContainText("Owner Ana");
    await expect(tasks).toContainText("Due unresolved (“after the review”)");
    await expect(tasks).toContainText("Owner unassigned");
    await expect(tasks).toContainText("Due none");
    await expect(tasks).toContainText("Due Nov 19, 2026 (“by the 19th”)");
    // No-evidence handling.
    await expect(tasks).toContainText("No supporting quote found in the transcript.");
    await expect(page.getByText("No owner was named for the security review booking.")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("failed analysis shows the error and a working Retry analysis", async ({ page }) => {
    const { api } = await open(page, M(4));
    await expect(page.getByRole("alert")).toContainText("Analysis failed: The model response could not be parsed");
    api.override(/POST \/meetings\/.+\/analyze/, () => ({ status: 502, body: { error: "The AI service did not respond. Try again." } }));
    await page.getByRole("button", { name: "Retry analysis" }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry analysis" })).toBeEnabled();
  });

  test("analyze shows a progress message while running", async ({ page }) => {
    const { api } = await open(page, M(5));
    api.override(/POST \/meetings\/.+\/analyze/, async ({ route }) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api.meetings.find((m) => m.id.endsWith("05"))) });
    });
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Extracting decisions and tasks");
  });

  test("a meeting with no decisions or tasks says so", async ({ page }) => {
    const { api } = await open(page, M(1));
    api.meetings.find((m) => m.id.endsWith("01"))!.decisions = [];
    api.decisions = {};
    api.override(/GET \/meetings\/.+/, ({ route }) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...api.meetings.find((m) => m.id.endsWith("01"))!, decisions: [], tasks: [] }) }));
    await page.reload();
    await expect(page.getByText("No decisions found.")).toBeVisible();
    await expect(page.getByText("No tasks found.")).toBeVisible();
  });
});

test.describe("E/F. Decisions, approvals and conflicts", () => {
  test("approvals queue: open and uncertain conflicts, blocked approval, proposals", async ({ page }) => {
    const { errors } = await open(page, "/approvals");
    await expect(page.getByRole("heading", { name: /Conflicts to resolve/ })).toBeVisible();
    await expect(page.getByText("Changes an earlier decision")).toBeVisible();
    await expect(page.getByText("Possible conflict · needs review")).toBeVisible();
    await expect(page.getByText("Nov 15", { exact: false }).first()).toBeVisible();
    const blocked = page.locator("li.item", { hasText: "Move the Atlas beta launch to November 22" });
    await expect(blocked.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(blocked).toContainText("Cannot be approved until its conflict is resolved below.");
    const possible = page.locator("li.item", { hasText: "Increase the Atlas infrastructure budget" });
    await expect(possible).toContainText("Has 1 possible conflict");
    await expect(possible.getByRole("button", { name: "Approve" })).toBeEnabled();
    // "Not a conflict" is offered only for uncertain conflicts.
    await expect(page.getByRole("button", { name: "Not a conflict" })).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("accept new: new decision becomes active, old superseded, no warning left", async ({ page }) => {
    const { api } = await open(page, "/approvals");
    await page.getByRole("button", { name: "Accept new decision" }).first().click();
    await expect(page.getByText("Changes an earlier decision")).toHaveCount(0);
    expect(api.decisions["00000000-0000-4000-8000-000000000013"]!.status).toBe("active");
    expect(api.decisions["00000000-0000-4000-8000-000000000011"]!.status).toBe("superseded");
    await page.goto(M(2));
    await expect(page.getByText("Conflict resolved: this decision replaced an earlier one.")).toBeVisible();
    await expect(page.locator("li.item", { hasText: "Move the Atlas beta launch to November 22" })).not.toContainText("see above");
    await expect(page.getByText("Resolved · replaced by new decision")).toBeVisible();
  });

  test("keep old: draft is rejected and the earlier decision stays active", async ({ page }) => {
    const { api } = await open(page, "/approvals");
    await page.getByRole("button", { name: "Keep old decision" }).first().click();
    await expect(page.getByText("Changes an earlier decision")).toHaveCount(0);
    expect(api.decisions["00000000-0000-4000-8000-000000000013"]!.status).toBe("rejected");
    expect(api.decisions["00000000-0000-4000-8000-000000000011"]!.status).toBe("active");
    await page.goto(M(2));
    await expect(page.getByText("Resolved · earlier decision kept")).toBeVisible();
    await expect(page.getByText("Conflict resolved: the earlier decision was kept and this draft rejected.")).toBeVisible();
  });

  test("dismiss an uncertain conflict: neither decision changes", async ({ page }) => {
    const { api } = await open(page, "/approvals");
    await page.getByRole("button", { name: "Not a conflict" }).click();
    await expect(page.getByText("Possible conflict · needs review")).toHaveCount(0);
    expect(api.decisions["00000000-0000-4000-8000-000000000012"]!.status).toBe("active");
    expect(api.decisions["00000000-0000-4000-8000-000000000014"]!.status).toBe("proposed");
  });

  test("resolved outcomes from history render distinctly and truthfully", async ({ page }) => {
    await open(page, M(3));
    await expect(page.getByText("Resolved · replaced by new decision")).toBeVisible();
    await expect(page.getByText("Resolved · earlier decision kept")).toBeVisible();
    await expect(page.getByText("Dismissed · not a conflict")).toBeVisible();
    // No open-conflict warning copy once everything is resolved.
    await expect(page.getByText(/stays in effect until you resolve this/)).toHaveCount(0);
    await expect(page.getByText(/Conflicts with an earlier decision; see above/)).toHaveCount(0);
    // Only the side that no longer stands is struck through.
    const struck = page.locator(".compare-struck");
    await expect(struck).toHaveCount(2);
  });

  test("approving twice: the second attempt is refused and explained", async ({ page }) => {
    const { api } = await open(page, "/approvals");
    const item = page.locator("li.item", { hasText: "Increase the Atlas infrastructure budget" });
    api.override(/POST \/decisions\/.+\/approve/, () => ({ status: 409, body: { error: "This decision is no longer awaiting approval.", code: "conflict" } }));
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "no longer awaiting approval" })).toBeVisible();
  });

  test("approve and reject a decision; audit history opens", async ({ page }) => {
    const { api } = await open(page, "/approvals");
    const item = page.locator("li.item", { hasText: "Increase the Atlas infrastructure budget" });
    await item.getByRole("button", { name: "History" }).click();
    await expect(item).toContainText(MOCK_USER.email);
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("li.item", { hasText: "Increase the Atlas infrastructure budget" })).toHaveCount(0);
    expect(api.decisions["00000000-0000-4000-8000-000000000014"]!.status).toBe("active");
    const long = page.locator("li.item", { hasText: "Adopt a design-review checkpoint" });
    await long.getByRole("button", { name: "Reject" }).click();
    await expect(long).toHaveCount(0);
  });

  test("edit decision form validates and cancels", async ({ page }) => {
    await open(page, "/approvals");
    const item = page.locator("li.item", { hasText: "Increase the Atlas infrastructure budget" });
    await item.getByRole("button", { name: "Edit" }).click();
    await page.locator("textarea").first().fill("");
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(item.getByRole("button", { name: "Approve" })).toBeVisible();
  });

  test("empty approvals queue", async ({ page }) => {
    const { api } = await open(page, "/approvals");
    api.override(/GET \/approvals/, () => ({ body: { linearConfigured: true, decisions: [], tasks: [], conflicts: [], sync: [] } }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Nothing waiting for approval" })).toBeVisible();
  });
});

test.describe("G. Tasks and Linear", () => {
  test("proposed tasks, approval, and Linear sync states", async ({ page }) => {
    const { api, errors } = await open(page, "/approvals");
    await expect(page.getByRole("heading", { name: /Proposed tasks/ })).toBeVisible();
    const t = page.locator("li.item", { hasText: "Move the launch announcement to November 22" });
    await expect(t).toContainText("Owner Ana");
    await t.getByRole("button", { name: "Approve & send to Linear" }).click();
    await expect(page.locator("li.item", { hasText: "Move the launch announcement" }).getByText("Not sent yet")).toBeVisible();
    // Already-synced task shows its link and offers no re-send (idempotency in the UI).
    const synced = page.locator("li.item", { hasText: "Draft the beta announcement" });
    await expect(synced.getByText("In Linear", { exact: true })).toBeVisible();
    await expect(synced.getByRole("link", { name: "Open in Linear" })).toHaveAttribute("href", /linear\.app\/example\/issue\/ATL-12/);
    await expect(synced.getByRole("button", { name: /Send to Linear|Retry sync/ })).toHaveCount(0);
    // Failed sync offers a retry and states that no issue was recorded.
    const failed = page.locator("li.item", { hasText: "Set up the staging environment" });
    await expect(failed).toContainText("Sync failed");
    await expect(failed).toContainText("no Linear issue was recorded");
    await failed.getByRole("button", { name: "Retry sync" }).click();
    await expect(page.locator("li.item", { hasText: "Set up the staging environment" }).getByText("In Linear", { exact: true })).toBeVisible();
    expect(api.calls.filter((c) => c.includes("/sync"))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("reject a task; sync error surfaces inline", async ({ page }) => {
    const { api, errors } = await open(page, "/approvals");
    api.override(/POST \/tasks\/.+\/sync/, () => ({ status: 502, body: { error: "Linear rejected the request." } }));
    await page.locator("li.item", { hasText: "Set up the staging environment" }).getByRole("button", { name: "Retry sync" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Linear rejected the request." })).toBeVisible();
    await page.locator("li.item", { hasText: "Book the security review" }).getByRole("button", { name: "Reject" }).click();
    await expect(page.locator("li.item", { hasText: "Book the security review" })).toHaveCount(0);
    expect(noUnexpected(errors)).toEqual([]);
  });

  test("Linear not configured: approve is local-only and says so", async ({ page }) => {
    await open(page, "/approvals", { linearConfigured: false });
    await expect(page.getByRole("button", { name: "Approve & send to Linear" })).toHaveCount(0);
    await expect(page.getByText(/Linear is not configured on the server/).first()).toBeVisible();
  });
});

test.describe("H. Reminders and digests", () => {
  test("reminder inbox and preview never claim delivery", async ({ page }) => {
    const { api, errors } = await open(page, "/reminders");
    await expect(page.getByText("In-app only.")).toBeVisible();
    await expect(page.getByText("nothing below has been delivered", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Reminder inbox · 1 unread/ })).toBeVisible();
    await expect(page.getByText("Generated · not delivered").first()).toBeVisible();
    await expect(page.getByText(/Delivered$/)).toHaveCount(0);
    await expect(page.getByText("1 new · 1 already generated")).toBeVisible();
    await expect(page.getByText("Already generated", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Generate reminders" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Nothing was sent anywhere" })).toBeVisible();
    await page.getByRole("button", { name: "Mark read" }).click();
    await expect(page.getByRole("heading", { name: /0 unread/ })).toBeVisible();
    expect(api.calls).toContain("POST /reminders/generate");
    expect(errors).toEqual([]);
  });

  test("window selector requests a new preview", async ({ page }) => {
    const { api } = await open(page, "/reminders");
    await page.getByLabel("Remind this long before the due date").selectOption("72");
    await expect.poll(() => api.calls.filter((c) => c === "GET /reminders/preview").length).toBeGreaterThan(1);
  });

  test("empty reminders", async ({ page }) => {
    const { api } = await open(page, "/reminders");
    api.override(/GET \/reminders\/preview/, () => ({ body: { windowHours: 24, asOf: "2026-11-01T09:00:00.000Z", delivery: { mode: "in-app", externalDelivery: "not_available", note: "In-app only." }, items: [], counts: { new: 0, alreadyGenerated: 0 } } }));
    api.override(/GET \/reminders$/, () => ({ body: { delivery: { mode: "in-app", externalDelivery: "not_available", note: "In-app only." }, reminders: [], unread: 0 } }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Nothing to remind about" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No reminders yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate reminders" })).toBeDisabled();
  });

  test("weekly digest groups tasks by owner and saving says nothing was sent", async ({ page }) => {
    const { errors } = await open(page, "/reminders");
    await page.getByRole("tab", { name: "Weekly digests" }).click();
    await expect(page.getByRole("heading", { name: "Week of Mon, Oct 26" })).toBeVisible();
    await expect(page.getByText("1 overdue · 2 upcoming · 1 completed")).toBeVisible();
    const ana = page.locator("li.item", { has: page.getByRole("heading", { name: "Ana" }) });
    await expect(ana).toContainText("2 days overdue");
    const unassigned = page.locator("li.item", { has: page.getByRole("heading", { name: /Unassigned/ }) });
    await expect(unassigned).toContainText("Not a known person · preview only");
    await expect(page.getByText("No digests saved yet.")).toBeVisible();
    await page.getByRole("button", { name: /Generate this week/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Nothing was sent." })).toBeVisible();
    await expect(page.getByText("Saved · not delivered").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("tabs support arrow-key navigation", async ({ page }) => {
    await open(page, "/reminders");
    await page.getByRole("tab", { name: "Reminders" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Weekly digests" })).toHaveAttribute("aria-selected", "true");
  });

  test("empty digest", async ({ page }) => {
    const { api } = await open(page, "/reminders");
    api.override(/GET \/digests\/preview/, () => ({ body: { weekStart: "2026-10-26", weekEnd: "2026-11-01", today: "2026-11-01", delivery: { mode: "in-app", externalDelivery: "not_available", note: "In-app only." }, owners: [], totals: { overdue: 0, upcoming: 0, completed: 0 } } }));
    await page.getByRole("tab", { name: "Weekly digests" }).click();
    await expect(page.getByRole("heading", { name: "Nothing to report this week" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Generate this week/ })).toBeDisabled();
  });

  test("People page is an honest placeholder", async ({ page }) => {
    await open(page, "/people");
    await expect(page.getByRole("heading", { name: "Per-person pages are not built yet" })).toBeVisible();
  });
});

test.describe("I. Edge cases", () => {
  test("long decision and task titles wrap without horizontal overflow", async ({ page }) => {
    await open(page, "/approvals");
    await expect(page.getByText(/Adopt a design-review checkpoint/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("server health indicator shows the unreachable state when /health fails", async ({ page }) => {
    const { api, errors } = await open(page, "/");
    api.override(/GET \/health/, () => ({ abort: true }));
    await page.reload();
    await expect(page.getByText(/API unreachable/)).toBeVisible();
    expect(noUnexpected(errors)).toEqual([]);
  });

  test("API unreachable at start shows a retry screen instead of a blank page", async ({ page }) => {
    const { api, errors } = await open(page, "/");
    api.override(/GET \/auth\/config/, () => ({ abort: true }));
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Could not reach the Recall server");
    expect(noUnexpected(errors)).toEqual([]);
  });

  test("sign-in not configured on the server", async ({ page }) => {
    const { api } = await open(page, "/login", { signedIn: false });
    api.override(/GET \/auth\/config/, () => ({ body: { enabled: false } }));
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Sign-in is not configured on this server");
  });
});

const ROUTES = ["/login", "/", "/meetings/new", M(2), M(3), M(4), "/approvals", "/reminders", "/people", "/nope"];
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
  { name: "small-mobile", width: 375, height: 812 },
];

test.describe("Responsive layout", () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} ${vp.width}x${vp.height}: no horizontal overflow, no clipped controls, no console errors`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const problems: string[] = [];
      for (const route of ROUTES) {
        const errors: string[] = [];
        const onConsole = (m: import("@playwright/test").ConsoleMessage) => m.type() === "error" && errors.push(m.text());
        page.on("console", onConsole);
        if (route === "/login") {
          await page.unroute("**/api/**").catch(() => undefined);
          await installMock(page, { signedIn: false });
        } else if (route === ROUTES[1]) {
          await page.unroute("**/api/**").catch(() => undefined);
          await installMock(page);
        }
        await page.goto(route);
        await page.waitForLoadState("networkidle");
        const r = await page.evaluate(() => {
          const doc = document.documentElement;
          const clipped: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>("button, a.btn-primary, a.btn-secondary, input, select, textarea")) {
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) continue;
            const scroller = el.closest("nav");
            if (!scroller && (b.right > doc.clientWidth + 1 || b.left < -1)) clipped.push(`${el.tagName} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}"`);
          }
          return { overflow: doc.scrollWidth - doc.clientWidth, clipped };
        });
        if (r.overflow > 0) problems.push(`${route}: horizontal overflow ${r.overflow}px`);
        if (r.clipped.length) problems.push(`${route}: clipped ${r.clipped.join(", ")}`);
        if (errors.length) problems.push(`${route}: console ${errors.join(" | ")}`);
        page.off("console", onConsole);
      }
      expect(problems).toEqual([]);
    });
  }

  test("mobile primary navigation reaches every page", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, "/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const name of ["New meeting", "Approvals", "Reminders & digests", "People", "Meetings"]) {
      const link = nav.getByRole("link", { name });
      await link.scrollIntoViewIfNeeded();
      await link.click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
  });
});

test.describe("Keyboard and accessibility", () => {
  test("skip link is first in tab order and moves focus to main", async ({ page }) => {
    await open(page, "/");
    await expect(page.getByRole("heading", { name: "Meetings", level: 1 })).toBeVisible();
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("focused controls have a visible focus indicator", async ({ page }) => {
    await open(page, "/approvals");
    await expect(page.getByRole("heading", { name: /Conflicts to resolve/ })).toBeVisible();
    const missing: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        const visible = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none";
        return { visible, label: `${el.tagName} ${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}` };
      });
      if (info && !info.visible) missing.push(info.label);
    }
    expect(missing).toEqual([]);
  });

  for (const [name, route, opts] of [
    ["login", "/login", { signedIn: false }],
    ["meetings", "/", {}],
    ["new meeting", "/meetings/new", {}],
    ["meeting detail", M(2), {}],
    ["approvals", "/approvals", {}],
    ["reminders", "/reminders", {}],
  ] as const) {
    test(`axe: no serious or critical violations on ${name}`, async ({ page }) => {
      await open(page, route, opts);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(400);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("; ")}`)).toEqual([]);
    });
  }
});
