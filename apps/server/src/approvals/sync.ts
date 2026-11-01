import type { Pool } from "pg";
import type { Task } from "@recall/shared";
import { HttpError } from "../meetings/errors.js";
import { recordAudit } from "./common.js";
import { LinearError, type LinearClient, type LinearIssue } from "./linear.js";
import { getTask } from "./read.js";

/** A claim older than this is treated as abandoned (a crashed process); the Linear call itself times out at 15s. */
const STALE_CLAIM_SECONDS = 90;

export const taskMarker = (taskId: string) => `recall-task:${taskId}`;

interface ClaimedTask {
  id: string;
  meeting_id: string;
  title: string;
  description: string | null;
  owner_name: string | null;
  due_date_str: string | null;
  due_phrase: string | null;
  sync_attempts: number;
  meeting_title: string;
  meeting_date: string;
}

function issueDescription(t: ClaimedTask, quotes: string[]): string {
  const lines: string[] = [];
  if (t.description) lines.push(t.description, "");
  if (t.owner_name) lines.push(`**Owner (from meeting):** ${t.owner_name}`);
  if (t.due_date_str) lines.push(`**Due:** ${t.due_date_str}${t.due_phrase ? ` (“${t.due_phrase}”)` : ""}`);
  else if (t.due_phrase) lines.push(`**Due (unresolved):** “${t.due_phrase}”`);
  lines.push(`**Source:** ${t.meeting_title} (${t.meeting_date})`);
  for (const q of quotes) lines.push(`> ${q}`);
  // Lets an interrupted attempt be recognised on retry, so a retry never creates a second issue.
  lines.push("", `_Created by Recall · ${taskMarker(t.id)}_`);
  return lines.join("\n");
}

/**
 * Pushes one approved task to Linear, at most once.
 *  - Only `approved` tasks without an external id are claimed; the claim is a single atomic UPDATE, so concurrent
 *    requests cannot both create an issue. A `syncing` claim is only retaken once it is stale.
 *  - After any earlier attempt, Linear is searched for the task's marker first and an existing issue is adopted.
 *  - Success stores the Linear id and URL; failure stores the real error and leaves the task approved for retry.
 * Already synced tasks are returned as-is. With no Linear configuration nothing is attempted or recorded.
 */
export async function syncTask(pool: Pool, linear: LinearClient | null, taskId: string, actor: string): Promise<Task> {
  if (!linear) {
    throw new HttpError(503, "Linear is not configured on the server (set LINEAR_API_KEY and LINEAR_TEAM_ID)");
  }

  const claimed = (
    await pool.query<ClaimedTask>(
      `with c as (
         update tasks set sync_status = 'syncing', sync_attempts = sync_attempts + 1, sync_attempted_at = now(), sync_error = null
         where id = $1 and status = 'approved' and approved_at is not null and external_id is null
           and (sync_status is null or sync_status = 'failed'
                or sync_attempted_at < now() - make_interval(secs => $2))
         returning *
       )
       select c.id, c.meeting_id, c.title, c.description, c.owner_name, c.due_phrase, c.sync_attempts,
              to_char(c.due_date, 'YYYY-MM-DD') as due_date_str,
              m.title as meeting_title, to_char(m.occurred_at at time zone 'UTC', 'YYYY-MM-DD') as meeting_date
       from c join meetings m on m.id = c.meeting_id`,
      [taskId, STALE_CLAIM_SECONDS],
    )
  ).rows[0];

  if (!claimed) {
    const task = await getTask(pool, taskId); // 404 if missing
    if (task.status === "synced") return task;
    if (task.status !== "approved") {
      throw new HttpError(409, `Only approved tasks can be sent to Linear; this one is ${task.status}`);
    }
    throw new HttpError(409, "A sync for this task is already in progress");
  }

  await recordAudit(pool, {
    entityType: "task",
    entityId: claimed.id,
    meetingId: claimed.meeting_id,
    action: "sync_started",
    fromStatus: "approved",
    toStatus: "approved",
    actor,
    details: { attempt: claimed.sync_attempts },
  });

  let issue: LinearIssue;
  let adopted = false;
  try {
    const existing = claimed.sync_attempts > 1 ? await linear.findIssueByMarker(taskMarker(claimed.id)) : null;
    if (existing) {
      issue = existing;
      adopted = true;
    } else {
      const quotes = (
        await pool.query<{ quote: string }>(`select quote from evidence where task_id = $1 order by id limit 3`, [claimed.id])
      ).rows.map((r) => r.quote);
      issue = await linear.createIssue({
        title: claimed.title,
        description: issueDescription(claimed, quotes),
        dueDate: claimed.due_date_str,
      });
    }
  } catch (err) {
    const message = err instanceof LinearError ? err.message : "Unexpected error while contacting Linear";
    if (!(err instanceof LinearError)) console.error("Linear sync error:", err);
    await pool.query(`update tasks set sync_status = 'failed', sync_error = $2 where id = $1 and sync_status = 'syncing'`, [
      claimed.id,
      message,
    ]);
    await recordAudit(pool, {
      entityType: "task",
      entityId: claimed.id,
      meetingId: claimed.meeting_id,
      action: "sync_failed",
      fromStatus: "approved",
      toStatus: "approved",
      actor,
      details: { attempt: claimed.sync_attempts, error: message },
    });
    throw new HttpError(502, `Linear sync failed: ${message}`);
  }

  // The issue exists in Linear now. If saving fails the task stays 'syncing'; the next retry finds the issue by its
  // marker and adopts it instead of creating another.
  const client = await pool.connect();
  try {
    await client.query("begin");
    const saved = await client.query(
      `update tasks set status = 'synced', external_provider = 'linear', external_id = $2, external_url = $3,
         sync_status = null, sync_error = null, version = version + 1
       where id = $1 and status = 'approved' and sync_status = 'syncing' and external_id is null`,
      [claimed.id, issue.id, issue.url],
    );
    if (saved.rowCount !== 1) throw new HttpError(409, "The task changed while it was being sent to Linear");
    await recordAudit(client, {
      entityType: "task",
      entityId: claimed.id,
      meetingId: claimed.meeting_id,
      action: "synced",
      fromStatus: "approved",
      toStatus: "synced",
      actor,
      details: { provider: "linear", externalId: issue.id, identifier: issue.identifier, url: issue.url, adoptedExisting: adopted },
    });
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return getTask(pool, claimed.id);
}
