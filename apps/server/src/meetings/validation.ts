import { z } from "zod";
import { MEETING_SOURCES } from "@recall/shared";

export const MAX_TRANSCRIPT_CHARS = 50_000;

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const name = z.string().trim().min(1).max(100);

export const CreateMeetingBody = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  occurredAt: z.string().refine(isRealDate, "Must be a valid date (YYYY-MM-DD)"),
  participants: z
    .array(name)
    .max(50)
    .default([])
    .transform((names) => names.filter((n, i) => names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i)),
  transcript: z
    .string()
    .trim()
    .min(1, "Transcript is required")
    .max(MAX_TRANSCRIPT_CHARS, `Transcript must be at most ${MAX_TRANSCRIPT_CHARS} characters`),
  source: z.enum(MEETING_SOURCES).default("paste"),
  speakerMap: z.record(z.string().trim().min(1).max(100), name).default({}),
});
export type CreateMeetingInput = z.output<typeof CreateMeetingBody>;

export const IdParam = z.uuid();
