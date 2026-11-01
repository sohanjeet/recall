import type { Pool } from "pg";
import {
  type DeliveryInfo,
  type DigestPreview,
  type GenerateDigestsResult,
  type GenerateRemindersResult,
  type Reminder,
  type ReminderInbox,
  type ReminderPreview,
  type StoredDigest,
  DEFAULT_REMINDER_WINDOW_HOURS,
} from "@recall/shared";
import { withTransaction } from "../approvals/common.js";
import { HttpError } from "../meetings/errors.js";
import type { Queryable } from "../meetings/service.js";
import { addDays, buildOwnerDigests, type DigestInput, hoursUntilDue, needsReminder, remindAt, toDay, weekStartOf } from "./logic.js";

/** There is no email/chat provider: generated items live in the Recall inbox and are never reported as delivered. */
export const DELIVERY: DeliveryInfo = {
  mode: "in-app",
  externalDelivery: "not_available",
  note: "Reminders and digests are generated inside Recall only. Nothing is emailed or sent anywhere.",
};

const TASK_COLUMNS = `t.id as task_id, t.title, t.status, t.owner_person_id, t.completed_at, t.external_url,
  coalesce(p.name, t.owner_name) as owner_name, to_char(t.due_date, 'YYYY-MM-DD') as due_date_str,
  m.id as meeting_id, m.title as meeting_title, m.occurred_at as meeting_occurred_at`;
const TASK_FROM = `from tasks t join meetings m on m.id = t.meeting_id left join people p on p.id = t.owner_person_id`;

function taskRef(r: Record<string, any>) {
  return {
    taskId: r.task_id as string,
    title: r.title as string,
    dueDate: r.due_date_str as string | null,
    status: r.status,
    ownerName: (r.owner_name as string | null) ?? null,
    meeting: { id: r.meeting_id as string, title: r.meeting_title as string, occurredAt: r.meeting_occurred_at.toISOString() as string },
    linearUrl: (r.external_url as string | null) ?? null,
  };
}

async function candidates(db: Queryable, windowHours: number, now: Date) {
  const { rows } = await db.query(
    `select ${TASK_COLUMNS}, r.id as reminder_id ${TASK_FROM}
       left join reminders r on r.task_id = t.id and r.due_date = t.due_date
     where t.status in ('approved', 'synced') and t.due_date is not null and t.due_date >= $1::date
     order by t.due_date, t.title, t.id`,
    [toDay(now)],
  );
  return rows
    .filter((r) => needsReminder({ status: r.status, dueDate: r.due_date_str }, now, windowHours))
    .map((r) => ({ row: r, existing: Boolean(r.reminder_id) }));
}

export async function previewReminders(db: Queryable, windowHours = DEFAULT_REMINDER_WINDOW_HOURS, now = new Date()): Promise<ReminderPreview> {
  const found = await candidates(db, windowHours, now);
  const items = found.map(({ row, existing }) => ({
    ...taskRef(row),
    remindAt: remindAt(row.due_date_str, windowHours).toISOString(),
    hoursUntilDue: hoursUntilDue(row.due_date_str, now),
    alreadyGenerated: existing,
  }));
  const already = items.filter((i) => i.alreadyGenerated).length;
  return { windowHours, asOf: now.toISOString(), delivery: DELIVERY, items, counts: { new: items.length - already, alreadyGenerated: already } };
}

/**
 * Creates in-app reminders for tasks inside the window. Idempotent: (task, due date) is unique in the database, so
 * repeated or concurrent runs create each reminder once. Does not deliver anything. The database also refuses a
 * reminder for a task that is not approved/synced, so a concurrent rejection or completion cannot slip through.
 */
export async function generateReminders(pool: Pool, windowHours = DEFAULT_REMINDER_WINDOW_HOURS, now = new Date()): Promise<GenerateRemindersResult> {
  const found = await candidates(pool, windowHours, now);
  let created = 0;
  for (const { row, existing } of found) {
    if (existing) continue;
    try {
      const res = await pool.query(
        `insert into reminders (task_id, due_date, remind_at, window_hours) values ($1, $2, $3, $4)
         on conflict (task_id, due_date) do nothing`,
        [row.task_id, row.due_date_str, remindAt(row.due_date_str, windowHours), windowHours],
      );
      created += res.rowCount ?? 0;
    } catch (err) {
      // The task changed state after it was read (e.g. completed); skip it rather than fail the whole run.
      if ((err as { code?: string }).code !== "23514") throw err;
    }
  }
  return { created, alreadyExisted: found.filter((f) => f.existing).length, windowHours, delivery: DELIVERY };
}

