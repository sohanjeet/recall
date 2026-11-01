// Deterministic in-memory stand-in for the Recall API and Supabase Auth, installed through Playwright route
// interception. Nothing here talks to the real database, Groq, Linear or Supabase. The data is fixture data shaped
// like a "Project Atlas" workspace; it is not read from, and never written to, the real Project Atlas records.
import type { Page, Route } from "@playwright/test";
import type {
  ApprovalsResponse,
  Decision,
  DeliveryInfo,
  DigestPreview,
  Evidence,
  MeetingConflict,
  MeetingDetail,
  MeetingSummary,
  ReminderInbox,
  ReminderPreview,
  Task,
  TranscriptSegment,
} from "../packages/shared/src/index.ts";

export const MOCK_SUPABASE = "https://mock-project.supabase.test";
export const MOCK_USER = { id: "11111111-1111-4111-8111-111111111111", email: "qa.reviewer@example.com" };
const NOW = "2026-11-01T09:00:00.000Z";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ev = (n: number, quote: string): Evidence => ({ id: id(9000 + n), segmentId: null, quote });

const DELIVERY: DeliveryInfo = {
  mode: "in-app",
  externalDelivery: "not_available",
  note: "Reminders and digests are visible in Recall only; no email or chat provider is connected.",
};

export interface MockOptions {
  /** Signed-in browser session (default true). */
  signedIn?: boolean;
  /** Delay every /api response by this many ms (loading-state captures). */
  delayMs?: number;
  linearConfigured?: boolean;
}

export type Handler = (ctx: { url: URL; method: string; body: any; route: Route }) => unknown | Promise<unknown>;

export class MockApi {
  decisions: Record<string, Decision & { meetingTitle?: string }> = {};
  tasks: Record<string, Task & { meetingTitle?: string }> = {};
  conflicts: MeetingConflict[] = [];
  meetings: MeetingDetail[] = [];
  calls: string[] = [];
  overrides: { match: RegExp; handler: Handler }[] = [];
  reminders: ReminderInbox["reminders"] = [];
  digestsStored = 0;
  linearConfigured: boolean;
  delayMs: number;

  constructor(opts: MockOptions = {}) {
    this.linearConfigured = opts.linearConfigured ?? true;
    this.delayMs = opts.delayMs ?? 0;
    this.seed();
  }

  private segments(meetingN: number, lines: [string, string][]): TranscriptSegment[] {
    return lines.map(([speakerLabel, text], i) => ({ id: id(meetingN * 100 + i), meetingId: id(meetingN), seq: i, speakerLabel, personId: null, text }));
  }

