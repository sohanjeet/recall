import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { parseTranscript, UNLABELLED_SPEAKER } from "@recall/shared";
import { createApp } from "../app.js";
import { GroqError } from "../ai/groq.js";
import type { Extraction } from "../ai/schemas.js";
import { pingDatabase, pool } from "../db.js";
import { authHeaders, testAuthDeps } from "../security/testing.js";
import { HttpError } from "./errors.js";
import { analyzeMeeting, createMeeting, getMeeting, persistExtraction } from "./service.js";
import { CreateMeetingBody } from "./validation.js";

const valid = { title: "Sync", occurredAt: "2026-10-30", transcript: "Sam: hi", participants: ["Sam"] };

describe("request validation", () => {
  test("accepts a valid body and applies defaults", () => {
    const r = CreateMeetingBody.parse({ ...valid, participants: ["Sam", "sam", " Ana "] });
    assert.equal(r.source, "paste");
    assert.deepEqual(r.participants, ["Sam", "Ana"]);
    assert.deepEqual(r.speakerMap, {});
  });
  test("rejects empty title, impossible dates and empty/oversized transcripts", () => {
    assert.ok(!CreateMeetingBody.safeParse({ ...valid, title: "  " }).success);
    assert.ok(!CreateMeetingBody.safeParse({ ...valid, occurredAt: "2026-02-30" }).success);
    assert.ok(!CreateMeetingBody.safeParse({ ...valid, occurredAt: "tomorrow" }).success);
    assert.ok(!CreateMeetingBody.safeParse({ ...valid, transcript: " " }).success);
    assert.ok(!CreateMeetingBody.safeParse({ ...valid, transcript: "x".repeat(50_001) }).success);
    assert.ok(!CreateMeetingBody.safeParse({ ...valid, source: "fax" }).success);
  });
});

describe("transcript parsing", () => {
  test("splits speaker-labelled lines, with timestamps and wrapped continuation lines", () => {
    const segs = parseTranscript("Sam: Let's ship Friday.\n[10:32] Ana K.: Agreed,\nI'll do the docs.\n\n(00:01:05) Sam: Great");
    assert.deepEqual(segs, [
      { speakerLabel: "Sam", text: "Let's ship Friday." },
      { speakerLabel: "Ana K.", text: "Agreed, I'll do the docs." },
      { speakerLabel: "Sam", text: "Great" },
    ]);
  });
  test("treats dictation without labels as one unlabelled segment and ignores clock times", () => {
    const segs = parseTranscript("um so we decided at 10:30 to move on\nand uh Sam will send it");
    assert.equal(segs.length, 1);
    assert.equal(segs[0]!.speakerLabel, UNLABELLED_SPEAKER);
  });
});

