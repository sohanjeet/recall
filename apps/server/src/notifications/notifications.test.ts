import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import type { TaskRef } from "@recall/shared";
import { createApp } from "../app.js";
import { completeTask } from "../approvals/tasks.js";
import { pingDatabase, pool } from "../db.js";
import { authHeaders, testAuthDeps } from "../security/testing.js";
import { buildOwnerDigests, type DigestInput, hoursUntilDue, needsReminder, remindAt, weekStartOf } from "./logic.js";
import { generateDigests, generateReminders, listDigests, listInbox, previewDigest, previewReminders } from "./service.js";

// ---------- pure logic ----------

describe("reminder windows and due dates", () => {
  const now = new Date("2026-11-04T12:00:00Z");

  test("default 24h window: a task due tomorrow is reminded from the start of today; one due in 3 days is not", () => {
    assert.equal(remindAt("2026-11-05", 24).toISOString(), "2026-11-04T00:00:00.000Z");
    assert.equal(needsReminder({ status: "approved", dueDate: "2026-11-05" }, now, 24), true);
    assert.equal(needsReminder({ status: "approved", dueDate: "2026-11-07" }, now, 24), false);
  });

  test("a wider window pulls reminders in earlier; the boundary is inclusive", () => {
    assert.equal(needsReminder({ status: "approved", dueDate: "2026-11-08" }, now, 72), false); // opens Nov 5 00:00
    assert.equal(needsReminder({ status: "approved", dueDate: "2026-11-08" }, now, 96), true); // opens Nov 4 00:00
    assert.equal(needsReminder({ status: "approved", dueDate: "2026-11-05" }, new Date("2026-11-04T00:00:00Z"), 24), true);
    assert.equal(needsReminder({ status: "approved", dueDate: "2026-11-05" }, new Date("2026-11-03T23:59:59Z"), 24), false);
  });

  test("due today is still reminded; past-due tasks are not (they are overdue in the digest); no due date means no reminder", () => {
    assert.equal(needsReminder({ status: "approved", dueDate: "2026-11-04" }, now, 24), true);
    assert.equal(needsReminder({ status: "approved", dueDate: "2026-11-03" }, now, 24), false);
    assert.equal(needsReminder({ status: "approved", dueDate: null }, now, 24), false);
  });

  test("only approved or synced tasks are reminded", () => {
    for (const status of ["proposed", "rejected", "done", "superseded", "anything-else"]) {
      assert.equal(needsReminder({ status, dueDate: "2026-11-05" }, now, 24), false, status);
    }
    assert.equal(needsReminder({ status: "synced", dueDate: "2026-11-05" }, now, 24), true);
  });

  test("hours until due is counted from the due date's 00:00 UTC deadline", () => {
    assert.equal(hoursUntilDue("2026-11-05", now), 12);
  });

  test("weeks start on Monday", () => {
    assert.equal(weekStartOf("2026-11-04"), "2026-11-02"); // Wednesday
    assert.equal(weekStartOf("2026-11-02"), "2026-11-02");
    assert.equal(weekStartOf("2026-11-08"), "2026-11-02"); // Sunday
  });
});