  private seed() {
    const m = (n: number, over: Partial<MeetingDetail>): MeetingDetail => ({
      id: id(n),
      title: "",
      occurredAt: "2026-10-20T00:00:00.000Z",
      source: "paste",
      rawTranscript: "",
      status: "extracted",
      participants: ["Sam", "Ana", "Priya"],
      error: null,
      createdAt: NOW,
      segments: [],
      decisions: [],
      tasks: [],
      ambiguities: [],
      conflicts: [],
      conflictCheck: { status: "done", error: null, checkedAt: NOW },
      ...over,
    });
    const dec = (n: number, meetingN: number, status: Decision["status"], summary: string, rationale: string | null, quote: string | null, over: Partial<Decision> = {}): Decision => ({
      id: id(n), meetingId: id(meetingN), summary, rationale, status, supersededBy: null, approvedAt: status === "active" ? NOW : null, rejectedAt: null, version: 1,
      evidence: quote ? [ev(n, quote)] : [], createdAt: NOW, ...over,
    });
    const task = (n: number, meetingN: number, status: Task["status"], title: string, owner: string | null, due: string | null, phrase: string | null, quote: string | null, over: Partial<Task> = {}): Task => ({
      id: id(n), meetingId: id(meetingN), title, description: null, ownerPersonId: owner ? id(7000 + owner.length) : null, ownerName: owner, dueDate: due, duePhrase: phrase,
      status, approvedAt: ["approved", "synced", "done"].includes(status) ? NOW : null, rejectedAt: null, version: 1, syncStatus: null, syncError: null, syncAttempts: 0,
      externalProvider: null, externalId: null, externalUrl: null, evidence: quote ? [ev(n, quote)] : [], createdAt: NOW, ...over,
    });

    // Meeting 1: Atlas kickoff — approved history.
    const d1 = dec(11, 1, "active", "Launch the Atlas beta on November 15", "Marketing needs two weeks of lead time after the beta ships.", "We are shipping the beta on November 15, no later.");
    const d2 = dec(12, 1, "active", "Store all Atlas data in Postgres on Supabase", "One managed database keeps operations simple for a team of three.", "Let's put everything in Postgres on Supabase.");
    const t1 = task(21, 1, "synced", "Draft the beta announcement", "Ana", "2026-11-08", "by next Saturday", "Ana, can you draft the announcement by next Saturday?", {
      externalProvider: "linear", externalId: "ATL-12", externalUrl: "https://linear.app/example/issue/ATL-12/draft-the-beta-announcement",
    });
    const t2 = task(22, 1, "approved", "Set up the staging environment", "Sam", "2026-11-05", "Wednesday", "Sam will set up staging by Wednesday.", { syncStatus: "failed", syncError: "Linear request timed out", syncAttempts: 1 });
    const m1 = m(1, {
      title: "Atlas kickoff", occurredAt: "2026-10-20T00:00:00.000Z",
      segments: this.segments(1, [["Sam", "We are shipping the beta on November 15, no later."], ["Priya", "Let's put everything in Postgres on Supabase."], ["Sam", "Sam will set up staging by Wednesday."], ["Ana", "Ana, can you draft the announcement by next Saturday?"]]),
      decisions: [d1, d2], tasks: [t1, t2],
    });

    // Meeting 2: Atlas planning sync — drafts and open conflicts.
    const d3 = dec(13, 2, "proposed", "Move the Atlas beta launch to November 22", "The security review will not finish before November 15.", "Given the security review, let's move the beta to November 22.");
    const d4 = dec(14, 2, "proposed", "Increase the Atlas infrastructure budget to $4,000 a month", null, "We might need to raise the infra budget, maybe four thousand.");
    const d5 = dec(15, 2, "proposed", "Adopt a design-review checkpoint before every release that touches the approvals flow, including conflict resolution, Linear sync, reminders, weekly digests and any other user-facing change that the whole team agreed on during the planning meeting", "Long title fixture.", "Let's add a design review before every release.");
    const t3 = task(23, 2, "proposed", "Move the launch announcement to November 22", "Ana", null, "after the review", "Ana, push the announcement out a week.");
    const t4 = task(24, 2, "proposed", "Book the security review", null, null, null, null);
    const t5 = task(25, 2, "proposed", "Write the release notes for the beta, covering the approvals flow, conflict detection, Linear sync and the reminder inbox in enough detail for support", "Priya", "2026-11-19", "by the 19th", "Priya, release notes by the 19th.");
    const c1: MeetingConflict = {
      id: id(31), decisionId: d3.id, conflictingDecisionId: d1.id, meetingId: id(2), kind: "deadline", relation: "changes", certainty: "clear",
      explanation: "The new decision moves the beta launch a week later than the date approved in the kickoff.", previousValue: "Nov 15", newValue: "Nov 22",
      evidenceQuote: "Given the security review, let's move the beta to November 22.", resolution: "open", resolvedAt: null, createdAt: NOW,
      decision: { id: d3.id, summary: d3.summary, evidence: d3.evidence },
      previousDecision: { id: d1.id, summary: d1.summary, rationale: d1.rationale, status: "active", meetingId: id(1), meetingTitle: "Atlas kickoff", meetingOccurredAt: m1.occurredAt, evidence: d1.evidence },
    };
    const c2: MeetingConflict = {
      id: id(32), decisionId: d4.id, conflictingDecisionId: d2.id, meetingId: id(2), kind: "budget", relation: "contradicts", certainty: "uncertain",
      explanation: "A budget increase may or may not relate to the earlier database decision; the speaker was hedging.", previousValue: null, newValue: null,
      evidenceQuote: "We might need to raise the infra budget, maybe four thousand.", resolution: "open", resolvedAt: null, createdAt: NOW,
      decision: { id: d4.id, summary: d4.summary, evidence: d4.evidence },
      previousDecision: { id: d2.id, summary: d2.summary, rationale: d2.rationale, status: "active", meetingId: id(1), meetingTitle: "Atlas kickoff", meetingOccurredAt: m1.occurredAt, evidence: d2.evidence },
    };
    const m2 = m(2, {
      title: "Atlas planning sync", occurredAt: "2026-10-27T00:00:00.000Z",
      segments: this.segments(2, [["Sam", "Given the security review, let's move the beta to November 22."], ["Ana", "Ana, push the announcement out a week."], ["Priya", "We might need to raise the infra budget, maybe four thousand."], ["Priya", "Priya, release notes by the 19th."], ["Sam", "Let's add a design review before every release."]]),
      decisions: [d3, d4, d5], tasks: [t3, t4, t5], conflicts: [c1, c2],
      ambiguities: [{ id: id(41), meetingId: id(2), description: "No owner was named for the security review booking.", quote: "Someone should book the security review." }],
    });

    // Meeting 3: Vendor review — one resolved conflict of each outcome.
    const d6 = dec(16, 3, "active", "Switch Atlas error tracking to the new vendor", null, "We'll switch error tracking over to the new vendor.", { approvedAt: NOW });
    const d7 = dec(17, 3, "rejected", "Move Atlas hosting to a second region", null, "Could we host in a second region too?", { rejectedAt: NOW });
    const d8 = dec(18, 3, "proposed", "Pause new Atlas feature work during the audit", null, "I'd pause feature work while the audit runs.");
    const prev = (d: Decision, status: Decision["status"]): MeetingConflict["previousDecision"] => ({ id: d.id, summary: d.summary, rationale: d.rationale, status, meetingId: id(1), meetingTitle: "Atlas kickoff", meetingOccurredAt: m1.occurredAt, evidence: d.evidence });
    const mk = (n: number, d: Decision, old: Decision, oldStatus: Decision["status"], res: MeetingConflict["resolution"], over: Partial<MeetingConflict>): MeetingConflict => ({
      id: id(n), decisionId: d.id, conflictingDecisionId: old.id, meetingId: id(3), kind: "scope", relation: "changes", certainty: "clear", explanation: "", previousValue: null, newValue: null,
      evidenceQuote: d.evidence[0]?.quote ?? null, resolution: res, resolvedAt: NOW, createdAt: NOW,
      decision: { id: d.id, summary: d.summary, evidence: d.evidence }, previousDecision: prev(old, oldStatus), ...over,
    });
    const oldErr = dec(19, 1, "superseded", "Keep Atlas error tracking in-house", null, "We'll keep error tracking in-house for now.", { supersededBy: d6.id });
    const c3 = mk(33, d6, oldErr, "superseded", "kept_new", { kind: "scope", explanation: "The vendor switch replaces the in-house error-tracking decision." });
    const c4 = mk(34, d7, d2, "active", "kept_old", { kind: "scope", certainty: "clear", explanation: "A second hosting region conflicts with the single-database decision.", previousValue: "One region", newValue: "Two regions" });
    const c5 = mk(35, d8, d1, "active", "dismissed", { kind: "other", certainty: "uncertain", relation: "contradicts", explanation: "Pausing feature work may touch the launch date, but nothing was said about it." });
    const m3 = m(3, {
      title: "Vendor review", occurredAt: "2026-10-29T00:00:00.000Z",
      segments: this.segments(3, [["Priya", "We'll switch error tracking over to the new vendor."], ["Sam", "Could we host in a second region too?"], ["Ana", "I'd pause feature work while the audit runs."]]),
      decisions: [d6, d7, d8], tasks: [], conflicts: [c3, c4, c5],
    });
    const m4 = m(4, { title: "Atlas retro (analysis failed)", occurredAt: "2026-10-30T00:00:00.000Z", status: "failed", error: "The model response could not be parsed. Retry the analysis.", conflictCheck: { status: null, error: null, checkedAt: null }, segments: this.segments(4, [["Sam", "Retro notes go here."]]) });
    const m5 = m(5, { title: "Atlas standup", occurredAt: "2026-10-31T00:00:00.000Z", status: "ingested", conflictCheck: { status: null, error: null, checkedAt: null }, segments: this.segments(5, [["Ana", "Quick standup, nothing decided."]]) });

    this.meetings = [m5, m4, m3, m2, m1];
    for (const mt of this.meetings) {
      for (const d of mt.decisions) this.decisions[d.id] = { ...d, meetingTitle: mt.title };
      for (const t of mt.tasks) this.tasks[t.id] = { ...t, meetingTitle: mt.title };
    }
    this.decisions[oldErr.id] = { ...oldErr, meetingTitle: "Atlas kickoff" };
    // d8 is a draft only so the dismissed outcome has a live decision to point at.
    this.conflicts = [c1, c2, c3, c4, c5];

    const ref = (t: Task) => ({ taskId: t.id, title: t.title, dueDate: t.dueDate, status: t.status, ownerName: t.ownerName, meeting: { id: id(1), title: "Atlas kickoff", occurredAt: m1.occurredAt }, linearUrl: t.externalUrl });
    this.reminders = [
      { ...ref(t2), id: id(51), remindAt: "2026-11-04T00:00:00.000Z", windowHours: 24, generatedAt: NOW, readAt: null, deliveredAt: null, taskOpen: true },
      { ...ref(t1), id: id(52), remindAt: "2026-11-07T00:00:00.000Z", windowHours: 24, generatedAt: NOW, readAt: NOW, deliveredAt: null, taskOpen: true },
    ];
  }

