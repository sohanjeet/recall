import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type { MeetingConflictsResponse } from "@recall/shared";
import { createApp } from "../app.js";
import { GroqError } from "../ai/groq.js";
import type { ConflictDetection, ConflictDetectionInput, Extraction } from "../ai/schemas.js";
import { pingDatabase, pool } from "../db.js";
import { authHeaders, testAuthDeps } from "../security/testing.js";
import { buildConflictDrafts, checkConflicts, rankCandidates, subjectTerms, type CandidateRow, type ConflictClassifier } from "./conflicts.js";
import { HttpError } from "./errors.js";
import { analyzeMeeting, createMeeting, getMeeting, persistExtraction } from "./service.js";

type Comparison = ConflictDetection["comparisons"][number];

describe("candidate retrieval", () => {
  const row = (id: string, lexemes: string[], titleLexemes: string[] = [], day = 1): CandidateRow => ({
    id,
    summary: id,
    rationale: null,
    meetingId: "m",
    meetingTitle: "t",
    occurredAt: new Date(Date.UTC(2026, 9, day)),
    lexemes,
    titleLexemes,
  });

  test("keeps related decisions, drops unrelated ones and generic-word overlaps", () => {
    const terms = subjectTerms(["move", "mobil", "app", "launch", "nov", "22"]);
    const ranked = rankCandidates(terms, new Set(), [
      row("billing", ["use", "stripe", "bill"]),
      row("generic", ["team", "agre", "decid", "launch"]),
      row("launch", ["launch", "mobil", "app", "novemb", "15"]),
    ]);
    assert.deepEqual(ranked.map((r) => r.id), ["launch"]);
  });

  test("abbreviated and full month names match", () => {
    assert.ok(subjectTerms(["nov"]).has("novemb"));
  });

  test("a shared meeting-title term (same project) lowers the bar to one shared term", () => {
    const terms = subjectTerms(["push", "launch", "22nd"]);
    const rows = [row("same-project", ["launch", "mobil"], ["orbit"]), row("other-project", ["launch", "site"], ["market"])];
    assert.deepEqual(rankCandidates(terms, subjectTerms(["orbit", "sync"]), rows).map((r) => r.id), ["same-project"]);
  });

  test("is bounded per decision, most overlap first", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`d${i}`, i % 2 ? ["launch", "app"] : ["launch", "app", "mobil"], [], i + 1));
    const ranked = rankCandidates(subjectTerms(["launch", "app", "mobil"]), new Set(), rows);
    assert.equal(ranked.length, 5);
    assert.ok(ranked.every((r) => r.lexemes.includes("mobil")));
  });
});

describe("conflict drafts from model output", () => {
  const labels = {
    newDecisions: new Map([
      ["N1", { id: "new-1", summary: "Move the launch to Nov 22", quotes: ["move the launch to Nov 22"], compareWith: new Set(["E1"]) }],
    ]),
    earlierDecisions: new Map([
      ["E1", { id: "old-1" }],
      ["E2", { id: "old-2" }],
    ]),
  };
  const verify = (q: string) => (q.includes("Nov 22") ? { segmentId: "seg-1", quote: q } : null);
  const cmp = (over: Partial<Comparison> = {}): Comparison => ({
    newId: "N1",
    earlierId: "E1",
    relation: "changes",
    kind: "deadline",
    certain: true,
    previousValue: "November 15",
    newValue: "November 22",
    evidenceQuote: "move the launch to Nov 22",
    explanation: "The launch date moved.",
    ...over,
  });

  test("model-flagged uncertainty requires review", () => {
    const [d] = buildConflictDrafts({ comparisons: [cmp({ certain: false })] }, labels, verify);
    assert.equal(d!.certainty, "uncertain");
  });

  test("confirmations, unrelated, unlisted and invented pairs are dropped; duplicates collapse", () => {
    const drafts = buildConflictDrafts(
      {
        comparisons: [
          cmp(),
          cmp({ certain: false }),
          cmp({ relation: "confirms" }),
          cmp({ relation: "unrelated" }),
          cmp({ earlierId: "E2" }),
          cmp({ earlierId: "E9" }),
          cmp({ newId: "N7" }),
        ],
      },
      labels,
      verify,
    );
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.certainty, "uncertain", "the more cautious judgement wins");
    assert.deepEqual(drafts[0]!.evidence, { segmentId: "seg-1", quote: "move the launch to Nov 22" });
  });

  test("evidence that is not in the transcript is replaced by the decision's own verified quote", () => {
    const [d] = buildConflictDrafts({ comparisons: [cmp({ evidenceQuote: "invented words" })] }, labels, verify);
    assert.equal(d!.evidence?.quote, "move the launch to Nov 22");
  });
});

