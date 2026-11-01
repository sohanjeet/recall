// REAL: meeting ingestion → Groq extraction → evidence verification → approvals → conflict detection and resolution,
// through the real UI, API, Postgres and Groq, with the dedicated test account on the isolated test project.
//
// Real model output varies, so assertions target invariants (a decision exists, every stored quote is in the
// transcript, a contradicting decision is flagged) and not exact wording. Every run uses a unique token so
// leftovers from earlier runs on the same disposable database cannot affect the conflict search.
// Skipped unless RECALL_REAL_E2E=1 and the safety gate in config.ts passes. No Linear credentials reach the server here.
import { expect, test, type Page } from "@playwright/test";
import type { Decision, MeetingDetail, MeetingSummary, Task } from "@recall/shared";
import { api, createMeetingViaUi, normalize, readyConfig, runToken, signIn, skipUnlessReal } from "./helpers";

const T = runToken();

const FIRST = {
  title: `E2E ${T} kickoff`,
  date: "2027-02-01",
  participants: "Priya, Sam",
  transcript: [
    `Priya: Let's settle the ${T} launch date. I propose we launch ${T} on March 14, 2027.`,
    `Sam: Agreed. We will launch ${T} on March 14, 2027.`,
    `Priya: Sam, please send the ${T} launch checklist to the whole team by March 1, 2027.`,
  ].join("\n"),
};
const SECOND = {
  title: `E2E ${T} replan`,
  date: "2027-02-15",
  participants: "Priya, Sam, Ana",
  transcript: [
    `Priya: Update on ${T}. The vendor slipped, so we are moving the ${T} launch from March 14 to April 4, 2027.`,
    `Sam: Confirmed. The ${T} launch is now April 4, 2027, and March 14 is cancelled.`,
    `Ana: I will update the ${T} launch plan by February 20, 2027.`,
  ].join("\n"),
};

test.describe.configure({ mode: "serial" });