  private syncViews() {
    for (const mt of this.meetings) {
      mt.decisions = mt.decisions.map((d) => ({ ...this.decisions[d.id]! }));
      mt.conflicts = this.conflicts
        .filter((c) => c.meetingId === mt.id)
        .map((c) => ({ ...c, previousDecision: { ...c.previousDecision, status: this.decisions[c.conflictingDecisionId]?.status ?? c.previousDecision.status } }));
    }
  }

  summaries(): MeetingSummary[] {
    return this.meetings.map(({ id, title, occurredAt, source, status, participants, decisions, tasks, createdAt }) => ({ id, title, occurredAt, source, status, participants, decisionCount: decisions.length, taskCount: tasks.length, createdAt }));
  }

  approvals(): ApprovalsResponse {
    const openFor = (decisionId: string) => this.conflicts.filter((c) => c.decisionId === decisionId && c.resolution === "open").map((c) => ({ id: c.id, certainty: c.certainty }));
    return {
      linearConfigured: this.linearConfigured,
      decisions: Object.values(this.decisions).filter((d) => d.status === "proposed").map((d) => ({ ...d, meetingTitle: d.meetingTitle ?? "", openConflicts: openFor(d.id) })),
      tasks: Object.values(this.tasks).filter((t) => t.status === "proposed").map((t) => ({ ...t, meetingTitle: t.meetingTitle ?? "" })),
      conflicts: this.conflicts.filter((c) => c.resolution === "open"),
      sync: Object.values(this.tasks).filter((t) => t.status === "approved" || t.status === "synced").map((t) => ({ ...t, meetingTitle: t.meetingTitle ?? "" })),
    };
  }

