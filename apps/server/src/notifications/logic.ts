import type { DigestTask, OwnerDigest, TaskRef, TaskStatus } from "@recall/shared";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Only tasks a human approved and that are not finished can produce reminders or appear as overdue/upcoming. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ["approved", "synced"];
export const isOpenTask = (status: string) => (OPEN_TASK_STATUSES as readonly string[]).includes(status);

export const toDay = (d: Date) => d.toISOString().slice(0, 10);
const dayMs = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime();
export const addDays = (iso: string, n: number) => toDay(new Date(dayMs(iso) + n * DAY_MS));

/** Whole days from `a` to `b` (positive when b is later). */
export const daysBetween = (a: string, b: string) => Math.round((dayMs(b) - dayMs(a)) / DAY_MS);

/** The deadline instant of a date-only due date: 00:00 UTC on that day. */
export const dueInstant = (dueDate: string) => new Date(dayMs(dueDate));

/** A reminder becomes due `windowHours` before the deadline instant. */
export const remindAt = (dueDate: string, windowHours: number) => new Date(dayMs(dueDate) - windowHours * HOUR_MS);

export interface ReminderTask {
  status: string;
  dueDate: string | null;
}

/**
 * True when a reminder should exist now: the task is approved/synced, has a due date that is today or later
 * (past-due tasks are "overdue" in the digest, not reminded), and the reminder window has opened.
 */
export function needsReminder(task: ReminderTask, now: Date, windowHours: number): boolean {
  if (!isOpenTask(task.status) || !task.dueDate) return false;
  if (task.dueDate < toDay(now)) return false;
  return remindAt(task.dueDate, windowHours).getTime() <= now.getTime();
}

export const hoursUntilDue = (dueDate: string, now: Date) => Math.round((dueInstant(dueDate).getTime() - now.getTime()) / HOUR_MS);

/** Monday (UTC) of the week containing `day`. */
export function weekStartOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export const UPCOMING_DAYS = 7;

export interface DigestInput extends TaskRef {
  ownerPersonId: string | null;
  completedAt: string | null;
}

/**
 * Groups tasks by owner into overdue / upcoming / completed.
 * - overdue: approved/synced, due before today
 * - upcoming: approved/synced, due today through the next 7 days
 * - completed: done, completed during the week starting `weekStart`
 * Rejected, proposed and tasks outside those rules are ignored. Owners with nothing to show are omitted.
 */
export function buildOwnerDigests(tasks: DigestInput[], today: string, weekStart: string): OwnerDigest[] {
  const weekEnd = addDays(weekStart, 6);
  const upcomingEnd = addDays(today, UPCOMING_DAYS);
  const groups = new Map<string, OwnerDigest>();

  const groupFor = (t: DigestInput): OwnerDigest => {
    const name = t.ownerName?.trim() || null;
    const key = t.ownerPersonId ? `p:${t.ownerPersonId}` : name ? `n:${name.toLowerCase()}` : "unassigned";
    let g = groups.get(key);
    if (!g) {
      g = { personId: t.ownerPersonId, ownerName: name ?? "Unassigned", overdue: [], upcoming: [], completed: [] };
      groups.set(key, g);
    }
    return g;
  };

  for (const t of tasks) {
    if (t.status === "done") {
      const doneOn = t.completedAt?.slice(0, 10);
      if (doneOn && doneOn >= weekStart && doneOn <= weekEnd) {
        groupFor(t).completed.push({ ...t, daysOverdue: null });
      }
      continue;
    }
    if (!isOpenTask(t.status) || !t.dueDate) continue;
    if (t.dueDate < today) groupFor(t).overdue.push({ ...t, daysOverdue: daysBetween(t.dueDate, today) });
    else if (t.dueDate <= upcomingEnd) groupFor(t).upcoming.push({ ...t, daysOverdue: daysBetween(t.dueDate, today) });
  }

  const byDue = (a: DigestTask, b: DigestTask) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.title.localeCompare(b.title);
  const byDone = (a: DigestTask, b: DigestTask) => (a.completedAt ?? "").localeCompare(b.completedAt ?? "") || a.title.localeCompare(b.title);
  const owners = [...groups.values()];
  for (const g of owners) {
    g.overdue.sort(byDue);
    g.upcoming.sort(byDue);
    g.completed.sort(byDone);
  }
  // Unassigned last, otherwise by name.
  return owners.sort((a, b) => Number(a.ownerName === "Unassigned") - Number(b.ownerName === "Unassigned") || a.ownerName.localeCompare(b.ownerName));
}
