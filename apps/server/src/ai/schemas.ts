import { z } from "zod";
import { CONFLICT_KINDS } from "@recall/shared";

// Groq strict structured outputs require every property to be present, so absent values are
// `null` rather than optional.

const Quote = z.string().min(1).describe("Verbatim quote copied exactly from the transcript");

export const ExtractionSchema = z.object({
  decisions: z.array(
    z.object({
      summary: z.string().min(1).describe("The final decision, in one sentence"),
      rationale: z.string().nullable().describe("Why, only if stated"),
      evidenceQuotes: z.array(Quote),
    }),
  ),
  tasks: z.array(
    z.object({
      title: z.string().min(1).describe("Short imperative action item"),
      description: z.string().nullable(),
      ownerName: z.string().nullable().describe("Person who committed to or was assigned the task, only if stated"),
      duePhrase: z.string().nullable().describe("Deadline wording exactly as spoken, e.g. 'by next Friday'"),
      dueDate: z
        .string()
        .nullable()
        .describe("YYYY-MM-DD resolved against the meeting date; null if no deadline or it cannot be resolved"),
      evidenceQuotes: z.array(Quote),
    }),
  ),
  ambiguities: z.array(
    z.object({
      description: z.string().min(1).describe("What is unclear, e.g. no owner named, vague deadline, contradictory statements"),
      quote: z.string().nullable().describe("Verbatim transcript quote the ambiguity relates to"),
    }),
  ),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export const ConflictDetectionSchema = z.object({
  comparisons: z.array(
    z.object({
      newId: z.string().min(1).describe("Id of the new decision, e.g. N1"),
      earlierId: z.string().min(1).describe("Id of the earlier decision, e.g. E2"),
      relation: z
        .enum(["changes", "contradicts", "confirms", "unrelated"])
        .describe("changes: explicitly revises the earlier decision; contradicts: both cannot hold; confirms: consistent or repeated; unrelated: different subject"),
      kind: z.enum(CONFLICT_KINDS).describe("What differs; use 'other' for confirms/unrelated"),
      certain: z
        .boolean()
        .describe("false if the new statement is tentative, conditional, or may not refer to the same thing as the earlier decision"),
      previousValue: z.string().nullable().describe("The earlier value that differs, e.g. 'November 15'; null if none"),
      newValue: z.string().nullable().describe("The new value, e.g. 'November 22'; null if none"),
      evidenceQuote: z.string().nullable().describe("Verbatim quote from the new decision's evidence supporting the judgement"),
      explanation: z.string().min(1).describe("One or two sentences, describing the decisions by content, not by id"),
    }),
  ),
});
export type ConflictDetection = z.infer<typeof ConflictDetectionSchema>;

/** Labels (N1, E1…) rather than database ids keep the prompt short and make hallucinated references easy to reject. */
export interface ConflictDetectionInput {
  meeting: { title: string; date: string };
  newDecisions: { id: string; summary: string; rationale: string | null; quotes: string[]; compareWith: string[] }[];
  earlierDecisions: {
    id: string;
    summary: string;
    rationale: string | null;
    meetingTitle: string;
    meetingDate: string;
    quotes: string[];
  }[];
}
