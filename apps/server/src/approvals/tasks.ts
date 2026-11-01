import type { Pool, PoolClient } from "pg";
import type { Task } from "@recall/shared";
import { HttpError } from "../meetings/errors.js";
import { assertVersion, lockMeeting, recordAudit, withTransaction } from "./common.js";
import type { ActionOptions } from "./decisions.js";
import { getTask } from "./read.js";

export interface TaskEdit {
  title?: string;
  description?: string | null;
  ownerName?: string | null;
  dueDate?: string | null;
  version: number;
}

type TaskRow = {
  id: string;
  meeting_id: string;
  status: string;
  version: number;
  title: string;
  description: string | null;
  owner_name: string | null;
  due_date_str: string | null;
};

async function lockTask(client: PoolClient, id: string): Promise<TaskRow> {
  const pre = await client.query<{ meeting_id: string }>(`select meeting_id from tasks where id = $1`, [id]);
  if (!pre.rows[0]) throw new HttpError(404, "Task not found");
  await lockMeeting(client, pre.rows[0].meeting_id);
  const { rows } = await client.query<TaskRow>(
    `select *, to_char(due_date, 'YYYY-MM-DD') as due_date_str from tasks where id = $1 for update`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, "Task not found");
  return rows[0];
}

export async function editTask(pool: Pool, id: string, edit: TaskEdit, actor: string): Promise<Task> {
  await withTransaction(pool, async (client) => {
    const t = await lockTask(client, id);
    if (t.status !== "proposed") throw new HttpError(409, `Only proposed tasks can be edited; this one is ${t.status}`);
    assertVersion(edit.version, t.version, "task");

    const next = {
      title: edit.title ?? t.title,
      description: edit.description === undefined ? t.description : edit.description,
      ownerName: edit.ownerName === undefined ? t.owner_name : edit.ownerName,
      dueDate: edit.dueDate === undefined ? t.due_date_str : edit.dueDate,
    };
    const before = { title: t.title, description: t.description, ownerName: t.owner_name, dueDate: t.due_date_str };
    if (JSON.stringify(next) === JSON.stringify(before)) throw new HttpError(400, "Nothing to change");

    await client.query(
      `update tasks set title = $2, description = $3, owner_name = $4, due_date = $5,
         owner_person_id = (select id from people where lower(name) = lower($4)), version = version + 1
       where id = $1 and status = 'proposed'`,
      [id, next.title, next.description, next.ownerName, next.dueDate],
    );
    await recordAudit(client, {
      entityType: "task",
      entityId: id,
      meetingId: t.meeting_id,
      action: "edited",
      fromStatus: t.status,
      toStatus: t.status,
      actor,
      details: { before, after: next },
    });
  });
  return getTask(pool, id);
}

/**
 * proposed → approved, recording who and when. This is the only gate to Linear: sync refuses unapproved tasks.
 * Repeating the call on an approved (or already synced) task is a no-op.
 */
export async function approveTask(pool: Pool, id: string, { actor, version }: ActionOptions): Promise<Task> {
  await withTransaction(pool, async (client) => {
    const t = await lockTask(client, id);
    if (t.status === "approved" || t.status === "synced") return;
    if (t.status !== "proposed") throw new HttpError(409, `Only proposed tasks can be approved; this one is ${t.status}`);
    assertVersion(version, t.version, "task");

    await client.query(
      `update tasks set status = 'approved', approved_at = now(), approved_by = $2, version = version + 1
       where id = $1 and status = 'proposed'`,
      [id, actor],
    );
    await recordAudit(client, {
      entityType: "task",
      entityId: id,
      meetingId: t.meeting_id,
      action: "approved",
      fromStatus: "proposed",
      toStatus: "approved",
      actor,
    });
  });
  return getTask(pool, id);
}

/** proposed → rejected. Repeating is a no-op; an approved task can no longer be rejected here. */
export async function rejectTask(pool: Pool, id: string, { actor, version }: ActionOptions): Promise<Task> {
  await withTransaction(pool, async (client) => {
    const t = await lockTask(client, id);
    if (t.status === "rejected") return;
    if (t.status !== "proposed") throw new HttpError(409, `Only proposed tasks can be rejected; this one is ${t.status}`);
    assertVersion(version, t.version, "task");

    await client.query(
      `update tasks set status = 'rejected', rejected_at = now(), rejected_by = $2, version = version + 1
       where id = $1 and status = 'proposed'`,
      [id, actor],
    );
    await recordAudit(client, {
      entityType: "task",
      entityId: id,
      meetingId: t.meeting_id,
      action: "rejected",
      fromStatus: "proposed",
      toStatus: "rejected",
      actor,
    });
  });
  return getTask(pool, id);
}

/**
 * approved | synced → done, recording when. Completed tasks stop producing reminders and appear in the weekly digest.
 * Repeating is a no-op. Refused while a Linear sync is in flight so the sync's own status update cannot be lost.
 */
export async function completeTask(pool: Pool, id: string, actor: string): Promise<Task> {
  await withTransaction(pool, async (client) => {
    const t = await lockTask(client, id);
    if (t.status === "done") return;
    if (t.status !== "approved" && t.status !== "synced") throw new HttpError(409, `Only approved tasks can be completed; this one is ${t.status}`);
    const { rows } = await client.query<{ sync_status: string | null }>(`select sync_status from tasks where id = $1`, [id]);
    if (rows[0]?.sync_status === "syncing") throw new HttpError(409, "A Linear sync is in progress; try again in a moment");

    await client.query(`update tasks set status = 'done', completed_at = now(), version = version + 1 where id = $1`, [id]);
    await recordAudit(client, {
      entityType: "task",
      entityId: id,
      meetingId: t.meeting_id,
      action: "completed",
      fromStatus: t.status,
      toStatus: "done",
      actor,
    });
  });
  return getTask(pool, id);
}
