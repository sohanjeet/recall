import type { ApprovalDecision, ApprovalsResponse, ApprovalTask, AuditEvent, ConflictAction, MeetingConflict } from "@recall/shared";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ActingAs } from "../components/ActingAs";
import { ConflictCard } from "../components/ConflictCard";
import { EmptyState } from "../components/EmptyState";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { useUser } from "../lib/auth";
import { formatDay, formatInstant } from "../lib/dates";
import { useAsync } from "../lib/useAsync";

const primary = "btn-primary";
const secondary = "btn-secondary";
const input = "field";

type Run = (key: string, fn: () => Promise<unknown>) => Promise<boolean>;

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="border-line mt-12 border-t pt-8 [header+&]:mt-0 [header+&]:border-t-0 [header+&]:pt-0">
      <h2 className="section-title mb-5">
        {title}
        <span className="count">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function Quotes({ quotes }: { quotes: string[] }) {
  return (
    <ul className="mt-3 space-y-1.5">
      {quotes.map((q) => (
        <li key={q} className="quote !mt-0">
          “{q}”
        </li>
      ))}
    </ul>
  );
}

function Card({ children, tone = "line" }: { children: ReactNode; tone?: "line" | "amber" | "rose" }) {
  const border = { line: "", amber: "", rose: "item-conflict" }[tone];
  return <li className={`item ${border}`}>{children}</li>;
}

function Origin({ meetingId, title }: { meetingId: string; title: string }) {
  return (
    <p className="meta mt-2">
      From <Link to={`/meetings/${meetingId}`} className="link">{title}</Link>
    </p>
  );
}

