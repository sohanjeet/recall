import type { Pool } from "pg";
import type {
  ConflictCheck,
  ConflictCertainty,
  ConflictKind,
  ConflictRelation,
  Evidence,
  MeetingConflict,
  MeetingConflictsResponse,
} from "@recall/shared";
import { GroqError } from "../ai/groq.js";
import type { ConflictDetection, ConflictDetectionInput } from "../ai/schemas.js";
import { HttpError } from "./errors.js";
import { quoteVerifier, type QuoteMatch } from "./quotes.js";
import type { Queryable } from "./service.js";

export type ConflictClassifier = (input: ConflictDetectionInput) => Promise<ConflictDetection>;

// Bounds on how much history one check looks at, so cost does not grow with the number of past meetings.
export const MAX_COMPARED_DECISIONS = 20;
export const MAX_CANDIDATES_PER_DECISION = 5;
const PREFILTER_LIMIT = 50;
const MAX_QUOTES = 3;

// English-stemmed terms that appear in most decisions or meeting titles and say nothing about the subject.
const GENERIC_TERMS = new Set([
  "decid", "decis", "agre", "will", "team", "go", "need", "make", "get", "also", "let", "discuss", "everyon",
  "now", "ok", "okay", "yes", "plan", "thing", "meet", "sync", "week", "daili", "standup", "call", "review",
  "updat", "check", "kickoff",
]);
// Abbreviated month → the stem of the full name, so "Nov 22" and "November 15" share a term.
const MONTH_ALIASES: Record<string, string> = {
  jan: "januari", feb: "februari", mar: "march", apr: "april", jun: "june", jul: "juli",
  aug: "august", sep: "septemb", sept: "septemb", oct: "octob", nov: "novemb", dec: "decemb",
};
const MONTH_ABBREVIATIONS = Object.entries(MONTH_ALIASES);

const canonical = (lexeme: string) => MONTH_ALIASES[lexeme] ?? lexeme;

/** Subject terms of a text, from its Postgres english lexemes. */
export function subjectTerms(lexemes: string[]): Set<string> {
  return new Set(lexemes.map(canonical).filter((l) => !GENERIC_TERMS.has(l)));
}

/** OR-query over the terms (plus month abbreviations) for the GIN-indexed prefilter. */
function toTsquery(terms: Set<string>): string {
  const lexemes = [...terms].flatMap((t) => [t, ...MONTH_ABBREVIATIONS.filter(([, full]) => full === t).map(([abbr]) => abbr)]);
  return lexemes.map((l) => `'${l.replace(/['\\]/g, "$&$&")}'`).join(" | ");
}

export interface CandidateRow {
  id: string;
  summary: string;
  rationale: string | null;
  meetingId: string;
  meetingTitle: string;
  occurredAt: Date;
  lexemes: string[];
  titleLexemes: string[];
}

/**
 * Keeps earlier decisions that share at least two subject terms with the new decision, or one when their
 * meetings share a title term (same project). Most-overlapping, same-project, most-recent first.
 */
export function rankCandidates(
  terms: Set<string>,
  titleTerms: Set<string>,
  rows: CandidateRow[],
  limit = MAX_CANDIDATES_PER_DECISION,
): CandidateRow[] {
  const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((t) => b.has(t)).length;
  const minShared = Math.min(2, terms.size);
  return rows
    .map((row) => ({
      row,
      shared: overlap(subjectTerms(row.lexemes), terms),
      sameProject: overlap(subjectTerms(row.titleLexemes), titleTerms) > 0,
    }))
    .filter((c) => c.shared > 0 && c.shared >= (c.sameProject ? 1 : minShared))
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        Number(b.sameProject) - Number(a.sameProject) ||
        b.row.occurredAt.getTime() - a.row.occurredAt.getTime(),
    )
    .slice(0, limit)
    .map((c) => c.row);
}

