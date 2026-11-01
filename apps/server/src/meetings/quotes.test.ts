import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { quoteVerifier } from "./quotes.js";

const segments = [
  { id: "s1", speakerLabel: "Sam", text: "Agreed. We're changing the Project Atlas launch date from November 20 to December 15, 2026." },
  { id: "s2", speakerLabel: "Priya", text: "I'll update the marketing campaign by November 18." },
  { id: "s3", speakerLabel: "Ana", text: "The landing page needs more testing, so November 20 is too early." },
];
const verify = quoteVerifier(segments);

describe("quote verification", () => {
  test("accepts a verbatim quote, ignoring case, punctuation and whitespace", () => {
    assert.deepEqual(verify("  i'll UPDATE the marketing   campaign by November 18 "), {
      segmentId: "s2",
      quote: "i'll UPDATE the marketing   campaign by November 18",
    });
    assert.equal(verify("We’re changing the Project Atlas launch date")?.segmentId, "s1");
  });

  test("accepts the 'Speaker: ' prefix the model echoes from its prompt, and stores the quote without it", () => {
    // Real model output from the Project Atlas replanning meeting.
    assert.deepEqual(verify("Priya: I'll update the marketing campaign by November 18."), {
      segmentId: "s2",
      quote: "I'll update the marketing campaign by November 18.",
    });
    assert.equal(
      verify("Sam: We're changing the Project Atlas launch date from November 20 to December 15, 2026.")?.segmentId,
      "s1",
    );
    assert.equal(verify("[10:32] Ana: The landing page needs more testing")?.segmentId, "s3");
  });

  test("rejects a prefix naming the wrong speaker", () => {
    assert.equal(verify("Ana: I'll update the marketing campaign by November 18."), null);
    assert.equal(verify("Nobody: I'll update the marketing campaign by November 18."), null);
  });

  test("accepts ellipsis-joined fragments only in order within one segment", () => {
    assert.equal(verify("We're changing the Project Atlas launch date ... to December 15, 2026")?.segmentId, "s1");
    assert.equal(verify("to December 15, 2026 … We're changing the Project Atlas"), null);
    assert.equal(verify("We're changing the Project Atlas ... by November 18"), null, "fragments from different segments");
  });

  test("rejects unrelated, paraphrased, empty and cross-segment quotes", () => {
    assert.equal(verify("We will launch on January 5"), null);
    assert.equal(verify("Priya will update the marketing campaign"), null);
    assert.equal(verify(""), null);
    assert.equal(verify("Sam:"), null);
    assert.equal(verify("November 18. The landing page needs more testing"), null);
  });
});