describe("weekly digest grouping", () => {
  const meeting = { id: "m1", title: "Kickoff", occurredAt: "2026-10-30T00:00:00.000Z" };
  const task = (over: Partial<DigestInput> & { title: string }): DigestInput => ({
    taskId: over.title,
    dueDate: null,
    status: "approved",
    ownerName: "Ana",
    ownerPersonId: "p-ana",
    meeting,
    linearUrl: null,
    completedAt: null,
    ...over,
  });
  const today = "2026-11-04";
  const weekStart = "2026-11-02";

  test("groups by owner into overdue, upcoming and completed, sorted by due date", () => {
    const owners = buildOwnerDigests(
      [
        task({ title: "late B", dueDate: "2026-11-02" }),
        task({ title: "late A", dueDate: "2026-11-01" }),
        task({ title: "soon", dueDate: "2026-11-06", linearUrl: "https://linear.app/t/issue/ENG-1", status: "synced" }),
        task({ title: "today", dueDate: "2026-11-04" }),
        task({ title: "far", dueDate: "2026-12-30" }),
        task({ title: "shipped", status: "done", dueDate: "2026-11-01", completedAt: "2026-11-03T10:00:00.000Z" }),
        task({ title: "shipped last week", status: "done", completedAt: "2026-10-28T10:00:00.000Z" }),
        task({ title: "Bo's", ownerName: "Bo", ownerPersonId: "p-bo", dueDate: "2026-11-05" }),
      ],
      today,
      weekStart,
    );
    assert.deepEqual(owners.map((o) => o.ownerName), ["Ana", "Bo"]);
    const ana = owners[0]!;
    assert.deepEqual(ana.overdue.map((t) => [t.title, t.daysOverdue]), [["late A", 3], ["late B", 2]]);
    assert.deepEqual(ana.upcoming.map((t) => [t.title, t.daysOverdue]), [["today", 0], ["soon", -2]]);
    assert.deepEqual(ana.completed.map((t) => t.title), ["shipped"]);
    assert.equal(ana.upcoming[1]!.linearUrl, "https://linear.app/t/issue/ENG-1");
    assert.equal(ana.upcoming[1]!.meeting.title, "Kickoff");
    assert.deepEqual(owners[1]!.upcoming.map((t) => t.title), ["Bo's"]);
  });

  test("ignores proposed, rejected and undated tasks; owners with nothing to show are omitted", () => {
    const owners = buildOwnerDigests(
      [
        task({ title: "p", status: "proposed", dueDate: "2026-11-01" }),
        task({ title: "r", status: "rejected", dueDate: "2026-11-01" }),
        task({ title: "undated" }),
      ],
      today,
      weekStart,
    );
    assert.deepEqual(owners, []);
  });

  test("unowned tasks go to Unassigned (last); unknown owner names group case-insensitively", () => {
    const owners = buildOwnerDigests(
      [
        task({ title: "u", ownerName: null, ownerPersonId: null, dueDate: "2026-11-01" }),
        task({ title: "x1", ownerName: "Zed", ownerPersonId: null, dueDate: "2026-11-01" }),
        task({ title: "x2", ownerName: "zed", ownerPersonId: null, dueDate: "2026-11-02" }),
        task({ title: "a", dueDate: "2026-11-01" }),
      ],
      today,
      weekStart,
    );
    assert.deepEqual(owners.map((o) => [o.ownerName, o.personId, o.overdue.length]), [["Ana", "p-ana", 1], ["Zed", null, 2], ["Unassigned", null, 1]]);
  });
});

// ---------- database ----------

const dbUp = await pingDatabase();
const tag = `p5-${Date.now()}`;

