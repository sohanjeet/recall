import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { AUDIT_ENTITY_TYPES, CONFLICT_ACTIONS } from "@recall/shared";
import { listAudit } from "../approvals/common.js";
import { approveDecision, editDecision, rejectDecision } from "../approvals/decisions.js";
import type { LinearClient } from "../approvals/linear.js";
import { getDecision, getTask, listApprovals } from "../approvals/read.js";
import { resolveConflict } from "../approvals/resolve.js";
import { syncTask } from "../approvals/sync.js";
import { approveTask, editTask, rejectTask } from "../approvals/tasks.js";
import { HttpError } from "../meetings/errors.js";
import { isRealDate, IdParam } from "../meetings/validation.js";
import { actorOf } from "../security/auth.js";

export interface ApprovalsDeps {
  pool: Pool;
  /** null when LINEAR_API_KEY / LINEAR_TEAM_ID are not set. */
  linear: LinearClient | null;
}

/** Accepted from older clients and ignored: the audit actor is always the signed-in user. */
const actor = z.string().max(80).optional();
const version = z.number().int().positive();

const ActionBody = z.object({ actor, version: version.optional() }).strict();
const ResolveBody = z.object({ actor, action: z.enum(CONFLICT_ACTIONS) }).strict();
const EditDecisionBody = z
  .object({
    actor,
    version,
    summary: z.string().trim().min(1, "Summary is required").max(500).optional(),
    rationale: z.string().trim().max(2000).nullable().transform((v) => v || null).optional(),
  })
  .strict();
const EditTaskBody = z
  .object({
    actor,
    version,
    title: z.string().trim().min(1, "Title is required").max(300).optional(),
    description: z.string().trim().max(4000).nullable().transform((v) => v || null).optional(),
    ownerName: z.string().trim().max(100).nullable().transform((v) => v || null).optional(),
    dueDate: z.string().refine(isRealDate, "Must be a valid date (YYYY-MM-DD)").nullable().optional(),
  })
  .strict();
const AuditQuery = z.object({ entityType: z.enum(AUDIT_ENTITY_TYPES), entityId: IdParam });

function parse<T extends z.ZodType>(schema: T, input: unknown, what: string): z.output<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw new HttpError(400, `Invalid ${what}`, r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

const idOf = (raw: unknown, what: string) => {
  const id = IdParam.safeParse(raw);
  if (!id.success) throw new HttpError(400, `Invalid ${what} id`);
  return id.data;
};

export function approvalsRouter({ pool, linear }: ApprovalsDeps) {
  const router = Router();

  router.get("/approvals", async (_req, res) => {
    res.json(await listApprovals(pool, linear !== null));
  });

  router.get("/audit", async (req, res) => {
    const q = parse(AuditQuery, req.query, "query");
    res.json(await listAudit(pool, q.entityType, q.entityId));
  });

  // ---- decisions ----
  router.patch("/decisions/:id", async (req, res) => {
    const { actor: _ignored, ...edit } = parse(EditDecisionBody, req.body, "decision edit");
    res.json(await editDecision(pool, idOf(req.params.id, "decision"), edit, actorOf(res)));
  });
  router.post("/decisions/:id/approve", async (req, res) => {
    const { version } = parse(ActionBody, req.body, "request");
    res.json(await approveDecision(pool, idOf(req.params.id, "decision"), { actor: actorOf(res), version }));
  });
  router.post("/decisions/:id/reject", async (req, res) => {
    const { version } = parse(ActionBody, req.body, "request");
    res.json(await rejectDecision(pool, idOf(req.params.id, "decision"), { actor: actorOf(res), version }));
  });

  // ---- conflicts ----
  router.post("/conflicts/:id/resolve", async (req, res) => {
    const body = parse(ResolveBody, req.body, "request");
    res.json(await resolveConflict(pool, idOf(req.params.id, "conflict"), body.action, actorOf(res)));
  });

  // ---- tasks ----
  router.patch("/tasks/:id", async (req, res) => {
    const { actor: _ignored, ...edit } = parse(EditTaskBody, req.body, "task edit");
    res.json(await editTask(pool, idOf(req.params.id, "task"), edit, actorOf(res)));
  });
  router.post("/tasks/:id/reject", async (req, res) => {
    const { version } = parse(ActionBody, req.body, "request");
    res.json(await rejectTask(pool, idOf(req.params.id, "task"), { actor: actorOf(res), version }));
  });

  // Approving is the explicit consent to create the Linear issue, so it is followed by one sync attempt.
  // A failed attempt does not undo the approval; the failure is stored on the task and can be retried.
  router.post("/tasks/:id/approve", async (req, res) => {
    const id = idOf(req.params.id, "task");
    const { version } = parse(ActionBody, req.body, "request");
    const actor = actorOf(res);
    await approveTask(pool, id, { actor, version });
    if (linear) {
      try {
        await syncTask(pool, linear, id, actor);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
      }
    }
    res.json(await getTask(pool, id));
  });

  // Manual (re)try for an approved task: first send when Linear was not configured at approval, or retry after a failure.
  router.post("/tasks/:id/sync", async (req, res) => {
    parse(ActionBody, req.body, "request");
    res.json(await syncTask(pool, linear, idOf(req.params.id, "task"), actorOf(res)));
  });

  router.get("/decisions/:id", async (req, res) => {
    res.json(await getDecision(pool, idOf(req.params.id, "decision")));
  });

  return router;
}