function History({ type, id }: { type: AuditEvent["entityType"]; id: string }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function toggle() {
    setOpen(!open);
    if (!open) {
      setError(null);
      try {
        setEvents(await api.getAudit(type, id));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load history");
      }
    }
  }
  return (
    <div className="border-line mt-3 border-t pt-1 text-xs">
      <button type="button" onClick={toggle} aria-expanded={open} className="link -my-1 py-2">
        {open ? "Hide history" : "History"}
      </button>
      {open && (
        <ol className="text-muted mt-1 space-y-0.5 tabular-nums">
          {error && <li className="text-conflict">{error}</li>}
          {events?.length === 0 && <li>No changes recorded yet.</li>}
          {events?.map((e) => (
            <li key={e.id}>
              {formatInstant(e.createdAt)} · {e.actor} · {e.action.replace("_", " ")}
              {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus && ` (${e.fromStatus} → ${e.toStatus})`}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DecisionItem({ d, run, busy, error }: { d: ApprovalDecision; run: Run; busy: boolean; error?: string }) {
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(d.summary);
  const [rationale, setRationale] = useState(d.rationale ?? "");
  const blocking = d.openConflicts.filter((c) => c.certainty === "clear").length;
  const possible = d.openConflicts.length - blocking;

  async function save() {
    const ok = await run(d.id, () =>
      api.editDecision(d.id, { version: d.version, summary: summary.trim(), rationale: rationale.trim() || null }),
    );
    if (ok) setEditing(false);
  }

  return (
    <Card tone={blocking ? "rose" : "line"}>
      {editing ? (
        <div className="space-y-3">
          <label className="label">
            Decision
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} maxLength={500} className={`${input} mt-1`} />
          </label>
          <label className="label">
            Rationale
            <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} maxLength={2000} className={`${input} mt-1`} />
          </label>
          <div className="flex gap-2">
            <button type="button" className={primary} disabled={busy || !summary.trim()} onClick={save}>Save</button>
            <button type="button" className={secondary} disabled={busy} onClick={() => { setEditing(false); setSummary(d.summary); setRationale(d.rationale ?? ""); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="font-medium">{d.summary}</p>
          {d.rationale && <p className="text-muted mt-1.5 text-sm">{d.rationale}</p>}
          <Origin meetingId={d.meetingId} title={d.meetingTitle} />
          <Quotes quotes={d.evidence.map((e) => e.quote)} />
          {blocking > 0 && (
            <p className="text-conflict mt-3 text-xs font-medium">
              Cannot be approved until {blocking === 1 ? "its conflict is" : "its conflicts are"} resolved below.
            </p>
          )}
          {possible > 0 && (
            <p className="text-caution mt-3 text-xs">
              Has {possible} possible conflict{possible > 1 ? "s" : ""}. Approving counts {possible > 1 ? "them" : "it"} as not a real conflict.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={primary} disabled={busy || blocking > 0} onClick={() => run(d.id, () => api.approveDecision(d.id, d.version))}>
              Approve
            </button>
            <button type="button" className={secondary} disabled={busy} onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className={secondary} disabled={busy} onClick={() => run(d.id, () => api.rejectDecision(d.id, d.version))}>
              Reject
            </button>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-conflict mt-3 text-xs font-medium">{error}</p>}
      <History type="decision" id={d.id} />
    </Card>
  );
}

function TaskItem({ t, run, busy, error, linearConfigured }: { t: ApprovalTask; run: Run; busy: boolean; error?: string; linearConfigured: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [description, setDescription] = useState(t.description ?? "");
  const [owner, setOwner] = useState(t.ownerName ?? "");
  const [due, setDue] = useState(t.dueDate ?? "");

  async function save() {
    const ok = await run(t.id, () =>
      api.editTask(t.id, {
        version: t.version,
        title: title.trim(),
        description: description.trim() || null,
        ownerName: owner.trim() || null,
        dueDate: due || null,
      }),
    );
    if (ok) setEditing(false);
  }

  return (
    <Card>
      {editing ? (
        <div className="space-y-3">
          <label className="label">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} className={`${input} mt-1`} />
          </label>
          <label className="label">
            Description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={4000} className={`${input} mt-1`} />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="label">
              Owner
              <input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={100} className={`${input} mt-1`} />
            </label>
            <label className="label">
              Due date
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${input} mt-1`} />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" className={primary} disabled={busy || !title.trim()} onClick={save}>Save</button>
            <button type="button" className={secondary} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="font-medium">{t.title}</p>
          {t.description && <p className="text-muted mt-1.5 text-sm">{t.description}</p>}
          <dl className="border-line mt-3 flex flex-wrap gap-x-8 gap-y-1 border-t pt-3 text-[0.8125rem]">
            <div>
              <dt className="text-muted inline">Owner </dt>
              <dd className="inline font-medium">{t.ownerName ?? "unassigned"}{t.ownerName && !t.ownerPersonId && " (not matched to a known person)"}</dd>
            </div>
            <div>
              <dt className="text-muted inline">Due </dt>
              <dd className="inline font-medium">{t.dueDate ? formatDay(t.dueDate, { dateStyle: "medium" }) : t.duePhrase ? "unresolved" : "none"}{t.duePhrase && ` (“${t.duePhrase}”)`}</dd>
            </div>
          </dl>
          <Origin meetingId={t.meetingId} title={t.meetingTitle} />
          <Quotes quotes={t.evidence.map((e) => e.quote)} />
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={primary} disabled={busy} onClick={() => run(t.id, () => api.approveTask(t.id, t.version))}>
              {linearConfigured ? "Approve & send to Linear" : "Approve"}
            </button>
            <button type="button" className={secondary} disabled={busy} onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className={secondary} disabled={busy} onClick={() => run(t.id, () => api.rejectTask(t.id, t.version))}>
              Reject
            </button>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-conflict mt-3 text-xs font-medium">{error}</p>}
      <History type="task" id={t.id} />
    </Card>
  );
}

function SyncItem({ t, run, busy, error, linearConfigured }: { t: ApprovalTask; run: Run; busy: boolean; error?: string; linearConfigured: boolean }) {
  const synced = t.status === "synced";
  const syncing = t.syncStatus === "syncing";
  const failed = t.syncStatus === "failed";
  return (
    <Card tone={failed ? "rose" : "line"}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium">{t.title}</p>
        <span
          className={synced ? "tag-ok" : failed ? "tag-conflict" : "tag"}
        >
          {synced ? "In Linear" : failed ? "Sync failed" : syncing ? "Sending…" : "Not sent yet"}
        </span>
      </div>
      <Origin meetingId={t.meetingId} title={t.meetingTitle} />
      {synced && t.externalUrl && (
        <p className="mt-3 text-sm">
          <a href={t.externalUrl} target="_blank" rel="noreferrer" className="link">Open in Linear</a>
        </p>
      )}
      {failed && t.syncError && (
        <p className="text-conflict mt-3 text-xs">
          {t.syncError} (attempt {t.syncAttempts}). The task is approved; no Linear issue was recorded.
        </p>
      )}
      {!synced && !linearConfigured && (
        <p className="meta mt-3">Linear is not configured on the server. Set LINEAR_API_KEY and LINEAR_TEAM_ID to send approved tasks.</p>
      )}
      {!synced && linearConfigured && (
        <div className="mt-3">
          <button type="button" className={primary} disabled={busy || syncing} onClick={() => run(t.id, () => api.syncTask(t.id))}>
            {failed ? "Retry sync" : "Send to Linear"}
          </button>
          {syncing && (
            <span className="meta ml-3">A sync is in progress; if it stalls it can be retried after about a minute.</span>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-conflict mt-3 text-xs font-medium">{error}</p>}
      <History type="task" id={t.id} />
    </Card>
  );
}

export function ApprovalsPage() {
  const { state, reload, set } = useAsync(() => api.getApprovals(), []);
  const user = useUser();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Runs an action, then reloads the list from the server so the page always shows the stored state, never a guess.
  const run: Run = async (key, fn) => {
    setBusy(key);
    setErrors((e) => {
      const { [key]: _drop, ...rest } = e;
      return rest;
    });
    let ok = true;
    try {
      await fn();
    } catch (err) {
      ok = false;
      setErrors((e) => ({ ...e, [key]: err instanceof Error ? err.message : "Action failed" }));
    }
    try {
      set(await api.getApprovals());
    } catch {
      /* keep the last good list; the next action or reload will refresh it */
    }
    setBusy(null);
    return ok;
  };

  if (state.kind === "loading")
    return (
      <>
        <PageHeader title="Approvals" />
        <p className="meta" role="status">Loading approvals…</p>
      </>
    );
  if (state.kind === "error")
    return (
      <>
        <PageHeader title="Approvals" />
        <ErrorNotice message={state.message} onRetry={reload} />
      </>
    );

  const data: ApprovalsResponse = state.data;
  const awaiting = data.decisions.length + data.tasks.length + data.conflicts.length;

  function conflictActions(c: MeetingConflict) {
    const act = (action: ConflictAction) => run(c.id, () => api.resolveConflict(c.id, action));
    const oldActive = c.previousDecision.status === "active";
    return (
      <>
        <button type="button" className={secondary} disabled={busy === c.id} onClick={() => act("keep_old")}>Keep old decision</button>
        <button type="button" className={primary} disabled={busy === c.id || !oldActive} onClick={() => act("accept_new")}
          title={oldActive ? undefined : "The earlier decision is no longer active"}>
          Accept new decision
        </button>
        {c.certainty === "uncertain" && (
          <button type="button" className={secondary} disabled={busy === c.id} onClick={() => act("dismiss")}>Not a conflict</button>
        )}
        {errors[c.id] && <p role="alert" className="text-conflict w-full text-xs font-medium">{errors[c.id]}</p>}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Nothing is created in Linear until you approve it here."
        actions={<ActingAs email={user.email} />}
      />

      {awaiting === 0 && data.sync.length === 0 && (
        <EmptyState title="Nothing waiting for approval">Proposed decisions and tasks from analyzed meetings will queue here for review.</EmptyState>
      )}

      {data.conflicts.length > 0 && (
        <Section title="Conflicts to resolve" count={data.conflicts.length}>
          <ul className="space-y-10">
            {data.conflicts.map((c) => (
              <ConflictCard key={c.id} conflict={c} actions={conflictActions(c)} />
            ))}
          </ul>
        </Section>
      )}

      {data.decisions.length > 0 && (
        <Section title="Proposed decisions" count={data.decisions.length}>
          <ul className="space-y-3">
            {data.decisions.map((d) => (
              <DecisionItem key={`${d.id}:${d.version}`} d={d} run={run} busy={busy === d.id} error={errors[d.id]} />
            ))}
          </ul>
        </Section>
      )}

      {data.tasks.length > 0 && (
        <Section title="Proposed tasks" count={data.tasks.length}>
          <ul className="space-y-3">
            {data.tasks.map((t) => (
              <TaskItem key={`${t.id}:${t.version}`} t={t} run={run} busy={busy === t.id} error={errors[t.id]} linearConfigured={data.linearConfigured} />
            ))}
          </ul>
        </Section>
      )}

      {data.sync.length > 0 && (
        <Section title="Linear sync" count={data.sync.length}>
          <ul className="space-y-3">
            {data.sync.map((t) => (
              <SyncItem key={`${t.id}:${t.version}`} t={t} run={run} busy={busy === t.id} error={errors[t.id]} linearConfigured={data.linearConfigured} />
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
