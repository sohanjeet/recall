import type { Evidence, MeetingDetail } from "@recall/shared";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ConflictCard } from "../components/ConflictCard";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { formatDay } from "../lib/dates";
import { useAsync } from "../lib/useAsync";
import { STATUS_LABEL } from "./MeetingsPage";

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-line mt-12 border-t pt-8">
      <h2 className="section-title mb-5">
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function Quotes({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return <p className="meta mt-3">No supporting quote found in the transcript.</p>;
  return (
    <ul className="mt-3 space-y-1.5">
      {evidence.map((e) => (
        <li key={e.id} className="quote !mt-0">
          “{e.quote}”
        </li>
      ))}
    </ul>
  );
}

const Draft = () => <span className="tag-draft">Draft</span>;

const StatusTag = ({ status }: { status: string }) => (
  <span className={`${status === "approved" || status === "active" || status === "synced" ? "tag-ok" : "tag"} capitalize`}>{status}</span>
);

export function MeetingDetailPage() {
  const { id = "" } = useParams();
  const { state, reload, set } = useAsync(() => api.getMeeting(id), [id]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  async function checkConflicts() {
    setChecking(true);
    setCheckError(null);
    try {
      set(await api.checkConflicts(id));
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Conflict check failed");
      reload();
    } finally {
      setChecking(false);
    }
  }

  async function analyze() {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      set(await api.analyzeMeeting(id));
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Analysis failed");
      reload();
    } finally {
      setAnalyzing(false);
    }
  }

  if (state.kind === "loading")
    return (
      <>
        <PageHeader title="Meeting" />
        <p className="meta" role="status">Loading meeting…</p>
      </>
    );
  if (state.kind === "error")
    return (
      <>
        <PageHeader title="Meeting" />
        <ErrorNotice message={state.message} onRetry={state.status === 404 ? undefined : reload} />
        <p className="mt-4 text-sm">
          <Link to="/" className="link">Back to meetings</Link>
        </p>
      </>
    );

  const m: MeetingDetail = state.data;
  const analyzed = m.status === "extracted";
  const hasDrafts = m.decisions.some((d) => d.status === "proposed") || m.tasks.some((t) => t.status === "proposed");
  // Only unresolved conflicts warn; resolved ones stay visible in the conflicts section as history.
  const openConflictCount = (decisionId: string) =>
    m.conflicts.filter((c) => c.decisionId === decisionId && c.resolution === "open").length;
  const resolvedConflicts = (decisionId: string) =>
    m.conflicts.filter((c) => c.decisionId === decisionId && c.resolution !== "open");
  const RESOLVED_NOTE = {
    kept_new: "this decision replaced an earlier one",
    kept_old: "the earlier decision was kept and this draft rejected",
    dismissed: "reviewed and not treated as a conflict",
  } as const;

  return (
    <>
      <PageHeader
        title={m.title}
        description={`${new Date(m.occurredAt).toLocaleDateString(undefined, { timeZone: "UTC", dateStyle: "long" })}${
          m.participants.length ? ` · ${m.participants.join(", ")}` : ""
        } · ${STATUS_LABEL[m.status]}`}
        actions={
          m.status !== "extracting" && (m.status !== "extracted" || hasDrafts) ? (
            <button
              type="button"
              onClick={analyze}
              disabled={analyzing}
              className="btn-primary"
            >
              {analyzing ? "Analyzing…" : analyzed ? "Re-analyze" : m.status === "failed" ? "Retry analysis" : "Analyze"}
            </button>
          ) : undefined
        }
      />

      {m.status === "failed" && m.error && <ErrorNotice message={`Analysis failed: ${m.error}`} />}
      {analyzeError && m.status !== "failed" && <ErrorNotice message={analyzeError} />}
      {analyzing && <p className="meta" role="status">Extracting decisions and tasks… this can take a few seconds.</p>}
      {m.status === "extracting" && !analyzing && (
        <p className="meta">
          Analysis is running. <button type="button" onClick={reload} className="link">Refresh</button>
        </p>
      )}

      {analyzed && (
        <>
          <p className="text-muted">
            Drafts are reviewed on the{" "}
            <Link to="/approvals" className="link">Approvals page</Link>. Nothing is sent to Linear until you approve it.
          </p>

          {(m.conflicts.length > 0 || m.conflictCheck.status === "failed") && (
            <Section title="Conflicts with earlier decisions" count={m.conflicts.length}>
              {m.conflictCheck.status === "failed" && (
                <div className="mb-3">
                  <ErrorNotice
                    message={`${m.conflictCheck.error ?? "The conflict check failed"}. The extracted drafts are saved${
                      m.conflicts.length ? "; conflicts below are from the last successful check" : ""
                    }.`}
                    onRetry={checking ? undefined : checkConflicts}
                  />
                </div>
              )}
              {m.conflicts.length > 0 && (
                <ul className="space-y-10">
                  {m.conflicts.map((c) => (
                    <ConflictCard key={c.id} conflict={c} />
                  ))}
                </ul>
              )}
            </Section>
          )}
          {m.conflictCheck.status === "done" && m.conflicts.length === 0 && (
            <p className="tag-ok mt-6">No conflicts with earlier approved decisions</p>
          )}
          {m.conflictCheck.status === null && !checking && (
            <p className="meta mt-4">
              Not yet checked against earlier decisions.{" "}
              <button type="button" onClick={checkConflicts} className="link">
                Check for conflicts
              </button>
            </p>
          )}
          {checking && <p className="meta mt-3" role="status">Checking earlier decisions for conflicts…</p>}
          {checkError && m.conflictCheck.status !== "failed" && <ErrorNotice message={checkError} />}

          <Section title="Decisions" count={m.decisions.length}>
            {m.decisions.length === 0 ? (
              <p className="meta">No decisions found.</p>
            ) : (
              <ul className="space-y-3">
                {m.decisions.map((d) => (
                  <li key={d.id} className={`item ${openConflictCount(d.id) > 0 ? "item-conflict" : ""}`}>
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium">{d.summary}</p>
                      {d.status === "proposed" ? <Draft /> : <StatusTag status={d.status} />}
                    </div>
                    {d.rationale && <p className="text-muted mt-1.5 text-sm">{d.rationale}</p>}
                    {openConflictCount(d.id) > 0 && (
                      <p className="text-conflict mt-2 text-xs font-medium">
                        Conflicts with{" "}
                        {openConflictCount(d.id) === 1 ? "an earlier decision" : `${openConflictCount(d.id)} earlier decisions`}; see above.
                      </p>
                    )}
                    {openConflictCount(d.id) === 0 &&
                      resolvedConflicts(d.id).map((c) => (
                        <p key={c.id} className="meta mt-2 text-xs">
                          Conflict resolved: {RESOLVED_NOTE[c.resolution as keyof typeof RESOLVED_NOTE]}.
                        </p>
                      ))}
                    <Quotes evidence={d.evidence} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Tasks" count={m.tasks.length}>
            {m.tasks.length === 0 ? (
              <p className="meta">No tasks found.</p>
            ) : (
              <ul className="space-y-3">
                {m.tasks.map((t) => (
                  <li key={t.id} className="item">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium">{t.title}</p>
                      {t.status === "proposed" ? <Draft /> : <StatusTag status={t.status} />}
                    </div>
                    {t.description && <p className="text-muted mt-1.5 text-sm">{t.description}</p>}
                    <dl className="border-line mt-3 flex flex-wrap gap-x-8 gap-y-1 border-t pt-3 text-[0.8125rem]">
                      <div>
                        <dt className="text-muted inline">Owner </dt>
                        <dd className="inline font-medium">
                          {t.ownerName ?? "unassigned"}
                          {t.ownerName && !t.ownerPersonId && " (not matched to a known person)"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted inline">Due </dt>
                        <dd className="inline font-medium">
                          {t.dueDate ? formatDay(t.dueDate, { dateStyle: "medium" }) : t.duePhrase ? "unresolved" : "none"}
                          {t.duePhrase && ` (“${t.duePhrase}”)`}
                        </dd>
                      </div>
                    </dl>
                    <Quotes evidence={t.evidence} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {m.ambiguities.length > 0 && (
            <Section title="Needs your attention" count={m.ambiguities.length}>
              <ul className="space-y-2">
                {m.ambiguities.map((a) => (
                  <li key={a.id} className="notice-caution">
                    {a.description}
                    {a.quote && <span className="mt-1 block text-xs italic">“{a.quote}”</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      <Section title="Transcript" count={m.segments.length}>
        <ol className="panel divide-line divide-y text-sm">
          {m.segments.map((s) => (
            <li key={s.id} className="grid gap-1 px-5 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
              <span className="text-muted text-[0.8125rem] font-medium">{s.speakerLabel}</span>
              <span>{s.text}</span>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
