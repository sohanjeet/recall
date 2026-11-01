import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { createApp } from "../app.js";
import { pingDatabase, pool } from "../db.js";
import { authHeaders, testAuthDeps } from "../security/testing.js";
import { HttpError } from "../meetings/errors.js";
import { listAudit } from "./common.js";
import { approveDecision, editDecision, rejectDecision } from "./decisions.js";
import { createLinearClient, LinearError, type LinearClient, type LinearIssue, type NewIssue } from "./linear.js";
import { getDecision, getTask, listApprovals } from "./read.js";
import { resolveConflict } from "./resolve.js";
import { syncTask, taskMarker } from "./sync.js";
import { approveTask, editTask, rejectTask } from "./tasks.js";

const actor = `test-${Date.now()}`;
const act = { actor };

// ---------- Linear client (fake fetch) ----------

describe("Linear client", () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const client = (fetchImpl: typeof fetch) => createLinearClient({ apiKey: "lin_api_SECRET", teamId: "team-1", fetchImpl });

  test("creates an issue with the server-side key and returns its id and URL", async () => {
    let seen: { headers: Headers; body: { variables: { input: Record<string, unknown> } } } | undefined;
    const c = client(async (_url, init) => {
      seen = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return ok({ data: { issueCreate: { success: true, issue: { id: "i1", identifier: "ENG-1", url: "https://linear.app/x/issue/ENG-1" } } } });
    });
    const issue = await c.createIssue({ title: "T", description: "D", dueDate: "2026-11-05" });
    assert.deepEqual(issue, { id: "i1", identifier: "ENG-1", url: "https://linear.app/x/issue/ENG-1" });
    assert.equal(seen!.headers.get("authorization"), "lin_api_SECRET");
    assert.deepEqual(seen!.body.variables.input, { teamId: "team-1", title: "T", description: "D", dueDate: "2026-11-05" });
  });

  test("never reports success for HTTP errors, GraphQL errors, success:false or a missing URL; errors do not leak the key", async () => {
    const cases: Response[] = [
      ok({ errors: [{ message: "Authentication required" }] }, 401),
      ok({ errors: [{ message: "Argument Validation Error" }] }),
      ok({ data: { issueCreate: { success: false, issue: null } } }),
      ok({ data: { issueCreate: { success: true, issue: { id: "i1" } } } }),
      ok({ data: null }),
    ];
    for (const res of cases) {
      const c = client(async () => res.clone());
      await assert.rejects(c.createIssue({ title: "T", description: "D", dueDate: null }), (e: Error) => {
        assert.ok(e instanceof LinearError);
        assert.ok(!e.message.includes("SECRET"));
        return true;
      });
    }
    const down = client(async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(down.createIssue({ title: "T", description: "D", dueDate: null }), /Could not reach Linear/);
  });

  test("finds an issue by marker, or null", async () => {
    const found = client(async () => ok({ data: { issues: { nodes: [{ id: "i9", identifier: "ENG-9", url: "https://l/9" }] } } }));
    assert.equal((await found.findIssueByMarker("m"))?.id, "i9");
    const none = client(async () => ok({ data: { issues: { nodes: [] } } }));
    assert.equal(await none.findIssueByMarker("m"), null);
  });
});

// ---------- fake Linear used with the database tests ----------

function fakeLinear() {
  const issues: (LinearIssue & { description: string })[] = [];
  const state = { creates: 0, finds: 0, mode: "ok" as "ok" | "fail" | "lose" };
  const client: LinearClient = {
    async findIssueByMarker(marker) {
      state.finds++;
      return issues.find((i) => i.description.includes(marker)) ?? null;
    },
    async createIssue(input: NewIssue) {
      state.creates++;
      if (state.mode === "fail") throw new LinearError("Linear API 500: boom");
      const issue = { id: `lin-${issues.length + 1}-${Date.now()}`, identifier: `ENG-${issues.length + 1}`, url: `https://linear.app/t/issue/ENG-${issues.length + 1}`, description: input.description };
      issues.push(issue);
      // The issue exists in Linear but the response never reaches us.
      if (state.mode === "lose") throw new LinearError("Linear did not respond in time");
      return issue;
    },
  };
  return { client, state, issues };
}

// ---------- database tests ----------

const dbUp = await pingDatabase();

