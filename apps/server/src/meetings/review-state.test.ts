import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { meetingReviewState, type MeetingSummary } from "@recall/shared";

const base: MeetingSummary = {
  id: "m1",
  title: "Sync",
  occurredAt: "2026-10-30T00:00:00.000Z",
  source: "paste",
  status: "extracted",
  participants: [],
  decisionCount: 2,
  taskCount: 3,
  pendingDecisionCount: 0,
  pendingTaskCount: 0,
  openConflictCount: 0,
  conflictCheckStatus: "done",
  createdAt: "2026-10-30T00:00:00.000Z",
};
const state = (over: Partial<MeetingSummary>) => meetingReviewState({ ...base, ...over });

describe("meetingReviewState", () => {
  test("never calls a fully approved meeting a draft", () => {
    assert.deepEqual(state({}), { label: "Reviewed", tone: "done" });
  });
  test("counts everything still awaiting approval", () => {
    assert.deepEqual(state({ pendingDecisionCount: 1, pendingTaskCount: 2 }), { label: "3 awaiting approval", tone: "draft" });
  });
  test("open conflicts outrank pending approvals and are pluralised", () => {
    assert.deepEqual(state({ openConflictCount: 1, pendingTaskCount: 2 }), { label: "1 open conflict", tone: "conflict" });
    assert.equal(state({ openConflictCount: 2 }).label, "2 open conflicts");
  });
  test("a meeting whose conflicts were all resolved no longer reads as conflicted", () => {
    assert.equal(state({ openConflictCount: 0 }).label, "Reviewed");
  });
  test("a failed conflict check is surfaced instead of reading as reviewed", () => {
    assert.deepEqual(state({ conflictCheckStatus: "failed" }), { label: "Conflict check failed", tone: "caution" });
    assert.equal(state({ conflictCheckStatus: "failed", pendingTaskCount: 1 }).label, "Conflict check failed");
  });
  test("an analyzed meeting with nothing extracted says so", () => {
    assert.deepEqual(state({ decisionCount: 0, taskCount: 0 }), { label: "Nothing extracted", tone: "neutral" });
  });
  test("analysis status wins over stale counts", () => {
    assert.equal(state({ status: "ingested", pendingTaskCount: 4, openConflictCount: 1 }).label, "Not analyzed");
    assert.equal(state({ status: "extracting" }).label, "Analyzing…");
    assert.equal(state({ status: "failed", openConflictCount: 1 }).label, "Analysis failed");
  });
});