test.describe("Real: ingestion, extraction, approvals and conflicts", () => {
  skipUnlessReal(test);
  const real = readyConfig();
  let page: Page;
  let first: MeetingDetail;
  let second: MeetingDetail;

  test.beforeAll(async ({ browser }) => {
    if (!real) return;
    page = await (await browser.newContext()).newPage();
    await signIn(page, real.account);
  });
  test.afterAll(async () => {
    await page?.context().close();
  });

  const summaryFor = async (id: string) => (await api<MeetingSummary[]>(page, "GET", "/meetings")).find((m) => m.id === id)!;
  const tagFor = (title: string) => page.locator("ul.divide-y > li", { hasText: title });

  test("ingests a transcript and Groq extracts decisions and tasks", async () => {
    const id = await createMeetingViaUi(page, FIRST);
    // "Save and analyze" calls the real model; the detail page shows the drafts once it returns.
    await expect(page.getByRole("heading", { name: /^Decisions/ })).toBeVisible({ timeout: 120_000 });
    first = await api<MeetingDetail>(page, "GET", `/meetings/${id}`);

    expect(first.status).toBe("extracted");
    expect(first.segments).toHaveLength(3);
    expect(first.decisions.length).toBeGreaterThan(0);
    expect(first.tasks.length).toBeGreaterThan(0);
    for (const d of first.decisions) expect(d.status).toBe("proposed");
    // The model was told to name the owner and deadline: the checklist task should carry both.
    const checklist = first.tasks.find((t) => /checklist/i.test(t.title));
    expect(checklist, "a checklist task").toBeTruthy();
    expect(checklist!.ownerName ?? "").toMatch(/sam/i);
    expect(checklist!.dueDate).toBe("2027-03-01");
  });

  test("every stored evidence quote really appears in the transcript", async () => {
    const haystack = first.segments.map((s) => normalize(s.text));
    const items: (Decision | Task)[] = [...first.decisions, ...first.tasks];
    const quotes = items.flatMap((i) => i.evidence.map((e) => e.quote));
    expect(quotes.length, "at least one verified quote").toBeGreaterThan(0);
    for (const q of quotes) {
      // Ellipsis-joined fragments must each occur, in order, within one segment.
      const fragments = q.split(/\s*(?:\.{3,}|…)\s*/u).map(normalize).filter(Boolean);
      const ok = haystack.some((seg) => {
        let from = 0;
        return fragments.every((f) => {
          const at = seg.indexOf(f, from);
          from = at + f.length;
          return at >= 0;
        });
      });
      expect(ok, `quote not found in transcript: “${q}”`).toBe(true);
    }
    // And the UI shows them.
    await page.goto(`/meetings/${first.id}`);
    await expect(page.getByText(`“${quotes[0]}”`).first()).toBeVisible();
  });

  test("the dashboard reports the meeting as awaiting approval, not as drafts ready", async () => {
    await page.goto("/");
    const row = tagFor(FIRST.title);
    await expect(row).toContainText("awaiting approval");
    await expect(row).not.toContainText("Drafts ready");
    const s = await summaryFor(first.id);
    expect(s.pendingDecisionCount).toBe(first.decisions.length);
    expect(s.pendingTaskCount).toBe(first.tasks.length);
    expect(s.openConflictCount).toBe(0);
  });

  test("approving decisions in the UI makes them active and writes an audit trail", async () => {
    await page.goto("/approvals");
    for (const d of first.decisions) {
      const item = page.locator("li.item", { hasText: d.summary });
      await item.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.locator("li.item", { hasText: d.summary })).toHaveCount(0);
    }
    const after = await api<MeetingDetail>(page, "GET", `/meetings/${first.id}`);
    for (const d of after.decisions) {
      expect(d.status).toBe("active");
      expect(d.approvedAt).not.toBeNull();
      const audit = await api<{ action: string; actor: string }[]>(page, "GET", `/audit?entityType=decision&entityId=${d.id}`);
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.every((a) => a.actor.trim().length > 0)).toBe(true);
    }
    first = after;
  });

  test("approving a task stays local when Linear is not configured: nothing is sent anywhere", async () => {
    const task = first.tasks[0]!;
    await page.goto("/approvals");
    const item = page.locator("li.item", { hasText: task.title }).first();
    await item.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText(/Linear is not configured on the server/).first()).toBeVisible();
    const after = await api<MeetingDetail>(page, "GET", `/meetings/${first.id}`);
    const approved = after.tasks.find((t) => t.id === task.id)!;
    expect(approved.status).toBe("approved");
    expect(approved.externalId).toBeNull();
    expect(approved.externalUrl).toBeNull();
    expect(approved.syncStatus).toBeNull();
  });

  test("a later meeting that contradicts an approved decision is flagged and blocks approval until resolved", async () => {
    const id = await createMeetingViaUi(page, SECOND);
    await expect(page.getByRole("heading", { name: /^Decisions/ })).toBeVisible({ timeout: 120_000 });
    second = await api<MeetingDetail>(page, "GET", `/meetings/${id}`);

    expect(second.conflictCheck.status).toBe("done");
    expect(second.conflicts.length, "conflict against the approved launch-date decision").toBeGreaterThan(0);
    const previousIds = new Set(first.decisions.map((d) => d.id));
    const conflict = second.conflicts.find((c) => previousIds.has(c.conflictingDecisionId))!;
    expect(conflict, "a conflict pointing at the earlier approved decision").toBeTruthy();
    expect(conflict.resolution).toBe("open");
    expect(conflict.explanation.length).toBeGreaterThan(0);
    // The earlier decision is never modified by detection.
    expect(conflict.previousDecision.status).toBe("active");

    // The meeting page and the dashboard both say so.
    await expect(page.getByRole("heading", { name: /Conflicts with earlier decisions/ })).toBeVisible();
    await page.goto("/");
    await expect(tagFor(SECOND.title)).toContainText(/open conflicts?/);

    // A clear conflict cannot be approved from the queue.
    if (conflict.certainty === "clear") {
      await page.goto("/approvals");
      const item = page.locator("li.item", { hasText: conflict.decision.summary }).first();
      await expect(item.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
      await expect(item).toContainText("Cannot be approved until its conflict is resolved below.");
    }
  });

  test("accepting the new decision supersedes the old one and clears the warning", async () => {
    const previousIds = new Set(first.decisions.map((d) => d.id));
    const open = second.conflicts.filter((c) => previousIds.has(c.conflictingDecisionId) && c.resolution === "open");
    expect(open.length).toBeGreaterThan(0);

    // Resolve through the API-backed UI one conflict at a time until none of this run's conflicts remain open.
    await page.goto("/approvals");
    for (const c of open) {
      const card = page.locator("li", { hasText: c.decision.summary }).filter({ has: page.getByRole("button", { name: "Accept new decision" }) }).first();
      await card.getByRole("button", { name: "Accept new decision" }).click();
      await expect(page.locator("li", { hasText: c.decision.summary }).getByRole("button", { name: "Accept new decision" })).toHaveCount(0);
    }

    const after = await api<MeetingDetail>(page, "GET", `/meetings/${second.id}`);
    expect(after.conflicts.filter((c) => c.resolution === "open" && previousIds.has(c.conflictingDecisionId))).toHaveLength(0);
    const resolved = after.conflicts.find((c) => c.id === open[0]!.id)!;
    expect(resolved.resolution).toBe("kept_new");
    expect(after.decisions.find((d) => d.id === resolved.decisionId)!.status).toBe("active");
    expect(resolved.previousDecision.status).toBe("superseded");

    await page.goto("/");
    await expect(tagFor(SECOND.title)).not.toContainText("open conflict");
  });
});
