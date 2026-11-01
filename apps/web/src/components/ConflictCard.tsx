import type { ConflictKind, MeetingConflict } from "@recall/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";

const KIND_LABEL: Record<ConflictKind, string> = {
  deadline: "Deadline",
  ownership: "Owner",
  scope: "Scope",
  budget: "Budget",
  cancellation: "Cancellation",
  other: "Decision",
};

const RESOLVED_LABEL = {
  kept_old: "Resolved · earlier decision kept",
  kept_new: "Resolved · replaced by new decision",
  dismissed: "Dismissed · not a conflict",
} as const;

const RESOLUTION_NOTE = {
  kept_old: "The earlier decision stays in effect and the new draft was rejected.",
  kept_new: "The new decision is now active and the earlier one is superseded.",
  dismissed: "Reviewed and not treated as a conflict. Neither decision was changed.",
} as const;

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { timeZone: "UTC", dateStyle: "medium" });

function Side({
  kind,
  label,
  summary,
  quote,
  struck,
}: {
  kind: "old" | "new";
  label: ReactNode;
  summary: string;
  quote?: string;
  /** Only the side that no longer stands is struck through. */
  struck: boolean;
}) {
  return (
    <div className={`compare-side ${kind === "old" ? "compare-old" : "compare-new"} ${struck ? "compare-struck" : ""}`}>
      <p className="compare-label">{label}</p>
      <p className="compare-text display mt-2 text-[1.1875rem] leading-snug">{summary}</p>
      {quote && <p className="quote">“{quote}”</p>}
    </div>
  );
}

/** Old-vs-new comparison for a decision that conflicts with an earlier approved one. Nothing is changed automatically. */
export function ConflictCard({ conflict: c, actions }: { conflict: MeetingConflict; actions?: ReactNode }) {
  const resolution = c.resolution;
  const resolved = resolution !== "open";
  const uncertain = c.certainty === "uncertain";
  const prev = c.previousDecision;
  // The earlier decision is struck only while a clear conflict is open, or once it was actually replaced.
  const oldStruck = resolution === "kept_new" || (!resolved && !uncertain);
  const newStruck = resolution === "kept_old";
  return (
    <li className="rise">
      <div className="flex flex-wrap items-center gap-2">
        {resolved ? (
          <span className={resolution === "dismissed" ? "tag" : "tag-ok"}>{RESOLVED_LABEL[resolution]}</span>
        ) : (
          <span className={uncertain ? "tag-caution" : "tag-conflict"}>
            {uncertain ? "Possible conflict · needs review" : c.relation === "changes" ? "Changes an earlier decision" : "Contradicts an earlier decision"}
          </span>
        )}
        <span className="tag">{KIND_LABEL[c.kind]}</span>
        {c.previousValue && c.newValue && (
          <span className="text-ink text-sm font-medium tabular-nums">
            {c.previousValue} <span aria-label="becomes">→</span> {c.newValue}
          </span>
        )}
      </div>

      <div className={`compare mt-3 ${resolved ? "compare-resolved" : ""}`}>
        <Side
          kind="old"
          struck={oldStruck}
          label={
            <>
              Earlier decision · <Link to={`/meetings/${prev.meetingId}`} className="link normal-case">{prev.meetingTitle}</Link> ·{" "}
              {formatDate(prev.meetingOccurredAt)}
            </>
          }
          summary={prev.summary}
          quote={prev.evidence[0]?.quote}
        />
        <Side
          kind="new"
          struck={newStruck}
          label={resolved ? "This meeting" : "This meeting · draft"}
          summary={c.decision.summary}
          quote={c.evidenceQuote ?? c.decision.evidence[0]?.quote}
        />
      </div>

      <p className="mt-4 text-sm">{c.explanation}</p>
      <p className="meta mt-1">
        {resolved ? (
          <>
            {RESOLUTION_NOTE[resolution]}
            {c.resolvedAt && ` Resolved ${formatDate(c.resolvedAt)}.`}
          </>
        ) : (
          <>
            {uncertain && "This may not be a real change. Check the transcript before acting on it. "}
            The earlier decision stays in effect until you resolve this.
          </>
        )}
      </p>
      {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
    </li>
  );
}
