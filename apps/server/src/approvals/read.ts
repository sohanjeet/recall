import type { ApprovalDecision, ApprovalsResponse, ApprovalTask, Decision, Evidence, Task } from "@recall/shared";
import { listOpenConflicts } from "../meetings/conflicts.js";
import { HttpError } from "../meetings/errors.js";
import { mapDecision, mapTask, type Queryable } from "../meetings/service.js";

const TASK_SELECT = `select t.*, to_char(t.due_date, 'YYYY-MM-DD') as due_date_str, p.name as person_name, m.title as meeting_title
  from tasks t join meetings m on m.id = t.meeting_id left join people p on p.id = t.owner_person_id`;

async function evidenceIndex(db: Queryable, decisionIds: string[], taskIds: string[]) {
  const { rows } = await db.query(
    `select * from evidence where decision_id = any($1::uuid[]) or task_id = any($2::uuid[]) order by id`,
    [decisionIds, taskIds],
  );
  return (key: "decision_id" | "task_id", id: string): Evidence[] =>
    rows.filter((e) => e[key] === id).map((e) => ({ id: e.id, segmentId: e.segment_id, quote: e.quote }));
}

export async function getDecision(db: Queryable, id: string): Promise<Decision> {
  const d = (await db.query(`select * from decisions where id = $1`, [id])).rows[0];
  if (!d) throw new HttpError(404, "Decision not found");
  return mapDecision(d, (await evidenceIndex(db, [id], []))("decision_id", id));
}

export async function getTask(db: Queryable, id: string): Promise<Task> {
  const t = (await db.query(`${TASK_SELECT} where t.id = $1`, [id])).rows[0];
  if (!t) throw new HttpError(404, "Task not found");
  return mapTask(t, (await evidenceIndex(db, [], [id]))("task_id", id));
}

export async function listApprovals(db: Queryable, linearConfigured: boolean): Promise<ApprovalsResponse> {
  const [decs, proposedTasks, syncTasks, conflicts] = await Promise.all([
    db.query(
      `select d.*, m.title as meeting_title from decisions d join meetings m on m.id = d.meeting_id
       where d.status = 'proposed' and m.status = 'extracted' order by m.occurred_at desc, d.created_at, d.id`,
    ),
    db.query(`${TASK_SELECT} where t.status = 'proposed' and m.status = 'extracted' order by m.occurred_at desc, t.created_at, t.id`),
    db.query(
      `(${TASK_SELECT} where t.status = 'approved' order by t.approved_at, t.id)
       union all
       (${TASK_SELECT} where t.status = 'synced' order by t.approved_at desc, t.id limit 10)`,
    ),
    listOpenConflicts(db),
  ]);

  const evidence = await evidenceIndex(
    db,
    decs.rows.map((d) => d.id),
    [...proposedTasks.rows, ...syncTasks.rows].map((t) => t.id),
  );

  const decisions: ApprovalDecision[] = decs.rows.map((d) => ({
    ...mapDecision(d, evidence("decision_id", d.id)),
    meetingTitle: d.meeting_title,
    openConflicts: conflicts.filter((c) => c.decisionId === d.id).map((c) => ({ id: c.id, certainty: c.certainty })),
  }));
  const toApprovalTask = (t: Record<string, any>): ApprovalTask => ({
    ...mapTask(t, evidence("task_id", t.id)),
    meetingTitle: t.meeting_title,
  });

  return {
    linearConfigured,
    decisions,
    tasks: proposedTasks.rows.map(toApprovalTask),
    conflicts,
    sync: syncTasks.rows.map(toApprovalTask),
  };
}
