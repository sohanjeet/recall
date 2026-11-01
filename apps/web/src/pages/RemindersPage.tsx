import type { DeliveryInfo, DigestTask, OwnerDigest, TaskRef } from "@recall/shared";
import { DEFAULT_REMINDER_WINDOW_HOURS } from "@recall/shared";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { EmptyState } from "../components/EmptyState";
import { ActingAs } from "../components/ActingAs";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { useUser } from "../lib/auth";
import { formatDay } from "../lib/dates";
import { useAsync } from "../lib/useAsync";

const primary = "btn-primary";
const secondary = "btn-secondary";

const WINDOWS = [
  { hours: 24, label: "24 hours" },
  { hours: 48, label: "2 days" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "1 week" },
];

const formatDate = (iso: string) => formatDay(iso);

/** Runs an async action with shared busy/error state. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, act };
}

function DeliveryNotice({ delivery }: { delivery: DeliveryInfo }) {
  return (
    <p className="notice-caution">
      <strong className="font-semibold">In-app only.</strong> {delivery.note} “Generated” means Recall created the item here; nothing below has been delivered.
    </p>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-line mt-10 border-t pt-8">
      <h2 className="section-title mb-5">
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function TaskLine({ t, extra, action }: { t: TaskRef; extra?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="font-medium">{t.title}</p>
        <p className="meta mt-0.5">
          {t.dueDate ? `Due ${formatDate(t.dueDate)}` : "No due date"}
          {extra}
          {" · From "}
          <Link to={`/meetings/${t.meeting.id}`} className="link">{t.meeting.title}</Link>
          {t.linearUrl && (
            <>
              {" · "}
              <a href={t.linearUrl} target="_blank" rel="noreferrer" className="link">Linear issue</a>
            </>
          )}
        </p>
      </div>
      {action}
    </div>
  );
}

function RemindersTab() {
  const [windowHours, setWindowHours] = useState(DEFAULT_REMINDER_WINDOW_HOURS);
  const inbox = useAsync(() => api.getReminders(), []);
  const preview = useAsync(() => api.previewReminders(windowHours), [windowHours]);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, act } = useAction();

  const generate = () =>
    act(async () => {
      const r = await api.generateReminders(windowHours);
      setNotice(
        r.created === 0
          ? "No new reminders — everything inside the window already has one."
          : `Generated ${r.created} in-app reminder${r.created === 1 ? "" : "s"}. Nothing was sent anywhere.`,
      );
      inbox.reload();
      preview.reload();
    });

  return (
    <>
      {inbox.state.kind === "ready" && <DeliveryNotice delivery={inbox.state.data.delivery} />}

      <Section title="Preview">
        <div className="flex flex-wrap items-end gap-3">
          <label className="label">
            Remind this long before the due date
            <select
              value={windowHours}
              onChange={(e) => {
                setWindowHours(Number(e.target.value));
                setNotice(null);
              }}
              className="field mt-1.5"
            >
              {WINDOWS.map((w) => (
                <option key={w.hours} value={w.hours}>
                  {w.label}
                  {w.hours === DEFAULT_REMINDER_WINDOW_HOURS ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={primary}
            disabled={busy || preview.state.kind !== "ready" || preview.state.data.counts.new === 0}
            onClick={generate}
          >
            {busy ? "Generating…" : "Generate reminders"}
          </button>
        </div>
        {notice && <p role="status" className="text-ok mt-4 text-sm font-medium">{notice}</p>}
        {error && <div className="mt-3"><ErrorNotice message={error} /></div>}

        <div className="mt-6">
          {preview.state.kind === "loading" && <p className="meta" role="status">Loading preview…</p>}
          {preview.state.kind === "error" && <ErrorNotice message={preview.state.message} onRetry={preview.reload} />}
          {preview.state.kind === "ready" && preview.state.data.items.length === 0 && (
            <EmptyState title="Nothing to remind about">
              Only approved tasks with a due date inside the window get reminders. Proposed, rejected, completed and already-overdue tasks never do.
            </EmptyState>
          )}
          {preview.state.kind === "ready" && preview.state.data.items.length > 0 && (
            <>
              <p className="meta mb-3 tabular-nums">
                {preview.state.data.counts.new} new · {preview.state.data.counts.alreadyGenerated} already generated
              </p>
              <ul className="space-y-2">
                {preview.state.data.items.map((i) => (
                  <li key={i.taskId} className="item !px-5 !py-4">
                    <TaskLine
                      t={i}
                      extra={` · ${i.ownerName ?? "Unassigned"}`}
                      action={
                        <span className={i.alreadyGenerated ? "tag" : "tag-draft"}>
                          {i.alreadyGenerated ? "Already generated" : "Will be generated"}
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Section>

      <Section title={`Reminder inbox${inbox.state.kind === "ready" ? ` · ${inbox.state.data.unread} unread` : ""}`}>
        {inbox.state.kind === "loading" && <p className="meta" role="status">Loading…</p>}
        {inbox.state.kind === "error" && <ErrorNotice message={inbox.state.message} onRetry={inbox.reload} />}
        {inbox.state.kind === "ready" && inbox.state.data.reminders.length === 0 && (
          <EmptyState title="No reminders yet">Generate reminders above to fill your inbox.</EmptyState>
        )}
        {inbox.state.kind === "ready" && inbox.state.data.reminders.length > 0 && (
          <ul className="space-y-2">
            {inbox.state.data.reminders.map((r) => (
              <li
                key={r.id}
                className={`item !px-5 !py-4 ${!r.readAt && r.taskOpen ? "!border-accent" : ""} ${r.taskOpen ? "" : "opacity-65"}`}
              >
                <TaskLine
                  t={r}
                  extra={` · ${r.ownerName ?? "Unassigned"}`}
                  action={
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tag">
                        {r.deliveredAt ? "Delivered" : "Generated · not delivered"}
                      </span>
                      {!r.taskOpen ? (
                        <span className="tag-ok">Task completed</span>
                      ) : r.readAt ? (
                        <span className="meta">Read</span>
                      ) : (
                        <button
                          type="button"
                          className={secondary}
                          disabled={busy}
                          onClick={() => act(async () => inbox.set(await api.markReminderRead(r.id)))}
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function OwnerCard({ owner, onComplete, busy }: { owner: OwnerDigest; onComplete: (t: DigestTask) => void; busy: boolean }) {
  const group = (label: string, tasks: DigestTask[], tone: string, showAction: boolean) =>
    tasks.length > 0 && (
      <div className="mt-5">
        <h4 className={`text-xs font-semibold tracking-wide uppercase ${tone}`}>
          {label} ({tasks.length})
        </h4>
        <ul className="mt-2 space-y-3">
          {tasks.map((t) => (
            <li key={t.taskId} className="border-line border-t pt-3 first:border-t-0 first:pt-0">
              <TaskLine
                t={t}
                extra={
                  t.daysOverdue === null
                    ? ""
                    : t.daysOverdue > 0
                      ? ` · ${t.daysOverdue} day${t.daysOverdue === 1 ? "" : "s"} overdue`
                      : t.daysOverdue === 0
                        ? " · due today"
                        : ` · in ${-t.daysOverdue} day${t.daysOverdue === -1 ? "" : "s"}`
                }
                action={
                  showAction && (
                    <button type="button" className={secondary} disabled={busy} onClick={() => onComplete(t)}>
                      Mark done
                    </button>
                  )
                }
              />
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <li className="item">
      <h3 className="display text-xl">
        {owner.ownerName}
        {!owner.personId && <span className="tag ml-3 align-middle font-sans">Not a known person · preview only</span>}
      </h3>
      {group("Overdue", owner.overdue, "text-conflict", true)}
      {group("Upcoming (next 7 days)", owner.upcoming, "text-muted", true)}
      {group("Completed this week", owner.completed, "text-ok", false)}
    </li>
  );
}

function DigestsTab() {
  const user = useUser();
  const preview = useAsync(() => api.previewDigest(), []);
  const stored = useAsync(() => api.getDigests(), []);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, act } = useAction();
  const refresh = () => {
    preview.reload();
    stored.reload();
  };

  return (
    <>
      {preview.state.kind === "ready" && <DeliveryNotice delivery={preview.state.data.delivery} />}
      <div className="mt-4">
        <ActingAs email={user.email} />
      </div>
      {preview.state.kind === "loading" && <p className="meta mt-6" role="status">Loading digest…</p>}
      {preview.state.kind === "error" && (
        <div className="mt-6">
          <ErrorNotice message={preview.state.message} onRetry={preview.reload} />
        </div>
      )}
      {preview.state.kind === "ready" && (
        <Section title={`Week of ${formatDate(preview.state.data.weekStart)}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="meta tabular-nums">
              {preview.state.data.totals.overdue} overdue · {preview.state.data.totals.upcoming} upcoming · {preview.state.data.totals.completed} completed
            </p>
            <button
              type="button"
              className={primary}
              disabled={busy || preview.state.data.owners.length === 0}
              onClick={() =>
                act(async () => {
                  const r = await api.generateDigests();
                  setNotice(
                    `Saved ${r.stored} digest${r.stored === 1 ? "" : "s"} in Recall${r.notStored ? ` (${r.notStored} owner${r.notStored === 1 ? "" : "s"} not saved: not a known person)` : ""}. Nothing was sent.`,
                  );
                  refresh();
                })
              }
            >
              Generate this week’s digests
            </button>
          </div>
          {notice && <p role="status" className="text-ok mt-4 text-sm font-medium">{notice}</p>}
          {error && <div className="mt-3"><ErrorNotice message={error} /></div>}
          {preview.state.data.owners.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="Nothing to report this week">
                Digests list approved tasks that are overdue or due in the next 7 days, and tasks completed this week.
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-6 space-y-3">
              {preview.state.data.owners.map((o) => (
                <OwnerCard
                  key={o.personId ?? o.ownerName}
                  owner={o}
                  busy={busy}
                  onComplete={(t) =>
                    act(async () => {
                      await api.completeTask(t.taskId);
                      refresh();
                    })
                  }
                />
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Saved digests" count={stored.state.kind === "ready" ? stored.state.data.length : undefined}>
        {stored.state.kind === "error" && <ErrorNotice message={stored.state.message} onRetry={stored.reload} />}
        {stored.state.kind === "ready" && stored.state.data.length === 0 && <p className="meta">No digests saved yet.</p>}
        {stored.state.kind === "ready" && stored.state.data.length > 0 && (
          <ul className="space-y-2">
            {stored.state.data.map((d) => (
              <li key={d.id} className="item flex flex-wrap items-center justify-between gap-2 !px-5 !py-4 text-sm">
                <span>
                  <span className="font-medium">{d.ownerName}</span>
                  <span className="text-muted tabular-nums">
                    {" "}· week of {formatDate(d.weekStart)} · {d.content.overdue.length} overdue · {d.content.upcoming.length} upcoming · {d.content.completed.length} completed
                  </span>
                </span>
                <span className="tag">{d.deliveredAt ? "Delivered" : "Saved · not delivered"}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

export function RemindersPage() {
  const [tab, setTab] = useState<"reminders" | "digests">("reminders");
  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm ${active ? "bg-accent-soft text-accent font-medium" : "text-muted hover:text-ink hover:bg-surface"}`;
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = tab === "reminders" ? "digests" : "reminders";
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  }
  return (
    <>
      <PageHeader title="Reminders & digests" description="Deadline reminders and a weekly summary per owner, kept inside Recall." />
      <div role="tablist" aria-label="Reminders and digests" className="mb-2 flex gap-1" onKeyDown={onKeyDown}>
        <button role="tab" id="tab-reminders" aria-controls="panel-main" aria-selected={tab === "reminders"} tabIndex={tab === "reminders" ? 0 : -1} className={tabClass(tab === "reminders")} onClick={() => setTab("reminders")}>
          Reminders
        </button>
        <button role="tab" id="tab-digests" aria-controls="panel-main" aria-selected={tab === "digests"} tabIndex={tab === "digests" ? 0 : -1} className={tabClass(tab === "digests")} onClick={() => setTab("digests")}>
          Weekly digests
        </button>
      </div>
      <div role="tabpanel" id="panel-main" aria-labelledby={`tab-${tab}`}>
        {tab === "reminders" ? <RemindersTab /> : <DigestsTab />}
      </div>
    </>
  );
}
