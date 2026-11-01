import type { Pool } from "pg";
import type { ConflictAction, ConflictResolution } from "@recall/shared";
import { HttpError } from "../meetings/errors.js";
import { lockMeeting, recordAudit, withTransaction } from "./common.js";
import { closeOpenConflicts } from "./decisions.js";

const RESOLUTION_FOR: Record<ConflictAction, Exclude<ConflictResolution, "open">> = {
  keep_old: "kept_old",
  accept_new: "kept_new",
  dismiss: "dismissed",
};

interface ConflictRow {
  id: string;
  meeting_id: string;
  decision_id: string;
  conflicting_decision_id: string;
  certainty: "clear" | "uncertain";
  resolution: ConflictResolution;
}

/**
 * Resolves a conflict between a proposed (new) decision and an earlier active one, in one transaction:
 *  - keep_old:   the earlier decision is untouched; the new draft is rejected.
 *  - accept_new: the earlier decision becomes `superseded` (pointing at the new one) and the new one `active`.
 *  - dismiss:    only for uncertain conflicts; nothing about either decision changes.
 * Locks are taken meeting → decisions (by id) → conflict, matching approve/reject, so concurrent actions serialise.
 * Repeating an action that was already applied is a no-op; a different action on a resolved conflict is a 409.
 */
export async function resolveConflict(pool: Pool, conflictId: string, action: ConflictAction, actor: string) {
  const pre = await pool.query<ConflictRow>(`select * from decision_conflicts where id = $1`, [conflictId]);
  const known = pre.rows[0];
  if (!known) throw new HttpError(404, "Conflict not found");

  await withTransaction(pool, async (client) => {
    await lockMeeting(client, known.meeting_id);
    const decisions = await client.query<{ id: string; status: string; version: number; meeting_id: string }>(
      `select id, status, version, meeting_id from decisions where id = any($1::uuid[]) order by id for update`,
      [[known.decision_id, known.conflicting_decision_id]],
    );
    const c = (await client.query<ConflictRow>(`select * from decision_conflicts where id = $1 for update`, [conflictId])).rows[0];
    if (!c) throw new HttpError(404, "Conflict not found");

    if (c.resolution !== "open") {
      if (c.resolution === RESOLUTION_FOR[action]) return;
      throw new HttpError(409, `This conflict was already resolved (${c.resolution.replace("_", " ")})`);
    }

    const next = decisions.rows.find((d) => d.id === c.decision_id);
    const earlier = decisions.rows.find((d) => d.id === c.conflicting_decision_id);
    if (!next || !earlier) throw new HttpError(404, "Decision not found");
    if (next.status !== "proposed") {
      throw new HttpError(409, `The new decision is already ${next.status}; this conflict can no longer be resolved`);
    }
    if (action === "dismiss" && c.certainty !== "uncertain") {
      throw new HttpError(409, "Only possible (uncertain) conflicts can be dismissed. Keep the old decision or accept the new one.");
    }

    const siblings = (
      await client.query<{ id: string; certainty: "clear" | "uncertain" }>(
        `select id, certainty from decision_conflicts where decision_id = $1 and resolution = 'open' and id <> $2 order by id for update`,
        [c.decision_id, c.id],
      )
    ).rows;

    if (action === "accept_new") {
      if (earlier.status !== "active") {
        throw new HttpError(409, `The earlier decision is ${earlier.status}, not active, so it cannot be superseded`);
      }
      const otherClear = siblings.filter((s) => s.certainty === "clear");
      if (otherClear.length > 0) {
        throw new HttpError(409, "This decision has other unresolved conflicts. Resolve those first.", {
          conflictIds: otherClear.map((s) => s.id),
        });
      }
      await client.query(
        `update decisions set status = 'superseded', superseded_by = $2, version = version + 1 where id = $1 and status = 'active'`,
        [earlier.id, next.id],
      );
      await client.query(
        `update decisions set status = 'active', approved_at = now(), approved_by = $2, version = version + 1
         where id = $1 and status = 'proposed'`,
        [next.id, actor],
      );
      await recordAudit(client, {
        entityType: "decision",
        entityId: earlier.id,
        meetingId: earlier.meeting_id,
        action: "superseded",
        fromStatus: "active",
        toStatus: "superseded",
        actor,
        details: { supersededBy: next.id, conflictId: c.id },
      });
      await recordAudit(client, {
        entityType: "decision",
        entityId: next.id,
        meetingId: next.meeting_id,
        action: "approved",
        fromStatus: "proposed",
        toStatus: "active",
        actor,
        details: { supersedes: earlier.id, conflictId: c.id },
      });
      await closeOpenConflicts(client, next, siblings.map((s) => s.id), actor, "new decision accepted despite a possible conflict");
    } else if (action === "keep_old") {
      await client.query(
        `update decisions set status = 'rejected', rejected_at = now(), rejected_by = $2, version = version + 1
         where id = $1 and status = 'proposed'`,
        [next.id, actor],
      );
      await recordAudit(client, {
        entityType: "decision",
        entityId: next.id,
        meetingId: next.meeting_id,
        action: "rejected",
        fromStatus: "proposed",
        toStatus: "rejected",
        actor,
        details: { reason: "earlier decision kept", keptDecision: earlier.id, conflictId: c.id },
      });
      await closeOpenConflicts(client, next, siblings.map((s) => s.id), actor, "decision rejected");
    }

    await client.query(
      `update decision_conflicts set resolution = $2, resolved_at = now(), resolved_by = $3 where id = $1 and resolution = 'open'`,
      [c.id, RESOLUTION_FOR[action], actor],
    );
    await recordAudit(client, {
      entityType: "conflict",
      entityId: c.id,
      meetingId: c.meeting_id,
      action,
      fromStatus: "open",
      toStatus: RESOLUTION_FOR[action],
      actor,
      details: { newDecisionId: next.id, earlierDecisionId: earlier.id },
    });
  });

  const resolved = (await pool.query<{ resolution: ConflictResolution }>(`select resolution from decision_conflicts where id = $1`, [conflictId])).rows[0];
  return { id: conflictId, resolution: resolved?.resolution ?? RESOLUTION_FOR[action] };
}
