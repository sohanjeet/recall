import { Router } from "express";
import type { Pool } from "pg";
import { checkConflicts, getMeetingConflicts, type ConflictClassifier } from "../meetings/conflicts.js";
import { HttpError } from "../meetings/errors.js";
import { analyzeMeeting, createMeeting, getMeeting, listMeetings, type Extractor } from "../meetings/service.js";
import { CreateMeetingBody, IdParam } from "../meetings/validation.js";

export interface MeetingsDeps {
  pool: Pool;
  extract: Extractor;
  classifyConflicts: ConflictClassifier;
}

function parseId(raw: unknown): string {
  const id = IdParam.safeParse(raw);
  if (!id.success) throw new HttpError(400, "Invalid meeting id");
  return id.data;
}

export function meetingsRouter({ pool, extract, classifyConflicts }: MeetingsDeps) {
  const router = Router();

  router.get("/", async (_req, res) => {
    res.json(await listMeetings(pool));
  });

  router.get("/:id", async (req, res) => {
    const meeting = await getMeeting(pool, parseId(req.params.id));
    if (!meeting) throw new HttpError(404, "Meeting not found");
    res.json(meeting);
  });

  router.post("/", async (req, res) => {
    const body = CreateMeetingBody.safeParse(req.body);
    if (!body.success) {
      throw new HttpError(400, "Invalid meeting", body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    const client = await pool.connect();
    let id: string;
    try {
      await client.query("begin");
      id = await createMeeting(client, body.data);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json(await getMeeting(pool, id));
  });

  router.post("/:id/analyze", async (req, res) => {
    res.json(await analyzeMeeting(pool, parseId(req.params.id), extract, classifyConflicts));
  });

  router.get("/:id/conflicts", async (req, res) => {
    const conflicts = await getMeetingConflicts(pool, parseId(req.params.id));
    if (!conflicts) throw new HttpError(404, "Meeting not found");
    res.json(conflicts);
  });

  // Re-runs only the conflict check (e.g. after a failed AI call); returns the updated meeting.
  router.post("/:id/conflicts/check", async (req, res) => {
    const id = parseId(req.params.id);
    await checkConflicts(pool, id, classifyConflicts);
    res.json(await getMeeting(pool, id));
  });

  return router;
}