  reminderPreview(): ReminderPreview {
    const t = this.tasks[id(22)]!;
    return {
      windowHours: 24, asOf: NOW, delivery: DELIVERY, counts: { new: 1, alreadyGenerated: 1 },
      items: [
        { taskId: t.id, title: t.title, dueDate: t.dueDate, status: t.status, ownerName: t.ownerName, meeting: { id: id(1), title: "Atlas kickoff", occurredAt: "2026-10-20T00:00:00.000Z" }, linearUrl: null, remindAt: "2026-11-04T00:00:00.000Z", hoursUntilDue: 96, alreadyGenerated: true },
        { taskId: id(26), title: "Send the security questionnaire to the vendor", dueDate: "2026-11-03", status: "approved", ownerName: "Priya", meeting: { id: id(2), title: "Atlas planning sync", occurredAt: "2026-10-27T00:00:00.000Z" }, linearUrl: null, remindAt: "2026-11-02T00:00:00.000Z", hoursUntilDue: 48, alreadyGenerated: false },
      ],
    };
  }

  digest(): DigestPreview {
    const task = (n: number, title: string, owner: string, due: string, days: number | null, status: Task["status"], linearUrl: string | null = null) => ({
      taskId: id(n), title, dueDate: due, status, ownerName: owner, meeting: { id: id(1), title: "Atlas kickoff", occurredAt: "2026-10-20T00:00:00.000Z" }, linearUrl, daysOverdue: days, completedAt: days === null ? NOW : null,
    });
    return {
      weekStart: "2026-10-26", weekEnd: "2026-11-01", today: "2026-11-01", delivery: DELIVERY,
      totals: { overdue: 1, upcoming: 2, completed: 1 },
      owners: [
        { personId: id(7003), ownerName: "Ana", overdue: [task(27, "Review the beta pricing page", "Ana", "2026-10-30", 2, "approved")], upcoming: [task(21, "Draft the beta announcement", "Ana", "2026-11-08", -7, "synced", "https://linear.app/example/issue/ATL-12/draft-the-beta-announcement")], completed: [] },
        { personId: id(7004), ownerName: "Sam", overdue: [], upcoming: [task(22, "Set up the staging environment", "Sam", "2026-11-05", -4, "approved")], completed: [task(28, "Rotate the staging credentials", "Sam", "2026-10-29", null, "done")] },
        { personId: null, ownerName: "Unassigned", overdue: [], upcoming: [], completed: [] },
      ],
    };
  }

