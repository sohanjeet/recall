import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDuePhrase } from "./dates.js";

// 2026-10-30 is a Friday.
const fri = "2026-10-30";

test("resolves relative phrases against the meeting date", () => {
  assert.equal(resolveDuePhrase("tomorrow", fri), "2026-10-31");
  assert.equal(resolveDuePhrase("by next Friday", fri), "2026-11-06");
  assert.equal(resolveDuePhrase("next Monday", fri), "2026-11-02");
  assert.equal(resolveDuePhrase("by Monday", fri), "2026-11-02");
  assert.equal(resolveDuePhrase("on Friday", fri), "2026-11-06");
  assert.equal(resolveDuePhrase("this Friday", fri), fri);
  assert.equal(resolveDuePhrase("end of the week", "2026-10-28"), "2026-10-30");
  assert.equal(resolveDuePhrase("EOW", "2026-10-31"), "2026-11-06");
  assert.equal(resolveDuePhrase("in 2 weeks", fri), "2026-11-13");
});

test("returns null for phrases it cannot parse", () => {
  assert.equal(resolveDuePhrase("when the release is ready", fri), null);
  assert.equal(resolveDuePhrase(null, fri), null);
});