describe("approvals (PostgreSQL)", { skip: !dbUp && "database unreachable" }, () => {
  const meetingIds: string[] = [];
  after(async () => {
    if (meetingIds.length) await pool.query(`delete from meetings where id = any($1::uuid[])`, [meetingIds]);
    await pool.end();
  });

  async function meeting(status = "extracted") {
    const { rows } = await pool.query<{ id: string }>(
      `insert into meetings (title, occurred_at, source, raw_transcript, status) values ($1, now(), 'paste', 'x', $2) returning id`,
      [`${actor} meeting`, status],
    );
    meetingIds.push(rows[0]!.id);
    return rows[0]!.id;
  }
  async function decision(meetingId: string, status: "proposed" | "active", summary = "Ship Nov 15") {
    const { rows } = await pool.query<{ id: string }>(
      `insert into decisions (meeting_id, summary, status, approved_at) values ($1, $2, $3, case when $3 = 'active' then now() end) returning id`,
      [meetingId, summary, status],
    );
    return rows[0]!.id;
  }
  async function conflict(meetingId: string, decisionId: string, earlierId: string, certainty: "clear" | "uncertain" = "clear") {
    const { rows } = await pool.query<{ id: string }>(
      `insert into decision_conflicts (meeting_id, decision_id, conflicting_decision_id, explanation, certainty)
       values ($1, $2, $3, 'test conflict', $4) returning id`,
      [meetingId, decisionId, earlierId, certainty],
    );
    return rows[0]!.id;
  }
  async function task(meetingId: string, over: { due?: string | null } = {}) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into tasks (meeting_id, title, description, owner_name, due_date, status) values ($1, 'Send notes', 'desc', 'Ana', $2, 'proposed') returning id`,
      [meetingId, over.due ?? null],
    );
    return rows[0]!.id;
  }
  const conflictRow = async (id: string) => (await pool.query(`select * from decision_conflicts where id = $1`, [id])).rows[0];
  const decisionRow = async (id: string) => (await pool.query(`select * from decisions where id = $1`, [id])).rows[0];
  const auditActions = async (type: "decision" | "task" | "conflict", id: string) => (await listAudit(pool, type, id)).map((e) => e.action);
  const status = (e: unknown) => (e as HttpError).status;

  describe("decisions", () => {
    test("approve and reject record who/when, bump the version and write audit events; repeats are no-ops", async () => {
      const m = await meeting();
      const a = await decision(m, "proposed", "Adopt Postgres");
      const b = await decision(m, "proposed", "Adopt Redis");

      const approved = await approveDecision(pool, a, act);
      assert.equal(approved.status, "active");
      assert.ok(approved.approvedAt);
      assert.equal(approved.version, 2);
      assert.equal((await decisionRow(a)).approved_by, actor);

      const again = await approveDecision(pool, a, act); // idempotent
      assert.equal(again.version, 2);
      assert.deepEqual(await auditActions("decision", a), ["approved"]);

      const rejected = await rejectDecision(pool, b, act);
      assert.equal(rejected.status, "rejected");
      assert.ok(rejected.rejectedAt);
      assert.equal((await rejectDecision(pool, b, act)).version, rejected.version);
      assert.deepEqual(await auditActions("decision", b), ["rejected"]);
    });

    test("invalid transitions are refused with 409 and change nothing", async () => {
      const m = await meeting();
      const a = await decision(m, "proposed");
      const b = await decision(m, "proposed");
      await approveDecision(pool, a, act);
      await rejectDecision(pool, b, act);

      await assert.rejects(rejectDecision(pool, a, act), (e) => status(e) === 409);
      await assert.rejects(approveDecision(pool, b, act), (e) => status(e) === 409);
      await assert.rejects(editDecision(pool, a, { summary: "Rewrite history", version: 2 }, actor), (e) => status(e) === 409);
      assert.equal((await getDecision(pool, a)).status, "active");
      assert.equal((await getDecision(pool, b)).status, "rejected");
      assert.deepEqual(await auditActions("decision", a), ["approved"]);
    });

    test("unknown records are 404 and a meeting that is not extracted cannot be reviewed", async () => {
      await assert.rejects(approveDecision(pool, "00000000-0000-4000-8000-000000000000", act), (e) => status(e) === 404);
      const busy = await meeting("extracting");
      const d = await decision(busy, "proposed");
      await assert.rejects(approveDecision(pool, d, act), (e) => status(e) === 409);
      assert.equal((await getDecision(pool, d)).status, "proposed");
    });

    test("edits need the current version, are audited, and approved wording is frozen in the database", async () => {
      const m = await meeting();
      const d = await decision(m, "proposed", "Ship Nov 15");
      await assert.rejects(editDecision(pool, d, { summary: "Ship Nov 22", version: 99 }, actor), (e) => status(e) === 409);
      await assert.rejects(editDecision(pool, d, { version: 1 }, actor), (e) => status(e) === 400);

      const edited = await editDecision(pool, d, { summary: "Ship Nov 22", rationale: "QA slipped", version: 1 }, actor);
      assert.equal(edited.summary, "Ship Nov 22");
      assert.equal(edited.version, 2);
      // A stale approve (made against the pre-edit content) is refused.
      await assert.rejects(approveDecision(pool, d, { actor, version: 1 }), (e) => status(e) === 409);
      await approveDecision(pool, d, { actor, version: 2 });

      const log = await listAudit(pool, "decision", d);
      assert.deepEqual(log.map((e) => e.action), ["edited", "approved"]);
      assert.deepEqual((log[0]!.details as { before: { summary: string } }).before.summary, "Ship Nov 15");
      await assert.rejects(pool.query(`update decisions set summary = 'tampered' where id = $1`, [d]), /immutable/);
    });

    test("a clear open conflict blocks approval; an uncertain one does not and is closed on approval", async () => {
      const m = await meeting();
      const oldD = await decision(await meeting(), "active");
      const clear = await decision(m, "proposed", "Ship Nov 22");
      const c1 = await conflict(m, clear, oldD, "clear");
      await assert.rejects(approveDecision(pool, clear, act), (e) => {
        assert.equal(status(e), 409);
        assert.deepEqual((e as HttpError).details, { conflictIds: [c1] });
        return true;
      });
      assert.equal((await getDecision(pool, clear)).status, "proposed");

      const fuzzy = await decision(m, "proposed", "Maybe ship Nov 22");
      const c2 = await conflict(m, fuzzy, oldD, "uncertain");
      assert.equal((await approveDecision(pool, fuzzy, act)).status, "active");
      assert.equal((await conflictRow(c2)).resolution, "dismissed");
      assert.deepEqual(await auditActions("conflict", c2), ["dismissed"]);
      assert.equal((await decisionRow(oldD)).status, "active", "approving the new one never touches the old one");
    });

    test("rejecting a proposal never modifies the earlier approved decision", async () => {
      const m = await meeting();
      const oldD = await decision(await meeting(), "active");
      const fresh = await decision(m, "proposed", "Ship Nov 22");
      await conflict(m, fresh, oldD);
      const before = await decisionRow(oldD);
      await rejectDecision(pool, fresh, act);
      assert.deepEqual(await decisionRow(oldD), before);
      assert.deepEqual(await auditActions("decision", oldD), []);
    });
  });

  describe("conflict resolution", () => {
    test("accept_new supersedes the old decision and activates the new one together", async () => {
      const m = await meeting();
      const oldD = await decision(await meeting(), "active", "Ship Nov 15");
      const fresh = await decision(m, "proposed", "Ship Nov 22");
      const c = await conflict(m, fresh, oldD);

      const res = await resolveConflict(pool, c, "accept_new", actor);
      assert.equal(res.resolution, "kept_new");
      const o = await decisionRow(oldD);
      const n = await decisionRow(fresh);
      assert.equal(o.status, "superseded");
      assert.equal(o.superseded_by, fresh);
      assert.equal(o.summary, "Ship Nov 15", "history text untouched");
      assert.equal(n.status, "active");
      assert.ok(n.approved_at);
      assert.equal(n.approved_by, actor);
      assert.deepEqual(await auditActions("decision", oldD), ["superseded"]);
      assert.deepEqual(await auditActions("decision", fresh), ["approved"]);
      assert.deepEqual(await auditActions("conflict", c), ["accept_new"]);

      // Repeating is a no-op; a different action is refused.
      assert.equal((await resolveConflict(pool, c, "accept_new", actor)).resolution, "kept_new");
      assert.deepEqual(await auditActions("conflict", c), ["accept_new"]);
      await assert.rejects(resolveConflict(pool, c, "keep_old", actor), (e) => status(e) === 409);
    });

    test("keep_old leaves the old decision active and rejects the new draft", async () => {
      const m = await meeting();
      const oldD = await decision(await meeting(), "active");
      const fresh = await decision(m, "proposed", "Ship Nov 22");
      const c = await conflict(m, fresh, oldD);
      const before = await decisionRow(oldD);

      assert.equal((await resolveConflict(pool, c, "keep_old", actor)).resolution, "kept_old");
      assert.deepEqual(await decisionRow(oldD), before);
      assert.equal((await decisionRow(fresh)).status, "rejected");
      assert.equal((await resolveConflict(pool, c, "keep_old", actor)).resolution, "kept_old");
      await assert.rejects(resolveConflict(pool, c, "accept_new", actor), (e) => status(e) === 409);
      await assert.rejects(approveDecision(pool, fresh, act), (e) => status(e) === 409);
    });

    test("dismiss only applies to uncertain conflicts and leaves both decisions as they were", async () => {
      const m = await meeting();
      const oldD = await decision(await meeting(), "active");
      const clearD = await decision(m, "proposed", "A");
      const fuzzyD = await decision(m, "proposed", "B");
      const clear = await conflict(m, clearD, oldD, "clear");
      const fuzzy = await conflict(m, fuzzyD, oldD, "uncertain");

      await assert.rejects(resolveConflict(pool, clear, "dismiss", actor), (e) => status(e) === 409);
      assert.equal((await conflictRow(clear)).resolution, "open");

      assert.equal((await resolveConflict(pool, fuzzy, "dismiss", actor)).resolution, "dismissed");
      assert.equal((await decisionRow(fuzzyD)).status, "proposed");
      assert.equal((await decisionRow(oldD)).status, "active");
      // Now nothing blocks it.
      assert.equal((await approveDecision(pool, fuzzyD, act)).status, "active");
    });

    test("accept_new is refused (and changes nothing) when the old decision is no longer active or other conflicts remain", async () => {
      const m = await meeting();
      const old1 = await decision(await meeting(), "active");
      const old2 = await decision(await meeting(), "active");
      const fresh = await decision(m, "proposed");
      const c1 = await conflict(m, fresh, old1);
      const c2 = await conflict(m, fresh, old2);

      await assert.rejects(resolveConflict(pool, c1, "accept_new", actor), (e) => status(e) === 409 && /other unresolved/.test((e as Error).message));
      assert.equal((await decisionRow(old1)).status, "active");
      assert.equal((await decisionRow(fresh)).status, "proposed");
      assert.equal((await conflictRow(c1)).resolution, "open");

      await resolveConflict(pool, c2, "keep_old", actor); // rejects `fresh`, closes c1
      assert.equal((await conflictRow(c1)).resolution, "dismissed");
      await assert.rejects(resolveConflict(pool, c1, "keep_old", actor), (e) => status(e) === 409);

      const m2 = await meeting();
      const gone = await decision(await meeting(), "active");
      const f2 = await decision(m2, "proposed");
      const c3 = await conflict(m2, f2, gone);
      await pool.query(`update decisions set status = 'reversed' where id = $1`, [gone]);
      await assert.rejects(resolveConflict(pool, c3, "accept_new", actor), (e) => status(e) === 409 && /reversed/.test((e as Error).message));
      assert.equal((await decisionRow(f2)).status, "proposed");
    });

    test("two competing accept_new calls on the same old decision: exactly one wins", async () => {
      const oldD = await decision(await meeting(), "active");
      const m1 = await meeting();
      const m2 = await meeting();
      const x = await decision(m1, "proposed", "X");
      const y = await decision(m2, "proposed", "Y");
      const cx = await conflict(m1, x, oldD);
      const cy = await conflict(m2, y, oldD);

      const results = await Promise.allSettled([resolveConflict(pool, cx, "accept_new", actor), resolveConflict(pool, cy, "accept_new", actor)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const loser = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      assert.equal(status(loser.reason), 409);

      const o = await decisionRow(oldD);
      assert.equal(o.status, "superseded");
      const winner = o.superseded_by as string;
      assert.ok([x, y].includes(winner));
      const loserId = winner === x ? y : x;
      assert.equal((await decisionRow(winner)).status, "active");
      assert.equal((await decisionRow(loserId)).status, "proposed", "loser untouched");
    });

    test("concurrent approvals of one decision approve it once", async () => {
      const m = await meeting();
      const d = await decision(m, "proposed");
      await Promise.all([approveDecision(pool, d, act), approveDecision(pool, d, act), approveDecision(pool, d, act)]);
      assert.deepEqual(await auditActions("decision", d), ["approved"]);
      assert.equal((await getDecision(pool, d)).version, 2);
    });
  });

  describe("tasks and Linear", () => {
    test("approval records who/when; reject, repeat and invalid transitions behave", async () => {
      const m = await meeting();
      const t1 = await task(m);
      const t2 = await task(m);
      const approved = await approveTask(pool, t1, act);
      assert.equal(approved.status, "approved");
      assert.ok(approved.approvedAt);
      assert.equal(approved.externalId, null, "approval alone creates nothing external");
      assert.equal((await approveTask(pool, t1, act)).version, approved.version);

      assert.equal((await rejectTask(pool, t2, act)).status, "rejected");
      assert.equal((await rejectTask(pool, t2, act)).status, "rejected");
      await assert.rejects(approveTask(pool, t2, act), (e) => status(e) === 409);
      await assert.rejects(rejectTask(pool, t1, act), (e) => status(e) === 409);
      await assert.rejects(editTask(pool, t1, { title: "New", version: approved.version }, actor), (e) => status(e) === 409);
      assert.deepEqual(await auditActions("task", t1), ["approved"]);
      assert.deepEqual(await auditActions("task", t2), ["rejected"]);
    });

    test("edits update the task, require the current version and are audited", async () => {
      const m = await meeting();
      const t = await task(m, { due: "2099-01-01" });
      await assert.rejects(editTask(pool, t, { title: "X", version: 7 }, actor), (e) => status(e) === 409);
      const edited = await editTask(pool, t, { title: "Send release notes", ownerName: "Sam", dueDate: null, version: 1 }, actor);
      assert.equal(edited.title, "Send release notes");
      assert.equal(edited.ownerName, "Sam");
      assert.equal(edited.dueDate, null);
      assert.equal(edited.version, 2);
      assert.deepEqual(await auditActions("task", t), ["edited"]);
    });

    test("no external issue exists before approval: unapproved tasks cannot be synced and the database forbids it", async () => {
      const m = await meeting();
      const t = await task(m);
      const lin = fakeLinear();
      await assert.rejects(syncTask(pool, lin.client, t, actor), (e) => status(e) === 409);
      assert.equal(lin.state.creates, 0);
      assert.equal(lin.state.finds, 0);

      await rejectTask(pool, t, act);
      await assert.rejects(syncTask(pool, lin.client, t, actor), (e) => status(e) === 409);
      assert.equal(lin.state.creates, 0);
      await assert.rejects(pool.query(`update tasks set external_provider = 'linear', external_id = 'x' where id = $1`, [t]), /tasks_external_requires_approval/);
    });

    test("approved task is sent once; id and URL are stored; repeats and concurrent calls create no duplicates", async () => {
      const m = await meeting();
      const t = await task(m, { due: "2099-01-01" });
      const lin = fakeLinear();
      await approveTask(pool, t, act);
      assert.equal(lin.state.creates, 0, "approving does not itself call Linear");

      const results = await Promise.allSettled([syncTask(pool, lin.client, t, actor), syncTask(pool, lin.client, t, actor), syncTask(pool, lin.client, t, actor)]);
      assert.equal(lin.state.creates, 1, "one claim wins; the others are refused or see it synced");
      assert.ok(results.some((r) => r.status === "fulfilled"));

      const synced = await getTask(pool, t);
      assert.equal(synced.status, "synced");
      assert.equal(synced.externalProvider, "linear");
      assert.ok(synced.externalId);
      assert.match(synced.externalUrl ?? "", /^https:\/\/linear\.app\//);
      assert.equal(synced.syncStatus, null);
      assert.ok(lin.issues[0]!.description.includes(taskMarker(t)));

      await syncTask(pool, lin.client, t, actor); // already synced: returned as-is
      await approveTask(pool, t, act);
      assert.equal(lin.state.creates, 1);
      const actions = await auditActions("task", t);
      assert.equal(actions.filter((a) => a === "synced").length, 1);
      assert.equal(actions.filter((a) => a === "approved").length, 1);
    });

    test("a Linear failure is stored, leaves the task approved without an external id, and retry succeeds", async () => {
      const m = await meeting();
      const t = await task(m);
      const lin = fakeLinear();
      await approveTask(pool, t, act);

      lin.state.mode = "fail";
      await assert.rejects(syncTask(pool, lin.client, t, actor), (e) => status(e) === 502 && /Linear API 500/.test((e as Error).message));
      const failed = await getTask(pool, t);
      assert.equal(failed.status, "approved");
      assert.equal(failed.syncStatus, "failed");
      assert.match(failed.syncError ?? "", /Linear API 500: boom/);
      assert.equal(failed.syncAttempts, 1);
      assert.equal(failed.externalId, null);

      lin.state.mode = "ok";
      const retried = await syncTask(pool, lin.client, t, actor);
      assert.equal(retried.status, "synced");
      assert.equal(retried.syncError, null);
      assert.equal(retried.syncAttempts, 2);
      assert.deepEqual(
        (await auditActions("task", t)).filter((a) => a.startsWith("sync") || a === "synced"),
        ["sync_started", "sync_failed", "sync_started", "synced"],
      );
    });

    test("if Linear created the issue but the response was lost, retry adopts it instead of creating a duplicate", async () => {
      const m = await meeting();
      const t = await task(m);
      const lin = fakeLinear();
      await approveTask(pool, t, act);

      lin.state.mode = "lose";
      await assert.rejects(syncTask(pool, lin.client, t, actor), (e) => status(e) === 502);
      assert.equal(lin.issues.length, 1);

      lin.state.mode = "ok";
      const retried = await syncTask(pool, lin.client, t, actor);
      assert.equal(retried.status, "synced");
      assert.equal(retried.externalId, lin.issues[0]!.id);
      assert.equal(lin.issues.length, 1, "no second issue");
      assert.equal(lin.state.creates, 1);
      const synced = (await listAudit(pool, "task", t)).find((e) => e.action === "synced")!;
      assert.equal(synced.details.adoptedExisting, true);
    });

    test("an abandoned 'syncing' claim is retaken only once stale", async () => {
      const m = await meeting();
      const t = await task(m);
      const lin = fakeLinear();
      await approveTask(pool, t, act);
      await pool.query(`update tasks set sync_status = 'syncing', sync_attempts = 1, sync_attempted_at = now() where id = $1`, [t]);
      await assert.rejects(syncTask(pool, lin.client, t, actor), (e) => status(e) === 409 && /in progress/.test((e as Error).message));
      assert.equal(lin.state.creates, 0);

      await pool.query(`update tasks set sync_attempted_at = now() - interval '10 minutes' where id = $1`, [t]);
      assert.equal((await syncTask(pool, lin.client, t, actor)).status, "synced");
      assert.equal(lin.state.creates, 1);
    });

    test("without Linear configuration nothing is attempted or recorded", async () => {
      const m = await meeting();
      const t = await task(m);
      await approveTask(pool, t, act);
      await assert.rejects(syncTask(pool, null, t, actor), (e) => status(e) === 503);
      const after = await getTask(pool, t);
      assert.equal(after.status, "approved");
      assert.equal(after.syncStatus, null);
      assert.equal(after.syncAttempts, 0);
    });
  });

  describe("audit history", () => {
    test("is append-only, even for direct SQL", async () => {
      const m = await meeting();
      const d = await decision(m, "proposed");
      await approveDecision(pool, d, act);
      const [event] = await listAudit(pool, "decision", d);
      await assert.rejects(pool.query(`update audit_events set actor = 'x' where id = $1`, [event!.id]), /append-only/);
      await assert.rejects(pool.query(`delete from audit_events where id = $1`, [event!.id]), /append-only/);
      assert.equal((await listAudit(pool, "decision", d)).length, 1);
    });

    test("a rolled-back action leaves no audit event", async () => {
      const m = await meeting();
      const d = await decision(m, "proposed");
      const c = await conflict(m, d, await decision(await meeting(), "active"));
      await assert.rejects(approveDecision(pool, d, act));
      assert.deepEqual(await auditActions("decision", d), []);
      assert.deepEqual(await auditActions("conflict", c), []);
    });
  });

  describe("listing and HTTP API", () => {
    test("GET /api/approvals lists drafts, open conflicts and sync state; actions go through the HTTP layer with validation", async () => {
      const m = await meeting();
      const oldD = await decision(await meeting(), "active");
      const fresh = await decision(m, "proposed", `${actor} new`);
      const c = await conflict(m, fresh, oldD);
      const t = await task(m);

      const lin = fakeLinear();
      const server = createApp({ linear: lin.client, ...testAuthDeps() }).listen(0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const headers = await authHeaders();
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as any };
      };
      try {
        const list = await call("GET", "/approvals");
        assert.equal(list.status, 200);
        assert.equal(list.body.linearConfigured, true);
        const item = list.body.decisions.find((d: { id: string }) => d.id === fresh);
        assert.deepEqual(item.openConflicts, [{ id: c, certainty: "clear" }]);
        assert.ok(list.body.tasks.some((x: { id: string }) => x.id === t));
        assert.ok(list.body.conflicts.some((x: { id: string }) => x.id === c));

        assert.equal((await call("POST", `/decisions/not-a-uuid/approve`)).status, 400);
        assert.equal((await call("POST", `/conflicts/${c}/resolve`, { action: "nuke" })).status, 400);
        assert.equal((await call("POST", `/decisions/${fresh}/approve`, { version: "one" })).status, 400);
        assert.equal((await call("PATCH", `/tasks/${t}`, { title: "  ", version: 1 })).status, 400);
        assert.equal((await call("PATCH", `/tasks/${t}`, { dueDate: "2026-02-30", version: 1 })).status, 400);
        assert.equal((await call("POST", `/decisions/${fresh}/approve`)).status, 409, "blocked by the open conflict");

        const none = await call("POST", `/tasks/${t}/sync`);
        assert.equal(none.status, 409, "not approved");
        assert.equal(lin.state.creates, 0);

        const approved = await call("POST", `/tasks/${t}/approve`, { actor });
        assert.equal(approved.status, 200);
        assert.equal(approved.body.status, "synced");
        assert.equal(lin.state.creates, 1);

        const resolved = await call("POST", `/conflicts/${c}/resolve`, { action: "accept_new", actor });
        assert.equal(resolved.status, 200);
        assert.equal((await call("GET", `/decisions/${fresh}`)).body.status, "active");
        const audit = await call("GET", `/audit?entityType=conflict&entityId=${c}`);
        assert.deepEqual(audit.body.map((e: { action: string }) => e.action), ["accept_new"]);
        assert.equal((await call("GET", `/audit?entityType=bogus&entityId=${c}`)).status, 400);

        const after = await listApprovals(pool, true);
        assert.ok(!after.conflicts.some((x) => x.id === c));
        assert.ok(after.sync.some((x) => x.id === t && x.externalUrl));
      } finally {
        server.close();
      }
    });

    test("approving a task when Linear fails still approves it and reports the failure on the task", async () => {
      const m = await meeting();
      const t = await task(m);
      const lin = fakeLinear();
      lin.state.mode = "fail";
      const server = createApp({ linear: lin.client, ...testAuthDeps() }).listen(0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      try {
        const res = await fetch(`${base}/tasks/${t}/approve`, { method: "POST", headers: await authHeaders(), body: JSON.stringify({ actor }) });
        const body = (await res.json()) as any;
        assert.equal(res.status, 200);
        assert.equal(body.status, "approved");
        assert.equal(body.syncStatus, "failed");
        assert.match(body.syncError, /boom/);
        assert.equal(body.externalId, null);
      } finally {
        server.close();
      }
    });

    test("with no Linear configured, approve works and sync reports 503", async () => {
      const m = await meeting();
      const t = await task(m);
      const server = createApp({ linear: null, ...testAuthDeps() }).listen(0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const headers = await authHeaders();
      try {
        const approve = await fetch(`${base}/tasks/${t}/approve`, { method: "POST", headers, body: "{}" });
        assert.equal(((await approve.json()) as any).status, "approved");
        assert.equal((await fetch(`${base}/tasks/${t}/sync`, { method: "POST", headers, body: "{}" })).status, 503);
        assert.equal(((await (await fetch(`${base}/approvals`, { headers })).json()) as any).linearConfigured, false);
      } finally {
        server.close();
      }
    });
  });
});