  // ---- request routing ----

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
    this.calls.push(`${method} ${path}`);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

    for (const o of this.overrides) {
      if (o.match.test(`${method} ${path}`)) {
        const out = await o.handler({ url, method, body, route });
        if (out === undefined) return;
        const r = out as { status?: number; body?: unknown; abort?: boolean };
        if (r.abort) return route.abort("connectionrefused");
        return json(r.body, r.status ?? 200);
      }
    }

    this.syncViews();
    let m: RegExpMatchArray | null;
    if (path === "/health") return json({ status: "ok", version: "0.1.0", uptimeSeconds: 120, services: { database: "ok", groq: "ok", taskTracker: this.linearConfigured ? "ok" : "unconfigured", email: "unconfigured" } });
    if (path === "/auth/config") return json({ enabled: true, supabaseUrl: MOCK_SUPABASE, supabaseAnonKey: "mock-anon-key" });
    if (path === "/me") return json(MOCK_USER);
    if (path === "/meetings" && method === "GET") return json(this.summaries());
    if (path === "/meetings" && method === "POST") {
      const created: MeetingDetail = { ...this.meetings[this.meetings.length - 1]!, id: id(100 + this.meetings.length), title: body.title, participants: body.participants, status: "ingested", decisions: [], tasks: [], conflicts: [], ambiguities: [], conflictCheck: { status: null, error: null, checkedAt: null }, segments: [], rawTranscript: body.transcript };
      this.meetings.unshift(created);
      return json(created, 201);
    }
    if ((m = path.match(/^\/meetings\/([^/]+)\/analyze$/))) return json(this.meetings.find((x) => x.id === m![1]));
    if ((m = path.match(/^\/meetings\/([^/]+)$/))) {
      const found = this.meetings.find((x) => x.id === m![1]);
      return found ? json(found) : json({ error: "Meeting not found" }, 404);
    }
    if (path === "/approvals") return json(this.approvals());
    if (path === "/audit") return json([{ id: "1", entityType: "decision", entityId: url.searchParams.get("entityId"), meetingId: null, action: "created", fromStatus: null, toStatus: "proposed", actor: MOCK_USER.email, details: {}, createdAt: NOW }]);
    if ((m = path.match(/^\/decisions\/([^/]+)\/(approve|reject)$/))) {
      const d = this.decisions[m[1]!]!;
      if (d.status !== "proposed") return json({ error: "This decision is no longer awaiting approval.", code: "conflict" }, 409);
      Object.assign(d, m[2] === "approve" ? { status: "active", approvedAt: NOW } : { status: "rejected", rejectedAt: NOW }, { version: d.version + 1 });
      return json(d);
    }
    if ((m = path.match(/^\/tasks\/([^/]+)\/(approve|reject|sync)$/))) {
      const t = this.tasks[m[1]!]!;
      if (m[2] === "reject") Object.assign(t, { status: "rejected", rejectedAt: NOW });
      else if (m[2] === "approve") Object.assign(t, { status: "approved", approvedAt: NOW });
      else Object.assign(t, { status: "synced", syncStatus: null, syncError: null, externalProvider: "linear", externalId: "ATL-99", externalUrl: "https://linear.app/example/issue/ATL-99" });
      t.version += 1;
      return json(t);
    }
    if ((m = path.match(/^\/conflicts\/([^/]+)\/resolve$/))) {
      const c = this.conflicts.find((x) => x.id === m![1])!;
      if (c.resolution !== "open") return json({ error: "This conflict was already resolved.", code: "conflict" }, 409);
      const next = this.decisions[c.decisionId]!;
      const old = this.decisions[c.conflictingDecisionId]!;
      if (body.action === "accept_new") {
        c.resolution = "kept_new";
        Object.assign(next, { status: "active", approvedAt: NOW });
        Object.assign(old, { status: "superseded", supersededBy: next.id });
      } else if (body.action === "keep_old") {
        c.resolution = "kept_old";
        Object.assign(next, { status: "rejected", rejectedAt: NOW });
      } else c.resolution = "dismissed";
      c.resolvedAt = NOW;
      return json({ id: c.id, resolution: c.resolution });
    }
    if (path === "/reminders") return json({ delivery: DELIVERY, reminders: this.reminders, unread: this.reminders.filter((r) => !r.readAt && r.taskOpen).length } satisfies ReminderInbox);
    if (path === "/reminders/preview") return json(this.reminderPreview());
    if (path === "/reminders/generate") return json({ created: 1, alreadyExisted: 1, windowHours: 24, delivery: DELIVERY });
    if ((m = path.match(/^\/reminders\/([^/]+)\/read$/))) {
      const r = this.reminders.find((x) => x.id === m![1])!;
      r.readAt = NOW;
      return json({ delivery: DELIVERY, reminders: this.reminders, unread: this.reminders.filter((x) => !x.readAt && x.taskOpen).length });
    }
    if (path === "/digests") return json(Array.from({ length: this.digestsStored }, (_, i) => ({ id: id(60 + i), personId: id(7003), ownerName: "Ana", weekStart: "2026-10-26", content: { overdue: [], upcoming: [], completed: [] }, generatedAt: NOW, deliveredAt: null })));
    if (path === "/digests/preview") return json(this.digest());
    if (path === "/digests/generate") {
      this.digestsStored = 2;
      return json({ stored: 2, notStored: 1, weekStart: "2026-10-26", digests: [], delivery: DELIVERY });
    }
    return json({ error: `Unmocked endpoint ${method} ${path}` }, 501);
  }

  /** Replace the response of any request whose "METHOD /path" matches. Return undefined to handle the route yourself. */
  override(match: RegExp, handler: Handler) {
    this.overrides.unshift({ match, handler });
  }
}