/** Bounded retrieval of related approved decisions from meetings on or before this one. */
async function findCandidates(
  db: Queryable,
  meeting: { id: string; title: string; occurredAt: Date },
  decisions: { id: string; summary: string }[],
): Promise<Map<string, CandidateRow[]>> {
  const { rows } = await db.query<{ lexemes: string[] }>(
    `select tsvector_to_array(to_tsvector('english', t.text)) as lexemes
     from unnest($1::text[]) with ordinality as t(text, ord) order by t.ord`,
    [[meeting.title, ...decisions.map((d) => d.summary)]],
  );
  const titleTerms = subjectTerms(rows[0]!.lexemes);

  const result = new Map<string, CandidateRow[]>();
  for (const [i, d] of decisions.entries()) {
    const terms = subjectTerms(rows[i + 1]!.lexemes);
    if (terms.size === 0) continue;
    const found = await db.query(
      `select d.id, d.summary, d.rationale, d.meeting_id, m.title as meeting_title, m.occurred_at,
              tsvector_to_array(d.search) as lexemes,
              tsvector_to_array(to_tsvector('english', m.title)) as title_lexemes
       from decisions d join meetings m on m.id = d.meeting_id
       where d.status = 'active' and d.search @@ $1::tsquery
         and d.meeting_id <> $2 and m.occurred_at <= $3
       order by ts_rank(d.search, $1::tsquery) desc, m.occurred_at desc
       limit ${PREFILTER_LIMIT}`,
      [toTsquery(terms), meeting.id, meeting.occurredAt],
    );
    const ranked = rankCandidates(
      terms,
      titleTerms,
      found.rows.map((r) => ({
        id: r.id,
        summary: r.summary,
        rationale: r.rationale,
        meetingId: r.meeting_id,
        meetingTitle: r.meeting_title,
        occurredAt: r.occurred_at,
        lexemes: r.lexemes,
        titleLexemes: r.title_lexemes,
      })),
    );
    if (ranked.length > 0) result.set(d.id, ranked);
  }
  return result;
}

// Tentative or conditional wording: such a statement cannot be treated as a settled change.
const HEDGE =
  /\b(maybe|might|perhaps|possibly|probably|tentative(ly)?|not sure|unsure|undecided|leaning|tbd|to be confirmed|not confirmed|pending|if we|unless|considering|thinking about)\b/i;

export interface ConflictDraft {
  decisionId: string;
  conflictingDecisionId: string;
  kind: ConflictKind;
  relation: ConflictRelation;
  certainty: ConflictCertainty;
  explanation: string;
  previousValue: string | null;
  newValue: string | null;
  evidence: QuoteMatch | null;
}

/**
 * Turns model output into conflicts: only listed pairs are accepted, confirmations and unrelated pairs are dropped,
 * hedged statements are always marked uncertain, and evidence must be quoted from this meeting's transcript.
 */
export function buildConflictDrafts(
  result: ConflictDetection,
  labels: {
    newDecisions: Map<string, { id: string; summary: string; quotes: string[]; compareWith: Set<string> }>;
    earlierDecisions: Map<string, { id: string }>;
  },
  verify: (quote: string) => QuoteMatch | null,
): ConflictDraft[] {
  const drafts = new Map<string, ConflictDraft>();
  for (const c of result.comparisons) {
    const fresh = labels.newDecisions.get(c.newId.trim());
    const earlier = labels.earlierDecisions.get(c.earlierId.trim());
    if (!fresh || !earlier || !fresh.compareWith.has(c.earlierId.trim())) continue;
    if (c.relation !== "changes" && c.relation !== "contradicts") continue;

    const hedged = [fresh.summary, ...fresh.quotes].some((t) => HEDGE.test(t));
    const certainty: ConflictCertainty = c.certain && !hedged ? "clear" : "uncertain";
    const key = `${fresh.id}|${earlier.id}`;
    const existing = drafts.get(key);
    if (existing) {
      if (certainty === "uncertain") existing.certainty = "uncertain";
      continue;
    }
    drafts.set(key, {
      decisionId: fresh.id,
      conflictingDecisionId: earlier.id,
      kind: c.kind,
      relation: c.relation,
      certainty,
      explanation: c.explanation.trim(),
      previousValue: c.previousValue?.trim() || null,
      newValue: c.newValue?.trim() || null,
      evidence: (c.evidenceQuote && verify(c.evidenceQuote)) || fresh.quotes.map(verify).find(Boolean) || null,
    });
  }
  return [...drafts.values()];
}

/**
 * Compares this meeting's proposed decisions with related approved decisions from earlier meetings and stores
 * the conflicts found. Approved decisions are never modified. Re-running replaces open conflicts instead of
 * duplicating them; a failed AI call leaves previously stored conflicts untouched and marks the check failed.
 */
export async function checkConflicts(pool: Pool, meetingId: string, classify: ConflictClassifier): Promise<void> {
  const meeting = (await pool.query(`select id, title, occurred_at, status from meetings where id = $1`, [meetingId])).rows[0];
  if (!meeting) throw new HttpError(404, "Meeting not found");
  if (meeting.status !== "extracted") throw new HttpError(409, "Analyze the meeting before checking for conflicts");

  try {
    const drafts = await detect(pool, { id: meeting.id, title: meeting.title, occurredAt: meeting.occurred_at }, classify);
    await saveConflicts(pool, meetingId, drafts);
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) throw err;
    const message = err instanceof GroqError ? `AI conflict check failed: ${err.message}` : "Conflict check failed unexpectedly";
    if (!(err instanceof GroqError)) console.error("Conflict check error:", err);
    await pool.query(
      `update meetings set conflict_check_status = 'failed', conflict_check_error = $2, conflict_checked_at = now() where id = $1`,
      [meetingId, message],
    );
    throw new HttpError(err instanceof GroqError ? (err.code === "rate_limited" ? 429 : 502) : 500, message);
  }
}

