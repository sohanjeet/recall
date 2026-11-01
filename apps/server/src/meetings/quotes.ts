import type { TranscriptSegment } from "@recall/shared";

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export type QuoteMatch = { segmentId: string | null; quote: string };

type Segment = Pick<TranscriptSegment, "id" | "text"> & { speakerLabel?: string };

const ELLIPSIS = /\s*(?:\.{3,}|…)\s*/u;

/**
 * Returns a lookup that accepts a quote only if it appears in one of the segments (ignoring case, punctuation and
 * whitespace). The transcript is shown to the model as "Speaker: text", so models often echo the "Speaker: " prefix;
 * that prefix is accepted only when it names the speaker of the segment the rest of the quote is found in.
 * Fragments joined by an ellipsis must each appear, in order, within a single segment. Nothing is paraphrased:
 * the stored quote is always the model's own words minus the prefix, and only if they occur in the transcript.
 */
export function quoteVerifier(segments: Segment[]) {
  const prepared = segments.map((s) => ({
    id: s.id,
    text: normalize(s.text),
    speaker: s.speakerLabel ? normalize(s.speakerLabel) : null,
  }));

  const containsInOrder = (text: string, fragments: string[]) => {
    let from = 0;
    for (const f of fragments) {
      const at = text.indexOf(f, from);
      if (at < 0) return false;
      from = at + f.length;
    }
    return true;
  };

  return (quote: string): QuoteMatch | null => {
    const fragmentsOf = (s: string) => s.split(ELLIPSIS).map(normalize).filter(Boolean);

    const direct = fragmentsOf(quote);
    if (direct.length > 0) {
      const hit = prepared.find((s) => containsInOrder(s.text, direct));
      if (hit) return { segmentId: hit.id, quote: quote.trim() };
    }

    // "Sam: We're changing…" → check the remainder against that speaker's own segments only.
    const prefixed = /^\s*(?:[[(]?\d{1,2}:\d{2}(?::\d{2})?[\])]?\s*)?([^:\n]{1,40}?)\s*:\s+(\S[\s\S]*)$/u.exec(quote);
    if (prefixed) {
      const speaker = normalize(prefixed[1]!);
      const rest = prefixed[2]!.trim();
      const fragments = fragmentsOf(rest);
      if (speaker && fragments.length > 0) {
        const hit = prepared.find((s) => s.speaker === speaker && containsInOrder(s.text, fragments));
        if (hit) return { segmentId: hit.id, quote: rest };
      }
    }
    return null;
  };
}