const dbUp = await pingDatabase();

describe("cross-meeting conflicts (PostgreSQL)", { skip: !dbUp && "database unreachable" }, () => {
  const tag = `conflict-test-${Date.now()}`;
  const meetingIds: string[] = [];
  let earlierId = "";

  after(async () => {
    await pool.query(`delete from meetings where id = any($1::uuid[])`, [meetingIds]);
    await pool.query(`delete from people where name like $1`, [`%${tag}%`]);
    await pool.end();
  });

  const newMeeting = async (transcript: string) => {
    const client = await pool.connect();
    try {
      const id = await createMeeting(client, {
        title: `Orbit mobile app sync ${tag}`,
        occurredAt: "2026-10-30",
        participants: [],
        source: "paste",
        speakerMap: {},
        transcript,
      });
      meetingIds.push(id);
      return id;
    } finally {
      client.release();
    }
  };

  // An earlier meeting whose decisions a person has approved (status 'active').
  before(async () => {
    const client = await pool.connect();
    try {
      earlierId = await createMeeting(client, {
        title: `Orbit mobile app planning ${tag}`,
        occurredAt: "2026-10-01",
        participants: [],
        source: "paste",
        speakerMap: {},
        transcript: [
          "Sam: We launch the Orbit mobile app on November 15.",
          "Ana: I own the onboarding redesign.",
          "Sam: We use Stripe for billing.",
        ].join("\n"),
      });
      meetingIds.push(earlierId);
      const m = (await getMeeting(client, earlierId))!;
      await persistExtraction(client, m, m.segments, {
        decisions: [
          { summary: "Launch the Orbit mobile app on November 15", rationale: null, evidenceQuotes: ["We launch the Orbit mobile app on November 15"] },
          { summary: "Ana owns the onboarding redesign", rationale: null, evidenceQuotes: ["I own the onboarding redesign"] },
          { summary: "Use Stripe for billing", rationale: null, evidenceQuotes: ["We use Stripe for billing"] },
        ],
        tasks: [],
        ambiguities: [],
      });
      await client.query(`update decisions set status = 'active', approved_at = now() where meeting_id = $1`, [earlierId]);
      await client.query(`update meetings set status = 'extracted' where id = $1`, [earlierId]);
    } finally {
      client.release();
    }
  });

  const transcript = [
    "Sam: We are moving the Orbit mobile app launch to Nov 22.",
    "Ana: Raj will own the onboarding redesign from now on.",
    "Sam: Maybe we drop Android from the Orbit mobile app launch.",
    "Ana: To confirm, we keep using Stripe for billing.",
    "Sam: The offsite will be in Lisbon.",
  ].join("\n");
  const extraction = async (): Promise<Extraction> => ({
    decisions: [
      { summary: "Move the Orbit mobile app launch to Nov 22", rationale: null, evidenceQuotes: ["moving the Orbit mobile app launch to Nov 22"] },
      { summary: "Raj owns the onboarding redesign", rationale: null, evidenceQuotes: ["Raj will own the onboarding redesign from now on"] },
      { summary: "Drop Android from the Orbit mobile app launch", rationale: null, evidenceQuotes: ["Maybe we drop Android from the Orbit mobile app launch"] },
      { summary: "Keep using Stripe for billing", rationale: null, evidenceQuotes: ["we keep using Stripe for billing"] },
      { summary: "Hold the offsite in Lisbon", rationale: null, evidenceQuotes: ["The offsite will be in Lisbon"] },
    ],
    tasks: [],
    ambiguities: [],
  });

  // Stands in for the model with fixed judgements, recording exactly what it was asked to compare.
  const judge = (n: ConflictDetectionInput["newDecisions"][number], e: ConflictDetectionInput["earlierDecisions"][number]): Comparison => {
    const base = { newId: n.id, earlierId: e.id, certain: true, previousValue: null, newValue: null, evidenceQuote: n.quotes[0] ?? null };
    if (/Nov 22/.test(n.summary) && /November 15/.test(e.summary)) {
      return { ...base, relation: "changes", kind: "deadline", previousValue: "November 15", newValue: "November 22", explanation: "The launch moved a week later." };
    }
    if (/^Raj/.test(n.summary) && /^Ana owns/.test(e.summary)) {
      return { ...base, relation: "changes", kind: "ownership", previousValue: "Ana", newValue: "Raj", explanation: "The redesign changed owner." };
    }
    if (/Android/.test(n.summary) && /November 15/.test(e.summary)) {
      // Overconfident: the statement is hedged ("Maybe"), so it must still be marked for review.
      return { ...base, relation: "contradicts", kind: "scope", explanation: "Android may be cut from the launch." };
    }
    if (/Stripe/.test(n.summary) && /Stripe/.test(e.summary)) {
      return { ...base, relation: "confirms", kind: "other", explanation: "Same decision repeated." };
    }
    return { ...base, relation: "unrelated", kind: "other", explanation: "Different subjects." };
  };
  const scripted = (calls: ConflictDetectionInput[]): ConflictClassifier => async (input) => {
    calls.push(input);
    return {
      comparisons: input.newDecisions.flatMap((n) => n.compareWith.map((id) => judge(n, input.earlierDecisions.find((e) => e.id === id)!))),
    };
  };
  const failing: ConflictClassifier = async () => {
    throw new GroqError("api_error", "Groq API 503: unavailable", 503);
  };

  const earlierSnapshot = async () =>
    (await pool.query(`select id, summary, rationale, status, superseded_by from decisions where meeting_id = $1 order by id`, [earlierId])).rows;
  const ours = <T extends { previousDecision: { meetingId: string } }>(list: T[]) => list.filter((c) => c.previousDecision.meetingId === earlierId);
  const conflictRows = async (meetingId: string) =>
    (await pool.query(`select count(*)::int as n from decision_conflicts where meeting_id = $1`, [meetingId])).rows[0].n as number;

  test("detects deadline and ownership changes, flags hedged statements, ignores repeats and unrelated decisions", async () => {
    const snapshot = await earlierSnapshot();
    const id = await newMeeting(transcript);
    const calls: ConflictDetectionInput[] = [];
    const m = await analyzeMeeting(pool, id, extraction, scripted(calls));

    assert.equal(m.conflictCheck.status, "done");
    const conflicts = ours(m.conflicts);
    const by = (summary: RegExp) => conflicts.filter((c) => summary.test(c.decision.summary));

    // Nov 15 launch moved to Nov 22: conflict, with both decisions, evidence and explanation.
    const [deadline] = by(/Nov 22/);
    assert.ok(deadline);
    assert.equal(deadline.kind, "deadline");
    assert.equal(deadline.relation, "changes");
    assert.equal(deadline.certainty, "clear");
    assert.equal(deadline.previousValue, "November 15");
    assert.equal(deadline.newValue, "November 22");
    assert.equal(deadline.previousDecision.summary, "Launch the Orbit mobile app on November 15");
    assert.equal(deadline.previousDecision.status, "active");
    assert.ok(deadline.previousDecision.evidence.length > 0);
    assert.equal(deadline.evidenceQuote, "moving the Orbit mobile app launch to Nov 22");
    assert.match(deadline.explanation, /week later/);
    assert.equal(deadline.resolution, "open");

    // Ownership change: conflict.
    const [owner] = by(/^Raj/);
    assert.equal(owner?.kind, "ownership");
    assert.equal(owner?.previousDecision.summary, "Ana owns the onboarding redesign");

    // Uncertain statement: requires review, even though the model called it certain.
    const [hedged] = by(/Android/);
    assert.equal(hedged?.certainty, "uncertain");

    // Repeated decision: compared, but no conflict.
    assert.equal(by(/Stripe/).length, 0);
    assert.equal(conflicts.length, 3);

    // Retrieval is bounded: unrelated decisions are never sent to the model, related ones only against their own subject.
    const asked = calls[0]!;
    const sent = (re: RegExp) => asked.newDecisions.find((n) => re.test(n.summary));
    const comparedWith = (re: RegExp) => sent(re)!.compareWith.map((label) => asked.earlierDecisions.find((e) => e.id === label)!.summary);
    assert.equal(sent(/offsite/), undefined, "unrelated decision has no candidates");
    assert.ok(comparedWith(/Stripe/).includes("Use Stripe for billing"));
    assert.ok(!comparedWith(/Stripe/).some((s) => /launch|onboarding/i.test(s)));
    assert.ok(!comparedWith(/^Raj/).some((s) => /launch|Stripe/i.test(s)));

    // Historical decisions are never modified.
    assert.deepEqual(await earlierSnapshot(), snapshot);

    // Exposed through the meeting API.
    const server = createApp({ extract: async () => assert.fail("not called"), classifyConflicts: failing, ...testAuthDeps() }).listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/meetings/${id}/conflicts`, { headers: await authHeaders() });
      assert.equal(res.status, 200);
      const body = (await res.json()) as MeetingConflictsResponse;
      assert.equal(body.conflictCheck.status, "done");
      assert.equal(ours(body.conflicts).length, 3);
    } finally {
      server.close();
    }
  });

  test("re-analysis and re-checking do not duplicate conflicts", async () => {
    const id = await newMeeting(transcript);
    await analyzeMeeting(pool, id, extraction, scripted([]));
    const first = await conflictRows(id);
    assert.ok(first >= 3);

    const again = await analyzeMeeting(pool, id, extraction, scripted([]));
    assert.equal(again.decisions.length, 5, "drafts replaced, not duplicated");
    assert.equal(await conflictRows(id), first);
    assert.equal(ours(again.conflicts).length, 3);

    await checkConflicts(pool, id, scripted([]));
    await checkConflicts(pool, id, scripted([]));
    assert.equal(await conflictRows(id), first);
  });

  test("a failed AI check keeps the extraction and earlier conflicts, and is recorded for retry", async () => {
    const snapshot = await earlierSnapshot();
    const id = await newMeeting(transcript);
    await analyzeMeeting(pool, id, extraction, scripted([]));
    const stored = await conflictRows(id);

    await assert.rejects(checkConflicts(pool, id, failing), (e: HttpError) => e.status === 502 && /conflict check failed/i.test(e.message));
    let m = (await getMeeting(pool, id))!;
    assert.equal(m.conflictCheck.status, "failed");
    assert.match(m.conflictCheck.error ?? "", /503/);
    assert.equal(await conflictRows(id), stored, "existing conflicts untouched");
    assert.equal(m.decisions.length, 5);

    // A failure during analysis still saves the extraction; the meeting is not marked failed.
    m = await analyzeMeeting(pool, id, extraction, failing);
    assert.equal(m.status, "extracted");
    assert.equal(m.decisions.length, 5);
    assert.equal(m.conflictCheck.status, "failed");

    // Retrying succeeds.
    await checkConflicts(pool, id, scripted([]));
    m = (await getMeeting(pool, id))!;
    assert.equal(m.conflictCheck.status, "done");
    assert.equal(ours(m.conflicts).length, 3);
    assert.deepEqual(await earlierSnapshot(), snapshot);
  });

  test("checking requires an analyzed meeting", async () => {
    const id = await newMeeting("Sam: hello");
    await assert.rejects(checkConflicts(pool, id, failing), (e: HttpError) => e.status === 409);
    await assert.rejects(checkConflicts(pool, "00000000-0000-4000-8000-000000000000", failing), (e: HttpError) => e.status === 404);
  });
});