describe("reminders and digests (PostgreSQL)", { skip: !dbUp && "database unreachable" }, () => {
  const meetingIds: string[] = [];
  const personIds: string[] = [];
  after(async () => {
    if (meetingIds.length) await pool.query(`delete from meetings where id = any($1::uuid[])`, [meetingIds]);
    if (personIds.length) await pool.query(`delete from people where id = any($1::uuid[])`, [personIds]);
    await pool.end();
  });

  const now = new Date();
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

  async function person(name: string) {
    const { rows } = await pool.query<{ id: string }>(`insert into people (name) values ($1) returning id`, [`${tag} ${name}`]);
    personIds.push(rows[0]!.id);
    return rows[0]!.id;
  }
  async function meeting() {
    const { rows } = await pool.query<{ id: string }>(
      `insert into meetings (title, occurred_at, source, raw_transcript, status) values ($1, now(), 'paste', 'x', 'extracted') returning id`,
      [`${tag} meeting`],
    );
    meetingIds.push(rows[0]!.id);
    return rows[0]!.id;
  }
  async function task(m: string, o: { title: string; due: string | null; status?: string; owner?: string; external?: string }) {
    const status = o.status ?? "approved";
    const { rows } = await pool.query<{ id: string }>(
      `insert into tasks (meeting_id, title, owner_person_id, due_date, status, approved_at, rejected_at, completed_at, external_provider, external_id, external_url)
       values ($1, $2, $3, $4, $5,
         case when $5 in ('approved','synced','done') then now() end,
         case when $5 = 'rejected' then now() end,
         case when $5 = 'done' then now() end,
         case when $6::text is not null then 'linear' end, $6, case when $6::text is not null then 'https://linear.app/t/issue/' || $6 end)
       returning id`,
      [m, `${tag} ${o.title}`, o.owner ?? null, o.due, status, o.external ?? null],
    );
    return rows[0]!.id;
  }
  const remindersFor = async (ids: string[]) =>
    (await pool.query(`select * from reminders where task_id = any($1::uuid[])`, [ids])).rows;
  const ours = <T extends TaskRef>(items: T[]) => items.filter((i) => i.title.startsWith(tag));

  test("generates reminders only for approved/synced tasks inside the window and never twice", async () => {
    const m = await meeting();
    const soon = await task(m, { title: "due tomorrow", due: day(1) });
    const synced = await task(m, { title: "synced due today", due: day(0), status: "synced", external: `${tag}-1` });
    const far = await task(m, { title: "far away", due: day(10) });
    const noDate = await task(m, { title: "undated", due: null });
    const late = await task(m, { title: "already overdue", due: day(-2) });
    const proposed = await task(m, { title: "proposed", due: day(1), status: "proposed" });
    const rejected = await task(m, { title: "rejected", due: day(1), status: "rejected" });
    const done = await task(m, { title: "done", due: day(1), status: "done" });
    const all = [soon, synced, far, noDate, late, proposed, rejected, done];

    const preview = await previewReminders(pool, 24, now);
    assert.deepEqual(ours(preview.items).map((i) => i.title.slice(tag.length + 1)).sort(), ["due tomorrow", "synced due today"]);
    assert.equal((await remindersFor(all)).length, 0, "preview must not write");

    const first = await generateReminders(pool, 24, now);
    assert.ok(first.created >= 2);
    assert.equal(first.delivery.mode, "in-app");
    const rows = await remindersFor(all);
    assert.deepEqual(rows.map((r) => r.task_id).sort(), [soon, synced].sort());
    assert.ok(rows.every((r) => r.sent_at === null && r.read_at === null));

    const second = await generateReminders(pool, 24, now);
    assert.equal(second.created, 0, "second run creates nothing");
    assert.equal((await remindersFor(all)).length, 2);
    assert.equal(ours((await previewReminders(pool, 24, now)).items).every((i) => i.alreadyGenerated), true);

    // A wider window picks up the far task once, still without duplicating the others.
    await generateReminders(pool, 24 * 11, now);
    assert.equal((await remindersFor(all)).length, 3); // soon, synced and far; the rest stay out
    assert.equal((await remindersFor([far])).length, 1);
  });

  test("the database refuses duplicates and reminders for tasks that are not approved", async () => {
    const m = await meeting();
    const ok = await task(m, { title: "constraint ok", due: day(1) });
    const bad = [
      await task(m, { title: "constraint proposed", due: day(1), status: "proposed" }),
      await task(m, { title: "constraint rejected", due: day(1), status: "rejected" }),
      await task(m, { title: "constraint done", due: day(1), status: "done" }),
    ];
    const insert = (id: string, due: string) =>
      pool.query(`insert into reminders (task_id, due_date, remind_at) values ($1, $2, now())`, [id, due]);
    await insert(ok, day(1));
    await assert.rejects(insert(ok, day(1)), /reminders_task_due_unique/);
    for (const id of bad) await assert.rejects(insert(id, day(1)), /can only be created for approved tasks/);
    await assert.rejects(insert(ok, day(5)), /does not match the task due date/);
  });

  test("a delivery timestamp is refused without a recorded human approval to send", async () => {
    const m = await meeting();
    const t = await task(m, { title: "send gate", due: day(1) });
    await generateReminders(pool, 24, now);
    const [r] = await remindersFor([t]);
    await assert.rejects(pool.query(`update reminders set sent_at = now() where id = $1`, [r.id]), /reminders_send_requires_approval/);
  });

  test("completing a task marks it done, audits it and stops further reminders; reject/proposed cannot be completed", async () => {
    const m = await meeting();
    const t = await task(m, { title: "to complete", due: day(1) });
    const p = await task(m, { title: "not approved", due: day(1), status: "proposed" });
    await generateReminders(pool, 24, now);

    const done = await completeTask(pool, t, "tester");
    assert.equal(done.status, "done");
    assert.equal((await completeTask(pool, t, "tester")).status, "done"); // idempotent
    await assert.rejects(completeTask(pool, p, "tester"), (e) => (e as { status?: number }).status === 409);

    const inbox = await listInbox(pool);
    const mine = inbox.reminders.find((r) => r.taskId === t)!;
    assert.equal(mine.taskOpen, false);
    assert.equal(mine.deliveredAt, null);
    assert.ok(!ours((await previewReminders(pool, 24, now)).items).some((i) => i.taskId === t));
  });

  test("digest groups by owner with overdue, upcoming, completed, meeting source and Linear link", async () => {
    const m = await meeting();
    const ana = await person("Ana");
    const bo = await person("Bo");
    await task(m, { title: "ana late", due: day(-3), owner: ana });
    await task(m, { title: "ana soon", due: day(2), owner: ana, status: "synced", external: `${tag}-2` });
    await task(m, { title: "bo soon", due: day(1), owner: bo });
    await task(m, { title: "bo rejected", due: day(-3), owner: bo, status: "rejected" });
    const finished = await task(m, { title: "ana finished", due: day(-1), owner: ana });
    await completeTask(pool, finished, "tester");

    const digest = await previewDigest(pool, now);
    assert.equal(digest.delivery.mode, "in-app");
    const a = digest.owners.find((o) => o.personId === ana)!;
    const b = digest.owners.find((o) => o.personId === bo)!;
    assert.deepEqual(a.overdue.map((t) => t.title), [`${tag} ana late`]);
    assert.equal(a.overdue[0]!.daysOverdue, 3);
    assert.deepEqual(a.upcoming.map((t) => t.title), [`${tag} ana soon`]);
    assert.equal(a.upcoming[0]!.linearUrl, `https://linear.app/t/issue/${tag}-2`);
    assert.equal(a.upcoming[0]!.meeting.id, m);
    assert.deepEqual(a.completed.map((t) => t.title), [`${tag} ana finished`]);
    assert.deepEqual([b.overdue.length, b.upcoming.length, b.completed.length], [0, 1, 0]);

    const generated = await generateDigests(pool, now);
    assert.ok(generated.stored >= 2);
    const again = await generateDigests(pool, now); // idempotent per person per week
    const stored = (await listDigests(pool)).filter((d) => d.personId === ana && d.weekStart === digest.weekStart);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.deliveredAt, null);
    assert.equal(stored[0]!.content.overdue.length, 1);
    assert.equal(again.stored, generated.stored);
  });

  test("HTTP: previews are read-only, generation is an explicit POST, windowHours is validated", async () => {
    const m = await meeting();
    const t = await task(m, { title: "http", due: day(1) });
    const server = createApp(testAuthDeps()).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const headers = await authHeaders();
    try {
      const get = async (path: string) => {
        const res = await fetch(base + path, { headers });
        return { status: res.status, body: (await res.json()) as any };
      };
      const post = async (path: string, body: unknown = {}) => {
        const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as any };
      };

      const preview = await get("/reminders/preview");
      assert.equal(preview.status, 200);
      assert.equal(preview.body.windowHours, 24);
      assert.ok(preview.body.items.some((i: any) => i.taskId === t && !i.alreadyGenerated));
      assert.equal((await remindersFor([t])).length, 0);

      assert.equal((await get("/reminders/preview?windowHours=0")).status, 400);
      assert.equal((await get("/reminders/preview?windowHours=abc")).status, 400);
      assert.equal((await post("/reminders/generate", { windowHours: 100000 })).status, 400);

      const gen = await post("/reminders/generate", { windowHours: 48 });
      assert.equal(gen.status, 200);
      assert.equal(gen.body.windowHours, 48);
      assert.equal((await remindersFor([t])).length, 1);

      const inbox = await get("/reminders");
      const mine = inbox.body.reminders.find((r: any) => r.taskId === t);
      assert.equal(mine.deliveredAt, null);
      assert.equal(inbox.body.delivery.externalDelivery, "not_available");
      const read = await post(`/reminders/${mine.id}/read`);
      assert.ok(read.body.reminders.find((r: any) => r.id === mine.id).readAt);
      assert.equal((await post("/reminders/00000000-0000-4000-8000-000000000000/read")).status, 404);

      assert.equal((await get("/digests/preview")).status, 200);
      assert.equal((await post("/digests/generate")).status, 200);
      assert.equal((await post(`/tasks/${t}/complete`, { actor: "tester" })).body.status, "done");
    } finally {
      server.close();
    }
  });
});
