import type { Pool, PoolClient } from "pg";
import type { Decision } from "@recall/shared";
import { HttpError } from "../meetings/errors.js";
import { assertVersion, lockMeeting, recordAudit, withTransaction } from "./common.js";
import { getDecision } from "./read.js";

export interface ActionOptions {
  actor: string;
  version?: number;
}

export interface DecisionEdit {
  summary?: string;
  rationale?: string | null;
  version: number;
}

export type DecisionRow = {
  id: string;
  meeting_id: string;
  status: string;
  version: number;
  summary: string;
  rationale: string | null;
};

/** Locks the decision row after its meeting (lock order: meeting → decisions → conflicts). */
export async function lockDecision(client: PoolClient, id: string): Promise<DecisionRow> {
  const pre = await client.query<{ meeting_id: string }>(`select meeting_id from decisions where id = $1`, [id]);
  if (!pre.rows[0]) throw new HttpError(404, "Decision not found");
  await lockMeeting(client, pre.rows[0].meeting_id);
  const { rows } = await client.query<DecisionRow>(`select * from decisions where id = $1 for update`, [id]);
  // Gone if a re-analysis replaced the draft while we waited for the lock.
  if (!rows[0]) throw new HttpError(404, "Decision not found");
  return rows[0];
}

/** Open conflicts of this decision, locked. Uncertain ones never block approval; clear ones do. */
export async function lockOpenConflicts(client: PoolClient, decisionId: string) {
  const { rows } = await client.query<{ id: string; certainty: "clear" | "uncertain" }>(
    `select id, certainty from decision_conflicts where decision_id = $1 and resolution = 'open' order by id for update`,
    [decisionId],
  );
  return rows;
}

/** Closes still-open conflicts of a decision that is leaving review; the reason is kept in the audit trail. */
export async function closeOpenConflicts(
  client: PoolClient,
  d: { id: string; meeting_id: string },
  conflictIds: string[],
  actor: string,
  reason: string,
): Promise<void> {
  if (conflictIds.length === 0) return;
  await client.query(
    `update decision_conflicts set resolution = 'dismissed', resolved_at = now(), resolved_by = $2
     where id = any($1::uuid[]) and resolution = 'open'`,
    [conflictIds, actor],
  );
  for (const id of conflictIds) {
    await recordAudit(client, {
      entityType: "conflict",
      entityId: id,
      meetingId: d.meeting_id,
      action: "dismissed",
      fromStatus: "open",
      toStatus: "dismissed",
      actor,
      details: { reason, decisionId: d.id },
    });
  }
}

export async function editDecision(pool: Pool, id: string, edit: DecisionEdit, actor: string): Promise<Decision> {
  await withTransaction(pool, async (client) => {
    const d = await lockDecision(client, id);
    if (d.status !== "proposed") throw new HttpError(409, `Only proposed decisions can be edited; this one is ${d.status}`);
    assertVersion(edit.version, d.version, "decision");

    const summary = edit.summary ?? d.summary;
    const rationale = edit.rationale === undefined ? d.rationale : edit.rationale;
    if (summary === d.summary && rationale === d.rationale) throw new HttpError(400, "Nothing to change");
    await client.query(`update decisions set summary = $2, rationale = $3, version = version + 1 where id = $1 and status = 'proposed'`, [
      id,
      summary,
      rationale,
    ]);
    await recordAudit(client, {
      entityType: "decision",
      entityId: id,
      meetingId: d.meeting_id,
      action: "edited",
      fromStatus: d.status,
      toStatus: d.status,
      actor,
      details: { before: { summary: d.summary, rationale: d.rationale }, after: { summary, rationale } },
    });
  });
  return getDecision(pool, id);
}

/**
 * proposed → active. Refused while a clear (confirmed) conflict is open: those must be resolved explicitly.
 * Possible (uncertain) conflicts do not block; approving closes them, and the audit trail says so.
 * Repeating the call on an already approved decision is a no-op.
 */
export async function approveDecision(pool: Pool, id: string, { actor, version }: ActionOptions): Promise<Decision> {
  await withTransaction(pool, async (client) => {
    const d = await lockDecision(client, id);
    if (d.status === "active") return;
    if (d.status !== "proposed") throw new HttpError(409, `Only proposed decisions can be approved; this one is ${d.status}`);
    assertVersion(version, d.version, "decision");

    const open = await lockOpenConflicts(client, id);
    const blocking = open.filter((c) => c.certainty === "clear");
    if (blocking.length > 0) {
      throw new HttpError(409, "This decision conflicts with an earlier approved decision. Resolve the conflict first.", {
        conflictIds: blocking.map((c) => c.id),
      });
    }
    await client.query(
      `update decisions set status = 'active', approved_at = now(), approved_by = $2, version = version + 1
       where id = $1 and status = 'proposed'`,
      [id, actor],
    );
    await closeOpenConflicts(client, d, open.map((c) => c.id), actor, "decision approved despite a possible conflict");
    await recordAudit(client, {
      entityType: "decision",
      entityId: id,
      meetingId: d.meeting_id,
      action: "approved",
      fromStatus: "proposed",
      toStatus: "active",
      actor,
      details: open.length ? { dismissedUncertainConflicts: open.map((c) => c.id) } : {},
    });
  });
  return getDecision(pool, id);
}

/** proposed → rejected. Only this row changes; no earlier decision is touched. Repeating is a no-op. */
export async function rejectDecision(pool: Pool, id: string, { actor, version }: ActionOptions): Promise<Decision> {
  await withTransaction(pool, async (client) => {
    const d = await lockDecision(client, id);
    if (d.status === "rejected") return;
    if (d.status !== "proposed") throw new HttpError(409, `Only proposed decisions can be rejected; this one is ${d.status}`);
    assertVersion(version, d.version, "decision");

    const open = await lockOpenConflicts(client, id);
    await client.query(
      `update decisions set status = 'rejected', rejected_at = now(), rejected_by = $2, version = version + 1
       where id = $1 and status = 'proposed'`,
      [id, actor],
    );
    await closeOpenConflicts(client, d, open.map((c) => c.id), actor, "decision rejected");
    await recordAudit(client, {
      entityType: "decision",
      entityId: id,
      meetingId: d.meeting_id,
      action: "rejected",
      fromStatus: "proposed",
      toStatus: "rejected",
      actor,
    });
  });
  return getDecision(pool, id);
}
