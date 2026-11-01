const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => toIso(new Date(toDate(iso).getTime() + n * DAY_MS));

/**
 * Deterministically resolves common relative deadline phrases against the meeting date.
 * Language models are unreliable at calendar arithmetic, so a recognised phrase overrides the model's date.
 * Returns null for phrases it does not recognise (callers then fall back to the model's date).
 *
 * - "today" / "tomorrow" / "in N days|weeks"
 * - "<weekday>", "this <weekday>": the next such day, today included for "this"
 * - "next <weekday>": that weekday in the following Monday–Sunday week
 * - "end of (the) week" / "EOW": the Friday of the current week (next Friday if the meeting is on a weekend)
 */
export function resolveDuePhrase(phrase: string | null, meetingDate: string): string | null {
  if (!phrase) return null;
  const p = phrase.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const dow = toDate(meetingDate).getUTCDay(); // 0 = Sunday
  const mondayOffset = (dow + 6) % 7; // days since Monday

  if (/\b(eod|end of (the )?day|today)\b/.test(p)) return meetingDate;
  if (/\btomorrow\b/.test(p)) return addDays(meetingDate, 1);

  const inN = /\bin (\d{1,3}) (day|days|week|weeks)\b/.exec(p);
  if (inN) return addDays(meetingDate, Number(inN[1]) * (inN[2]!.startsWith("week") ? 7 : 1));

  if (/\b(eow|end of (the |this )?week)\b/.test(p)) {
    return addDays(meetingDate, (5 - dow + 7) % 7);
  }

  const day = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(p));
  if (day === -1) return null;
  const targetOffset = (day + 6) % 7; // days since Monday for the target weekday
  if (/\bnext\b/.test(p)) return addDays(meetingDate, 7 - mondayOffset + targetOffset);
  const ahead = (day - dow + 7) % 7;
  return addDays(meetingDate, ahead === 0 && !/\bthis\b/.test(p) ? 7 : ahead);
}
