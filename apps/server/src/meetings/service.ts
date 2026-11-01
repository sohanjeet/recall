import type { Pool, PoolClient } from "pg";
import {
  parseTranscript,
  type Ambiguity,
  type Decision,
  type Evidence,
  type MeetingDetail,
  type MeetingSource,
  type MeetingStatus,
  type MeetingSummary,
  type Task,
  type TranscriptSegment,
} from "@recall/shared";
import { GroqError } from "../ai/groq.js";
import type { Extraction } from "../ai/schemas.js";
import { checkConflicts, listMeetingConflicts, toConflictCheck, type ConflictClassifier } from "./conflicts.js";
import { resolveDuePhrase } from "./dates.js";
import { HttpError } from "./errors.js";
import { quoteVerifier } from "./quotes.js";
import { isRealDate, type CreateMeetingInput } from "./validation.js";

export type Queryable = Pick<PoolClient, "query">;

export type Extractor = (input: {
  title: string;
  meetingDate: string;
  participants: string[];
  transcript: string;
}) => Promise<Extraction>;

// ---------- create ----------

/** Stores the original transcript untouched, plus speaker segments with manual speaker corrections applied. */
export async function createMeeting(db: Queryable, input: CreateMeetingInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into meetings (title, occurred_at, source, raw_transcript, participants)
     values ($1, ($2::date + time '12:00') at time zone 'UTC', $3, $4, $5) returning id`,
    [input.title, input.occurredAt, input.source, input.transcript, input.participants],
  );
  const meetingId = rows[0]!.id;

  const corrected = parseTranscript(input.transcript).map((seg) => ({
    speakerLabel: input.speakerMap[seg.speakerLabel] ?? seg.speakerLabel,
    text: seg.text,
  }));

  const names = new Set([...input.participants, ...Object.values(input.speakerMap)]);
  if (names.size > 0) {
    await db.query(
      `insert into people (name) select unnest($1::text[]) on conflict (lower(name)) do nothing`,
      [[...names]],
    );
  }
  const people = await db.query<{ id: string; name: string }>(
    `select id, name from people where lower(name) = any($1::text[])`,
    [corrected.map((s) => s.speakerLabel.toLowerCase())],
  );
  const personByName = new Map(people.rows.map((p) => [p.name.toLowerCase(), p.id]));

  if (corrected.length > 0) {
    await db.query(
      `insert into transcript_segments (meeting_id, seq, speaker_label, person_id, text)
       select $1, t.seq, t.label, t.person_id, t.text
       from unnest($2::int[], $3::text[], $4::uuid[], $5::text[]) as t(seq, label, person_id, text)`,
      [
        meetingId,
        corrected.map((_, i) => i + 1),
        corrected.map((s) => s.speakerLabel),
        corrected.map((s) => personByName.get(s.speakerLabel.toLowerCase()) ?? null),
        corrected.map((s) => s.text),
      ],
    );
  }
  return meetingId;
}

// ---------- read ----------

/** Maps a decisions row (any shape selecting d.*) to the API type. */
export function mapDecision(d: Record<string, any>, evidence: Evidence[]): Decision {
  return {
    id: d.id,
    meetingId: d.meeting_id,
    summary: d.summary,
    rationale: d.rationale,
    status: d.status,
    supersededBy: d.superseded_by,
    approvedAt: d.approved_at?.toISOString() ?? null,
    rejectedAt: d.rejected_at?.toISOString() ?? null,
    version: d.version,
    evidence,
    createdAt: d.created_at.toISOString(),
  };
}

/** Maps a tasks row selected with `due_date_str` (YYYY-MM-DD) and optionally `person_name`. */
export function mapTask(t: Record<string, any>, evidence: Evidence[]): Task {
  return {
    id: t.id,
    meetingId: t.meeting_id,
    title: t.title,
    description: t.description,
    ownerPersonId: t.owner_person_id,
    ownerName: t.person_name ?? t.owner_name,
    dueDate: t.due_date_str,
    duePhrase: t.due_phrase,
    status: t.status,
    approvedAt: t.approved_at?.toISOString() ?? null,
    rejectedAt: t.rejected_at?.toISOString() ?? null,
    version: t.version,
    syncStatus: t.sync_status,
    syncError: t.sync_error,
    syncAttempts: t.sync_attempts,
    externalProvider: t.external_provider,
    externalId: t.external_id,
    externalUrl: t.external_url,
    evidence,
    createdAt: t.created_at.toISOString(),
  };
}

export async function listMeetings(db: Queryable): Promise<MeetingSummary[]> {
  const { rows } = await db.query(
    `select m.id, m.title, m.occurred_at, m.source, m.status, m.participants, m.created_at,
            (select count(*)::int from decisions d where d.meeting_id = m.id) as decision_count,
            (select count(*)::int from tasks t where t.meeting_id = m.id) as task_count
     from meetings m order by m.occurred_at desc, m.created_at desc`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    occurredAt: r.occurred_at.toISOString(),
    source: r.source as MeetingSource,
    status: r.status as MeetingStatus,
    participants: r.participants,
    decisionCount: r.decision_count,
    taskCount: r.task_count,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function getMeeting(db: Queryable, id: string): Promise<MeetingDetail | null> {
  const m = (await db.query(`select * from meetings where id = $1`, [id])).rows[0];
  if (!m) return null;

  const [segs, decs, tsks, ambs, evid] = await Promise.all([
    db.query(`select * from transcript_segments where meeting_id = $1 order by seq`, [id]),
    db.query(`select * from decisions where meeting_id = $1 order by created_at, id`, [id]),
    db.query(
      `select t.*, to_char(t.due_date, 'YYYY-MM-DD') as due_date_str, p.name as person_name
       from tasks t left join people p on p.id = t.owner_person_id
       where t.meeting_id = $1 order by t.created_at, t.id`,
      [id],
    ),
    db.query(`select * from ambiguities where meeting_id = $1 order by created_at, id`, [id]),
    db.query(
      `select e.* from evidence e
       left join decisions d on d.id = e.decision_id
       left join tasks t on t.id = e.task_id
       where d.meeting_id = $1 or t.meeting_id = $1`,
      [id],
    ),
  ]);

  const evidenceFor = (key: "decision_id" | "task_id", ownerId: string): Evidence[] =>
    evid.rows
      .filter((e) => e[key] === ownerId)
      .map((e) => ({ id: e.id, segmentId: e.segment_id, quote: e.quote }));

  const segments: TranscriptSegment[] = segs.rows.map((s) => ({
    id: s.id,
    meetingId: s.meeting_id,
    seq: s.seq,
    speakerLabel: s.speaker_label,
    personId: s.person_id,
    text: s.text,
  }));
  const decisions: Decision[] = decs.rows.map((d) => mapDecision(d, evidenceFor("decision_id", d.id)));
  const tasks: Task[] = tsks.rows.map((t) => mapTask(t, evidenceFor("task_id", t.id)));
  const ambiguities: Ambiguity[] = ambs.rows.map((a) => ({
    id: a.id,
    meetingId: a.meeting_id,
    description: a.description,
    quote: a.quote,
  }));
  const conflicts = await listMeetingConflicts(db, id);

  return {
    id: m.id,
    title: m.title,
    occurredAt: m.occurred_at.toISOString(),
    source: m.source,
    rawTranscript: m.raw_transcript,
    status: m.status,
    participants: m.participants,
    error: m.error,
    createdAt: m.created_at.toISOString(),
    segments,
    decisions,
    tasks,
    ambiguities,
    conflicts,
    conflictCheck: toConflictCheck(m),
  };
}

// ---------- analyze ----------

/**
 * Stores extraction output as drafts: decisions as `proposed`, tasks as `proposed` with no approval.
 * Quotes that cannot be found in the transcript are dropped rather than stored as evidence, and
 * unverifiable deadlines are nulled and surfaced as ambiguities, so nothing unsupported is persisted.
 */
export async function persistExtraction(
  db: Queryable,
  meeting: { id: string; occurredAt: string },
  segments: TranscriptSegment[],
  extraction: Extraction,
): Promise<void> {
  const meetingDate = meeting.occurredAt.slice(0, 10);
  const verified = quoteVerifier(segments);
  const insertEvidence = async (target: "decision_id" | "task_id", ownerId: string, quotes: string[]) => {
    const found = quotes.map(verified).filter((q): q is NonNullable<typeof q> => q !== null);
    for (const q of found) {
      await db.query(`insert into evidence (${target}, segment_id, quote) values ($1, $2, $3)`, [
        ownerId,
        q.segmentId,
        q.quote,
      ]);
    }
  };

  // Re-analysis replaces earlier drafts (evidence cascades) but never touches approved work.
  await db.query(`delete from decisions where meeting_id = $1 and status = 'proposed'`, [meeting.id]);
  await db.query(`delete from tasks where meeting_id = $1 and status = 'proposed'`, [meeting.id]);
  await db.query(`delete from ambiguities where meeting_id = $1`, [meeting.id]);

  for (const d of extraction.decisions) {
    const { rows } = await db.query<{ id: string }>(
      `insert into decisions (meeting_id, summary, rationale, status, created_at) values ($1, $2, $3, 'proposed', clock_timestamp()) returning id`,
      [meeting.id, d.summary.trim(), d.rationale?.trim() || null],
    );
    await insertEvidence("decision_id", rows[0]!.id, d.evidenceQuotes);
  }

  const extraAmbiguities: { description: string; quote: string | null }[] = [];
  for (const t of extraction.tasks) {
    const ownerName = t.ownerName?.trim() || null;
    // A recognised relative phrase is resolved in code; the model's date is only used for phrases we cannot parse.
    let dueDate = resolveDuePhrase(t.duePhrase, meetingDate) ?? (t.dueDate?.trim() || null);
    if (dueDate && (!isRealDate(dueDate) || dueDate < meetingDate)) {
      extraAmbiguities.push({
        description: `Deadline "${t.duePhrase ?? dueDate}" for "${t.title}" could not be resolved to a valid date on or after the meeting date.`,
        quote: null,
      });
      dueDate = null;
    }
    const { rows } = await db.query<{ id: string }>(
      `insert into tasks (meeting_id, title, description, owner_name, owner_person_id, due_date, due_phrase, status, created_at)
       values ($1, $2, $3, $4, (select id from people where lower(name) = lower($4)), $5, $6, 'proposed', clock_timestamp())
       returning id`,
      [meeting.id, t.title.trim(), t.description?.trim() || null, ownerName, dueDate, t.duePhrase?.trim() || null],
    );
    await insertEvidence("task_id", rows[0]!.id, t.evidenceQuotes);
  }

  for (const a of [...extraction.ambiguities, ...extraAmbiguities]) {
    const quote = a.quote ? (verified(a.quote)?.quote ?? null) : null;
    await db.query(`insert into ambiguities (meeting_id, description, quote, created_at) values ($1, $2, $3, clock_timestamp())`, [
      meeting.id,
      a.description.trim(),
      quote,
    ]);
  }
}

/**
 * Extracts and saves drafts, then checks them against earlier approved decisions. A failed conflict check is
 * recorded on the meeting (and can be retried) without discarding the saved extraction.
 */
export async function analyzeMeeting(
  pool: Pool,
  id: string,
  extract: Extractor,
  classifyConflicts: ConflictClassifier,
): Promise<MeetingDetail> {
  const meeting = await getMeeting(pool, id);
  if (!meeting) throw new HttpError(404, "Meeting not found");
  if (meeting.tasks.some((t) => t.status !== "proposed") || meeting.decisions.some((d) => d.status !== "proposed")) {
    throw new HttpError(409, "This meeting has approved items; it can no longer be re-analyzed");
  }

  // Atomic claim so two concurrent requests don't both call the model.
  const claim = await pool.query(
    `update meetings set status = 'extracting', error = null where id = $1 and status <> 'extracting'`,
    [id],
  );
  if (claim.rowCount === 0) throw new HttpError(409, "Analysis is already running for this meeting");

  const fail = async (message: string) => {
    await pool.query(`update meetings set status = 'failed', error = $2 where id = $1`, [id, message]);
  };

  let extraction: Extraction;
  try {
    extraction = await extract({
      title: meeting.title,
      meetingDate: meeting.occurredAt.slice(0, 10),
      participants: meeting.participants,
      transcript: meeting.segments.map((s) => `${s.speakerLabel}: ${s.text}`).join("\n"),
    });
  } catch (err) {
    const message = err instanceof GroqError ? err.message : "Extraction failed unexpectedly";
    await fail(message);
    if (!(err instanceof GroqError)) console.error("Extraction error:", err);
    throw new HttpError(
      err instanceof GroqError && err.code === "rate_limited" ? 429 : 502,
      `AI extraction failed: ${message}`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await persistExtraction(client, meeting, meeting.segments, extraction);
    // Replaced drafts took their conflicts with them (cascade), so the previous check no longer applies.
    await client.query(
      `update meetings set status = 'extracted', error = null,
         conflict_check_status = null, conflict_check_error = null, conflict_checked_at = null
       where id = $1`,
      [id],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    console.error("Persisting extraction failed:", err);
    await fail("Could not save extraction results");
    throw new HttpError(500, "Could not save extraction results");
  } finally {
    client.release();
  }

  try {
    await checkConflicts(pool, id, classifyConflicts);
  } catch {
    // Recorded on the meeting as conflictCheck.status = 'failed'; the extraction stays saved.
  }

  return (await getMeeting(pool, id))!;
}
