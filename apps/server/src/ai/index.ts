import { env } from "../env.js";
import { GroqClient } from "./groq.js";
import {
  ConflictDetectionSchema,
  ExtractionSchema,
  type ConflictDetection,
  type ConflictDetectionInput,
  type Extraction,
} from "./schemas.js";

export { GroqError } from "./groq.js";
export type { Extraction, ConflictDetection, ConflictDetectionInput } from "./schemas.js";

/** Server-side only: the API key never leaves this process. */
export const groq = new GroqClient({
  apiKey: env.GROQ_API_KEY,
  model: env.GROQ_MODEL,
  baseUrl: env.GROQ_BASE_URL,
});

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function extractMeeting(input: {
  title: string;
  /** YYYY-MM-DD; relative dates resolve against this. */
  meetingDate: string;
  participants: string[];
  transcript: string;
}): Promise<Extraction> {
  const weekday = WEEKDAYS[new Date(`${input.meetingDate}T12:00:00Z`).getUTCDay()];
  return groq.completeJson({
    name: "meeting_extraction",
    schema: ExtractionSchema,
    system: [
      "You extract decisions and action items from a meeting transcript (possibly speech-to-text dictation).",
      "Rules:",
      "- Only include what is explicitly stated. Never invent owners, deadlines, rationale or decisions. Use null when unknown.",
      "- Ignore filler words (um, uh, like, you know) and false starts.",
      "- Self-corrections: when a speaker corrects themselves ('Friday, no, Monday'), use the final corrected version only.",
      "- A decision is something agreed or settled; a task is an action someone must do. Do not list discussion or ideas that were not agreed.",
      `- The meeting took place on ${input.meetingDate} (${weekday}). Resolve relative dates ('tomorrow', 'next Friday', 'end of the week') to YYYY-MM-DD against that date. 'Next <weekday>' means the first such weekday after the meeting date's week; if you cannot resolve a date confidently, set dueDate to null and add an ambiguity.`,
      "- duePhrase is the deadline wording as spoken. ownerName is a name as spoken in the transcript; resolve 'I' to the current speaker's name.",
      "- evidenceQuotes must be exact, contiguous substrings of the transcript text (not including the 'Speaker:' prefix).",
      "- Report unclear owners, vague deadlines, or contradictory statements under ambiguities rather than guessing.",
      "- Return empty arrays when there is nothing to extract.",
    ].join("\n"),
    user: [
      `Meeting: ${input.title}`,
      `Date: ${input.meetingDate} (${weekday})`,
      `Participants: ${input.participants.length ? input.participants.join(", ") : "unknown"}`,
      "",
      "Transcript:",
      input.transcript,
    ].join("\n"),
  });
}

export function detectConflicts(input: ConflictDetectionInput): Promise<ConflictDetection> {
  const earlier = (d: ConflictDetectionInput["earlierDecisions"][number]) =>
    [
      `[${d.id}] ${d.summary}`,
      `    from "${d.meetingTitle}" on ${d.meetingDate}`,
      d.rationale && `    rationale: ${d.rationale}`,
      ...d.quotes.map((q) => `    quote: "${q}"`),
    ]
      .filter(Boolean)
      .join("\n");
  const proposed = (d: ConflictDetectionInput["newDecisions"][number]) =>
    [
      `[${d.id}] ${d.summary}`,
      d.rationale && `    rationale: ${d.rationale}`,
      ...d.quotes.map((q) => `    quote: "${q}"`),
      `    compare with: ${d.compareWith.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");

  return groq.completeJson({
    name: "conflict_detection",
    schema: ConflictDetectionSchema,
    system: [
      "You check whether decisions just extracted from a meeting conflict with decisions approved in earlier meetings.",
      "Return exactly one comparison for every pair listed under 'compare with', and no other pairs.",
      "relation:",
      "- changes: the new decision explicitly revises the earlier one (moves a date, reassigns an owner, changes scope or budget, cancels or pauses it).",
      "- contradicts: both cannot be true at the same time, but the new one does not say it replaces the earlier one.",
      "- confirms: repeats, restates or is consistent with the earlier decision, including adding detail that does not change it.",
      "- unrelated: about a different subject, even if some words overlap.",
      "kind (for changes/contradicts): deadline (dates, launch or release timing), ownership (who owns, leads or is responsible), " +
        "scope (what is included or excluded), budget (money, headcount, cost), cancellation (dropped, cancelled, paused, stopped), otherwise other.",
      "certain: false when the new statement is tentative, hedged or conditional ('maybe', 'might', 'probably', 'leaning towards', 'if', 'not confirmed'), " +
        "or when it is unclear whether both decisions refer to the same thing. If a pair might be a conflict but you are not sure, " +
        "report changes or contradicts with certain=false rather than confirms or unrelated, so a person can review it.",
      "Compare calendar dates by value: the same date written differently is not a conflict.",
      "evidenceQuote must be copied exactly from the new decision's quotes, or null.",
    ].join("\n"),
    user: [
      `Meeting: ${input.meeting.title} (${input.meeting.date})`,
      "",
      "Earlier approved decisions:",
      ...input.earlierDecisions.map(earlier),
      "",
      "New decisions from this meeting:",
      ...input.newDecisions.map(proposed),
    ].join("\n"),
  });
}