async function detect(
  db: Queryable,
  meeting: { id: string; title: string; occurredAt: Date },
  classify: ConflictClassifier,
): Promise<ConflictDraft[]> {
  const proposed = (
    await db.query<{ id: string; summary: string; rationale: string | null }>(
      `select id, summary, rationale from decisions where meeting_id = $1 and status = 'proposed'
       order by created_at, id limit ${MAX_COMPARED_DECISIONS}`,
      [meeting.id],
    )
  ).rows;
  if (proposed.length === 0) return [];

  const candidates = await findCandidates(db, meeting, proposed);
  if (candidates.size === 0) return [];

  const earlierRows = new Map([...candidates.values()].flat().map((c) => [c.id, c]));
  const quotes = await quotesFor(db, [...proposed.map((d) => d.id), ...earlierRows.keys()]);

  const earlierLabel = new Map([...earlierRows.keys()].map((id, i) => [id, `E${i + 1}`]));
  const newDecisions = proposed
    .filter((d) => candidates.has(d.id))
    .map((d, i) => ({
      label: `N${i + 1}`,
      id: d.id,
      summary: d.summary,
      rationale: d.rationale,
      quotes: quotes.get(d.id) ?? [],
      compareWith: candidates.get(d.id)!.map((c) => earlierLabel.get(c.id)!),
    }));

  const result = await classify({
    meeting: { title: meeting.title, date: meeting.occurredAt.toISOString().slice(0, 10) },
    newDecisions: newDecisions.map((d) => ({
      id: d.label,
      summary: d.summary,
      rationale: d.rationale,
      quotes: d.quotes,
      compareWith: d.compareWith,
    })),
    earlierDecisions: [...earlierRows.values()].map((e) => ({
      id: earlierLabel.get(e.id)!,
      summary: e.summary,
      rationale: e.rationale,
      meetingTitle: e.meetingTitle,
      meetingDate: e.occurredAt.toISOString().slice(0, 10),
      quotes: quotes.get(e.id) ?? [],
    })),
  });

  const segments = (await db.query(`select id, text, speaker_label from transcript_segments where meeting_id = $1`, [meeting.id])).rows.map((r) => ({
    id: r.id as string,
    text: r.text as string,
    speakerLabel: r.speaker_label as string,
  }));
  return buildConflictDrafts(
    result,
    {
      newDecisions: new Map(newDecisions.map((d) => [d.label, { ...d, compareWith: new Set(d.compareWith) }])),
      earlierDecisions: new Map([...earlierLabel].map(([id, label]) => [label, { id }])),
    },
    quoteVerifier(segments),
  );
}

async function quotesFor(db: Queryable, decisionIds: string[]): Promise<Map<string, string[]>> {
  const { rows } = await db.query<{ decision_id: string; quote: string }>(
    `select decision_id, quote from evidence where decision_id = any($1::uuid[]) order by id`,
    [decisionIds],
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.decision_id) ?? [];
    if (list.length < MAX_QUOTES) map.set(r.decision_id, [...list, r.quote]);
  }
  return map;
}

