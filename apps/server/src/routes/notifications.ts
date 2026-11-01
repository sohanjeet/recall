import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { DEFAULT_REMINDER_WINDOW_HOURS, MAX_REMINDER_WINDOW_HOURS } from "@recall/shared";
import { getTask } from "../approvals/read.js";
import { completeTask } from "../approvals/tasks.js";
import { HttpError } from "../meetings/errors.js";
import { IdParam } from "../meetings/validation.js";
import { actorOf } from "../security/auth.js";
import {
  generateDigests,
  generateReminders,
  listDigests,
  listInbox,
  markReminderRead,
  previewDigest,
  previewReminders,
} from "../notifications/service.js";

const WindowInput = z.object({
  windowHours: z.coerce.number().int().min(1).max(MAX_REMINDER_WINDOW_HOURS).default(DEFAULT_REMINDER_WINDOW_HOURS),
});
/** `actor` is accepted from older clients and ignored: the audit actor is always the signed-in user. */
const CompleteBody = z.object({ actor: z.string().max(80).optional() }).strict();

const idOf = (raw: unknown, what: string) => {
  const id = IdParam.safeParse(raw);
  if (!id.success) throw new HttpError(400, `Invalid ${what} id`);
  return id.data;
};

function parseWindow(input: unknown): number {
  const r = WindowInput.safeParse(input ?? {});
  if (!r.success) throw new HttpError(400, `windowHours must be a whole number from 1 to ${MAX_REMINDER_WINDOW_HOURS}`);
  return r.data.windowHours;
}

/**
 * Reminders and weekly digests are in-app only. There is deliberately no endpoint that sends anything externally.
 * Generation is always an explicit POST; GET endpoints never write.
 */
export function notificationsRouter({ pool }: { pool: Pool }) {
  const router = Router();

  router.get("/reminders", async (_req, res) => {
    res.json(await listInbox(pool));
  });
  router.get("/reminders/preview", async (req, res) => {
    res.json(await previewReminders(pool, parseWindow(req.query)));
  });
  router.post("/reminders/generate", async (req, res) => {
    res.json(await generateReminders(pool, parseWindow(req.body)));
  });
  router.post("/reminders/:id/read", async (req, res) => {
    await markReminderRead(pool, idOf(req.params.id, "reminder"));
    res.json(await listInbox(pool));
  });

  router.get("/digests", async (_req, res) => {
    res.json(await listDigests(pool));
  });
  router.get("/digests/preview", async (_req, res) => {
    res.json(await previewDigest(pool));
  });
  router.post("/digests/generate", async (_req, res) => {
    res.json(await generateDigests(pool));
  });

  router.post("/tasks/:id/complete", async (req, res) => {
    const body = CompleteBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, "Invalid request");
    const id = idOf(req.params.id, "task");
    await completeTask(pool, id, actorOf(res));
    res.json(await getTask(pool, id));
  });

  return router;
}