export async function listInbox(db: Queryable): Promise<ReminderInbox> {
  const { rows } = await db.query(
    `select ${TASK_COLUMNS}, r.id, r.remind_at, r.window_hours, r.created_at, r.read_at, r.sent_at
       from reminders r join tasks t on t.id = r.task_id join meetings m on m.id = t.meeting_id
       left join people p on p.id = t.owner_person_id
     order by (r.read_at is null) desc, r.due_date, r.created_at desc limit 200`,
  );
  const reminders: Reminder[] = rows.map((r) => ({
    ...taskRef(r),
    id: r.id,
    remindAt: r.remind_at.toISOString(),
    windowHours: r.window_hours,
    generatedAt: r.created_at.toISOString(),
    readAt: r.read_at?.toISOString() ?? null,
    deliveredAt: r.sent_at?.toISOString() ?? null,
    taskOpen: r.status === "approved" || r.status === "synced",
  }));
  return { delivery: DELIVERY, reminders, unread: reminders.filter((r) => !r.readAt && r.taskOpen).length };
}

export async function markReminderRead(db: Queryable, id: string): Promise<void> {
  const { rowCount } = await db.query(`update reminders set read_at = coalesce(read_at, now()) where id = $1`, [id]);
  if (!rowCount) throw new HttpError(404, "Reminder not found");
}

// ---------- digests ----------

async function digestTasks(db: Queryable, weekStart: string): Promise<DigestInput[]> {
  const { rows } = await db.query(
    `select ${TASK_COLUMNS} ${TASK_FROM}
     where (t.status in ('approved', 'synced') and t.due_date is not null)
        or (t.status = 'done' and t.completed_at >= $1::date and t.completed_at < $1::date + 7)`,
    [weekStart],
  );
  return rows.map((r) => ({ ...taskRef(r), ownerPersonId: r.owner_person_id, completedAt: r.completed_at?.toISOString() ?? null }));
}

export async function previewDigest(db: Queryable, now = new Date()): Promise<DigestPreview> {
  const today = toDay(now);
  const weekStart = weekStartOf(today);
  const owners = buildOwnerDigests(await digestTasks(db, weekStart), today, weekStart);
  const sum = (k: "overdue" | "upcoming" | "completed") => owners.reduce((n, o) => n + o[k].length, 0);
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    today,
    delivery: DELIVERY,
    owners,
    totals: { overdue: sum("overdue"), upcoming: sum("upcoming"), completed: sum("completed") },
  };
}

export async function listDigests(db: Queryable): Promise<StoredDigest[]> {
  const { rows } = await db.query(
    `select d.*, to_char(d.week_start, 'YYYY-MM-DD') as week_start_str, p.name as person_name
       from digests d join people p on p.id = d.person_id order by d.week_start desc, p.name limit 100`,
  );
  return rows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    ownerName: r.person_name,
    weekStart: r.week_start_str,
    content: r.content,
    generatedAt: r.updated_at.toISOString(),
    deliveredAt: r.sent_at?.toISOString() ?? null,
  }));
}

/** Stores this week's digest per known owner (one row per person per week; regenerating refreshes it). Not delivered. */
export async function generateDigests(pool: Pool, now = new Date()): Promise<GenerateDigestsResult> {
  const preview = await previewDigest(pool, now);
  const known = preview.owners.filter((o) => o.personId);
  await withTransaction(pool, async (client) => {
    for (const o of known) {
      const { personId, ownerName: _name, ...content } = o;
      await client.query(
        `insert into digests (person_id, week_start, content) values ($1, $2, $3)
         on conflict (person_id, week_start) do update set content = excluded.content, updated_at = now()
         where digests.sent_at is null`,
        [personId, preview.weekStart, JSON.stringify(content)],
      );
    }
  });
  const digests = (await listDigests(pool)).filter((d) => d.weekStart === preview.weekStart);
  return { stored: known.length, notStored: preview.owners.length - known.length, weekStart: preview.weekStart, digests, delivery: DELIVERY };
}