async function saveConflicts(pool: Pool, meetingId: string, drafts: ConflictDraft[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Serialises with re-analysis: if the drafts were replaced meanwhile, these results are stale.
    const locked = await client.query(`select status from meetings where id = $1 for update`, [meetingId]);
    if (locked.rows[0]?.status !== "extracted") {
      throw new HttpError(409, "The meeting was re-analyzed while conflicts were being checked; try again");
    }
    // Open conflicts are replaced; ones a person has already resolved are kept (and not re-inserted).
    await client.query(`delete from decision_conflicts where meeting_id = $1 and resolution = 'open'`, [meetingId]);
    if (drafts.length > 0) {
      // Only links a still-proposed decision of this meeting to a still-active earlier decision.
      await client.query(
        `insert into decision_conflicts (meeting_id, decision_id, conflicting_decision_id, kind, relation, certainty,
                                         explanation, previous_value, new_value, evidence_quote, evidence_segment_id)
         select $1, c.decision_id, c.conflicting_id, c.kind, c.relation, c.certainty,
                c.explanation, c.previous_value, c.new_value, c.quote, c.segment_id
         from unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::uuid[])
           as c(decision_id, conflicting_id, kind, relation, certainty, explanation, previous_value, new_value, quote, segment_id)
         join decisions nd on nd.id = c.decision_id and nd.meeting_id = $1 and nd.status = 'proposed'
         join decisions od on od.id = c.conflicting_id and od.status = 'active'
         on conflict (decision_id, conflicting_decision_id) do nothing`,
        [
          meetingId,
          drafts.map((d) => d.decisionId),
          drafts.map((d) => d.conflictingDecisionId),
          drafts.map((d) => d.kind),
          drafts.map((d) => d.relation),
          drafts.map((d) => d.certainty),
          drafts.map((d) => d.explanation),
          drafts.map((d) => d.previousValue),
          drafts.map((d) => d.newValue),
          drafts.map((d) => d.evidence?.quote ?? null),
          drafts.map((d) => d.evidence?.segmentId ?? null),
        ],
      );
    }
    await client.query(
      `update meetings set conflict_check_status = 'done', conflict_check_error = null, conflict_checked_at = now() where id = $1`,
      [meetingId],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------- read ----------

export function toConflictCheck(m: {
  conflict_check_status: ConflictCheck["status"];
  conflict_check_error: string | null;
  conflict_checked_at: Date | null;
}): ConflictCheck {
  return {
    status: m.conflict_check_status,
    error: m.conflict_check_error,
    checkedAt: m.conflict_checked_at?.toISOString() ?? null,
  };
}

/** Conflicts raised by this meeting's decisions, with both sides and their evidence. */
export function listMeetingConflicts(db: Queryable, meetingId: string): Promise<MeetingConflict[]> {
  return queryConflicts(db, "c.meeting_id = $1", [meetingId]);
}

/** Unresolved conflicts across all meetings whose new decision is still a draft. */
export function listOpenConflicts(db: Queryable): Promise<MeetingConflict[]> {
  return queryConflicts(db, "c.resolution = 'open' and nd.status = 'proposed'", []);
}

async function queryConflicts(db: Queryable, where: string, params: unknown[]): Promise<MeetingConflict[]> {
  const { rows } = await db.query(
    `select c.*, nd.summary as new_summary,
            od.summary as old_summary, od.rationale as old_rationale, od.status as old_status,
            od.meeting_id as old_meeting_id, om.title as old_meeting_title, om.occurred_at as old_meeting_occurred_at
     from decision_conflicts c
     join decisions nd on nd.id = c.decision_id
     join decisions od on od.id = c.conflicting_decision_id
     join meetings om on om.id = od.meeting_id
     where ${where}
     order by nd.created_at, nd.id, om.occurred_at desc, c.id`,
    params,
  );
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.flatMap((r) => [r.decision_id, r.conflicting_decision_id]))];
  const evid = await db.query(`select * from evidence where decision_id = any($1::uuid[]) order by id`, [ids]);
  const evidenceFor = (decisionId: string): Evidence[] =>
    evid.rows
      .filter((e) => e.decision_id === decisionId)
      .map((e) => ({ id: e.id, segmentId: e.segment_id, quote: e.quote }));

  return rows.map((r) => ({
    id: r.id,
    decisionId: r.decision_id,
    conflictingDecisionId: r.conflicting_decision_id,
    meetingId: r.meeting_id,
    kind: r.kind,
    relation: r.relation,
    certainty: r.certainty,
    explanation: r.explanation,
    previousValue: r.previous_value,
    newValue: r.new_value,
    evidenceQuote: r.evidence_quote,
    resolution: r.resolution,
    resolvedAt: r.resolved_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    decision: { id: r.decision_id, summary: r.new_summary, evidence: evidenceFor(r.decision_id) },
    previousDecision: {
      id: r.conflicting_decision_id,
      summary: r.old_summary,
      rationale: r.old_rationale,
      status: r.old_status,
      meetingId: r.old_meeting_id,
      meetingTitle: r.old_meeting_title,
      meetingOccurredAt: r.old_meeting_occurred_at.toISOString(),
      evidence: evidenceFor(r.conflicting_decision_id),
    },
  }));
}

export async function getMeetingConflicts(db: Queryable, meetingId: string): Promise<MeetingConflictsResponse | null> {
  const m = (
    await db.query(
      `select conflict_check_status, conflict_check_error, conflict_checked_at from meetings where id = $1`,
      [meetingId],
    )
  ).rows[0];
  if (!m) return null;
  return { conflictCheck: toConflictCheck(m), conflicts: await listMeetingConflicts(db, meetingId) };
}