describe("HTTP API", () => {
  let base = "";
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let headers: Record<string, string> = {};
  before(async () => {
    headers = await authHeaders();
    server = createApp({ extract: async () => assert.fail("extractor must not run"), ...testAuthDeps() }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  test("POST /api/meetings rejects invalid input with 400 before touching the database", async () => {
    const res = await fetch(`${base}/api/meetings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...valid, title: "" }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /Invalid meeting/);
  });
  test("malformed JSON gives 400", async () => {
    const res = await fetch(`${base}/api/meetings`, {
      method: "POST",
      headers,
      body: "{nope",
    });
    assert.equal(res.status, 400);
  });
  test("bad ids give 400", async () => {
    assert.equal((await fetch(`${base}/api/meetings/not-a-uuid`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/meetings/not-a-uuid/analyze`, { method: "POST", headers })).status, 400);
  });
});

const dbUp = await pingDatabase();

describe("persistence (PostgreSQL)", { skip: !dbUp && "database unreachable" }, () => {
  after(() => pool.end());
  const tag = `test-${Date.now()}`;
  const noConflicts = async () => ({ comparisons: [] });

  const extraction = (over: Partial<Extraction> = {}): Extraction => ({
    decisions: [{ summary: "Ship on Monday", rationale: null, evidenceQuotes: ["we ship on monday", "never said this"] }],
    tasks: [
      {
        title: "Send release notes",
        description: null,
        ownerName: "Ana Tester",
        duePhrase: "by end of day",
        dueDate: "2026-10-30",
        evidenceQuotes: ["I will send the release notes"],
      },
      {
        title: "Bad deadline",
        description: null,
        ownerName: null,
        duePhrase: "yesterday",
        dueDate: "2026-10-01",
        evidenceQuotes: [],
      },
    ],
    ambiguities: [{ description: "Unclear who owns QA", quote: "someone check QA" }],
    ...over,
  });

  test("createMeeting stores the raw transcript and corrected speaker segments; extraction is saved as unapproved drafts", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const id = await createMeeting(client, {
        title: tag,
        occurredAt: "2026-10-30",
        participants: [`Ana Tester ${tag}`],
        source: "paste",
        speakerMap: { "Speaker 1": `Ana Tester ${tag}` },
        transcript: `Speaker 1: I will send the release notes.\nSam ${tag}: we ship on Monday\nand someone check QA`,
      });
      const meeting = (await getMeeting(client, id))!;
      assert.equal(meeting.status, "ingested");
      assert.ok(meeting.rawTranscript.startsWith("Speaker 1:"), "original transcript preserved");
      assert.deepEqual(meeting.segments.map((s) => s.speakerLabel), [`Ana Tester ${tag}`, `Sam ${tag}`]);
      assert.ok(meeting.segments[0]!.personId, "corrected speaker linked to a person");
      assert.equal(meeting.segments[1]!.personId, null);

      await persistExtraction(
        client,
        meeting,
        meeting.segments,
        extraction({
          tasks: [{ ...extraction().tasks[0]!, ownerName: `Ana Tester ${tag}` }, extraction().tasks[1]!],
        }),
      );
      const after = (await getMeeting(client, id))!;

      assert.deepEqual(after.decisions.map((d) => d.status), ["proposed"]);
      assert.deepEqual(after.decisions[0]!.evidence.map((e) => e.quote), ["we ship on monday"], "fabricated quote dropped");
      assert.ok(after.decisions[0]!.evidence[0]!.segmentId, "evidence linked to its segment");

      const [t1, t2] = after.tasks;
      assert.equal(t1!.status, "proposed");
      assert.equal(t1!.approvedAt, null);
      assert.equal(t1!.externalId, null);
      assert.equal(t1!.dueDate, "2026-10-30");
      assert.ok(t1!.ownerPersonId, "owner matched to a known person");
      assert.equal(t2!.dueDate, null, "deadline before the meeting date is rejected");
      assert.equal(t2!.duePhrase, "yesterday");

      const descriptions = after.ambiguities.map((a) => a.description);
      assert.ok(descriptions.includes("Unclear who owns QA"));
      assert.ok(descriptions.some((d) => d.includes("Bad deadline")));
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  test("analyze: extractor failure marks the meeting failed, saves no drafts, maps to 502/429", async () => {
    const client = await pool.connect();
    let id: string;
    try {
      id = await createMeeting(client, { ...valid, title: tag, source: "paste", speakerMap: {}, participants: [] });
    } finally {
      client.release();
    }
    try {
      await assert.rejects(
        analyzeMeeting(pool, id, async () => {
          throw new GroqError("api_error", "Groq API 500: boom", 500);
        }, noConflicts),
        (e: HttpError) => e.status === 502 && /AI extraction failed/.test(e.message),
      );
      await assert.rejects(
        analyzeMeeting(pool, id, async () => {
          throw new GroqError("rate_limited", "Groq API 429", 429);
        }, noConflicts),
        (e: HttpError) => e.status === 429,
      );
      const m = (await getMeeting(pool, id))!;
      assert.equal(m.status, "failed");
      assert.match(m.error ?? "", /429/);
      assert.equal(m.decisions.length + m.tasks.length, 0);

      // Retry succeeds, and re-analysis replaces earlier drafts instead of duplicating them.
      const ok = async (): Promise<Extraction> => ({
        decisions: [{ summary: "Say hi", rationale: null, evidenceQuotes: ["hi"] }],
        tasks: [],
        ambiguities: [],
      });
      await analyzeMeeting(pool, id, ok, noConflicts);
      const again = await analyzeMeeting(pool, id, ok, noConflicts);
      assert.equal(again.status, "extracted");
      assert.equal(again.error, null);
      assert.equal(again.decisions.length, 1);

      // Approved work is never overwritten.
      await pool.query(`update decisions set status = 'active', approved_at = now() where meeting_id = $1`, [id]);
      await assert.rejects(analyzeMeeting(pool, id, ok, noConflicts), (e: HttpError) => e.status === 409);
    } finally {
      await pool.query(`delete from meetings where id = $1`, [id]);
      await pool.query(`delete from people where name like $1`, [`%${tag}%`]);
    }
  });

  test("analyze: unknown meeting is 404", async () => {
    await assert.rejects(
      analyzeMeeting(pool, "00000000-0000-4000-8000-000000000000", async () => assert.fail("not called"), noConflicts),
      (e: HttpError) => e.status === 404,
    );
  });
});
