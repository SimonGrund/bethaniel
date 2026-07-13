// Tests for the second-pass (thorough mode) anchor check: pass-2 corrections
// must be locatable in the TRUE original text (the frontend's applyAccepted
// contract) or be flagged for manual review.

import { test } from "node:test";
import assert from "node:assert/strict";

import { flagUnanchoredCorrections } from "../src/reviewResilience.ts";
import type { Correction } from "../src/types.ts";

const original = "I went to teh store. The dog barked loudly.";

test("anchored pass-2 corrections are left untouched", () => {
  const cs: Correction[] = [
    { original: "barked loudly", corrected: "barked", pass: 2 },
  ];
  const flagged = flagUnanchoredCorrections(original, cs);
  assert.equal(flagged, 0);
  assert.equal(cs[0].flagged, undefined);
});

test("a span that only exists in pass-1 output is flagged with the overlap reason", () => {
  // Pass 1 changed "teh" → "the"; pass 2 then edited the corrected phrase.
  const cs: Correction[] = [
    { original: "to the store", corrected: "into the store", pass: 2 },
  ];
  const flagged = flagUnanchoredCorrections(original, cs);
  assert.equal(flagged, 1);
  assert.equal(cs[0].flagged, true);
  assert.match(cs[0].reviewReason ?? "", /overlaps a first-pass change/);
});

test("an existing review reason is preserved, overlap note appended", () => {
  const cs: Correction[] = [
    {
      original: "to the store",
      corrected: "into the store",
      flagged: true,
      reviewReason: "low confidence",
      pass: 2,
    },
  ];
  flagUnanchoredCorrections(original, cs);
  assert.match(cs[0].reviewReason ?? "", /^low confidence; .*overlaps/);
});
