import { meetingReviewState, type MeetingReviewTone } from "@recall/shared";
import { Link } from "react-router";
import { EmptyState } from "../components/EmptyState";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";

const TONE_TAG: Record<MeetingReviewTone, string> = {
  neutral: "tag",
  caution: "tag-caution",
  draft: "tag-draft",
  conflict: "tag-conflict",
  done: "tag-ok",
};

export const toneTag = (tone: MeetingReviewTone) => TONE_TAG[tone];

export function MeetingsPage() {
  const { state, reload } = useAsync(api.listMeetings, []);

  return (
    <>
      <PageHeader
        title="Meetings"
        description="Every meeting, its decisions, and the work that came out of it."
        actions={
          <Link to="/meetings/new" className="btn-primary">
            New meeting
          </Link>
        }
      />
      {state.kind === "loading" && <p className="meta" role="status">Loading meetings…</p>}
      {state.kind === "error" && <ErrorNotice message={state.message} onRetry={reload} />}
      {state.kind === "ready" && state.data.length === 0 && (
        <EmptyState
          title="No meetings yet"
          action={
            <Link to="/meetings/new" className="btn-primary">
              Add your first meeting
            </Link>
          }
        >
          Paste a transcript or dictate notes with Wispr Flow. Recall pulls out decisions, owners, and deadlines, and
          flags anything that contradicts an earlier decision.
        </EmptyState>
      )}
      {state.kind === "ready" && state.data.length > 0 && (
        <ul className="rise-2 border-line divide-line divide-y border-y">
          {state.data.map((m) => {
            const review = meetingReviewState(m);
            return (
            <li key={m.id}>
              <Link to={`/meetings/${m.id}`} className="row-link group">
                <span className="min-w-0">
                  <span className="display group-hover:text-accent block text-[1.25rem] leading-snug transition-colors">{m.title}</span>
                  <span className="meta mt-0.5 block">
                    {new Date(m.occurredAt).toLocaleDateString(undefined, { timeZone: "UTC", dateStyle: "medium" })}
                    {m.participants.length > 0 && ` · ${m.participants.join(", ")}`}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="meta tabular-nums">
                    {m.decisionCount} decision{m.decisionCount === 1 ? "" : "s"} · {m.taskCount} task{m.taskCount === 1 ? "" : "s"}
                  </span>
                  <span className={toneTag(review.tone)}>{review.label}</span>
                </span>
              </Link>
            </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
