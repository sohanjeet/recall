import type { Pool, PoolClient } from "pg";
import type { AuditEntityType, AuditEvent } from "@recall/shared";
import { HttpError } from "../meetings/errors.js";
import type { Queryable } from "../meetings/service.js";

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Takes a shared lock on the meeting and checks its drafts are settled. Re-analysis and conflict checks take the
 * exclusive lock, so approvals cannot interleave with them. Always the first lock taken, to keep lock order fixed
 * (meeting → decisions by id → conflicts).
 */
export async function lockMeeting(client: PoolClient, meetingId: string): Promise<void> {
  const { rows } = await client.query<{ status: string }>(`select status from meetings where id = $1 for share`, [meetingId]);
  if (!rows[0]) throw new HttpError(404, "Meeting not found");
  if (rows[0].status !== "extracted") {
    throw new HttpError(409, `The meeting is ${rows[0].status}; wait for analysis to finish before reviewing its drafts`);
  }
}

export function assertVersion(expected: number | undefined, actual: number, what: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new HttpError(409, `This ${what} was changed by someone else; reload and try again`);
  }
}

export interface AuditInput {
  entityType: AuditEntityType;
  entityId: string;
  meetingId: string | null;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actor: string;
  details?: Record<string, unknown>;
}

/** Appends to the immutable audit history; call inside the same transaction as the change it describes. */
export async function recordAudit(db: Queryable, e: AuditInput): Promise<void> {
  await db.query(
    `insert into audit_events (entity_type, entity_id, meeting_id, action, from_status, to_status, actor, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.entityType, e.entityId, e.meetingId, e.action, e.fromStatus ?? null, e.toStatus ?? null, e.actor, JSON.stringify(e.details ?? {})],
  );
}

export async function listAudit(db: Queryable, entityType: AuditEntityType, entityId: string): Promise<AuditEvent[]> {
  const { rows } = await db.query(`select * from audit_events where entity_type = $1 and entity_id = $2 order by id`, [
    entityType,
    entityId,
  ]);
  return rows.map((r) => ({
    id: String(r.id),
    entityType: r.entity_type,
    entityId: r.entity_id,
    meetingId: r.meeting_id,
    action: r.action,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    actor: r.actor,
    details: r.details,
    createdAt: r.created_at.toISOString(),
  }));
}