/** A Supabase-shaped session that supabase-js accepts from localStorage without any network call. */
function fakeSession() {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${b64({ alg: "none" })}.${b64({ sub: MOCK_USER.id, email: MOCK_USER.email, exp })}.mock`;
  return { access_token: token, refresh_token: "mock-refresh", token_type: "bearer", expires_in: 3600, expires_at: exp, user: { id: MOCK_USER.id, email: MOCK_USER.email, aud: "authenticated", role: "authenticated" } };
}

export async function installMock(page: Page, opts: MockOptions = {}): Promise<MockApi> {
  const api = new MockApi(opts);
  if (opts.signedIn !== false) {
    const session = fakeSession();
    // Seeds the session only when the tab has none, so signing out inside a test is not undone by a reload.
    await page.addInitScript((s) => {
      try {
        if (!sessionStorage.getItem("recall.seeded")) {
          sessionStorage.setItem("recall.seeded", "1");
          localStorage.setItem("recall.auth", JSON.stringify(s));
        }
      } catch { /* storage unavailable */ }
    }, session);
  }
  await page.route("**/api/**", (route) => api.handle(route));
  // Mock Supabase Auth: sign-out succeeds and password sign-in is rejected (signed-in tests seed a session instead).
  await page.route(`${MOCK_SUPABASE}/**`, (route) => {
    const u = route.request().url();
    if (u.includes("/logout")) return route.fulfill({ status: 204, body: "" });
    if (u.includes("/token")) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }) });
    return route.fulfill({ status: 404, body: "{}" });
  });
  return api;
}
