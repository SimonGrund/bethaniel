// The guarantee: a deterministic finding never disappears without trace.
//
// The publication readthrough is the last check before printing, so a finding
// the author never sees is worse than a noisy one. Every path that can discard
// a correction either keeps it or files it in `skipped[]`, which the review
// screen renders (ReviewExport.tsx) — except dropNoOpCorrections, which ran
// over the whole chapter (queue.ts:3028) and deleted outright.

import { test } from "node:test";
import assert from "node:assert/strict";

import { dropNoOpCorrections } from "../src/correctionHygiene.ts";

test("a withheld-guess finding survives the no-op filter", () => {
  // "report the word, withhold the guess" produces corrected === original.
  const kept = dropNoOpCorrections([
    {
      original: "barque",
      corrected: "barque",
      reason: "spell-check-unknown",
    } as never,
  ]);
  assert.equal(kept.length, 1, "the author must still see this word");
});

test("every deterministic reason survives it", () => {
  const reasons = [
    "spell-check",
    "spell-check-uncommon",
    "spell-check-unknown",
    "dialect",
    "quote-style",
    "grammar:COMMA_PARENTHESIS_WHITESPACE",
    "retext:doubled-word",
    "confusable:form-det",
  ];
  for (const reason of reasons) {
    const kept = dropNoOpCorrections([
      { original: "a", corrected: "a", reason } as never,
    ]);
    assert.equal(kept.length, 1, `${reason} was dropped`);
  }
});

test("an editor's genuine no-op is still dropped", () => {
  // A model returning the text unchanged is noise, not a finding.
  assert.deepEqual(
    dropNoOpCorrections([{ original: "a", corrected: "a" } as never]),
    [],
  );
});

test("an editor's quote-style-only change is still dropped", () => {
  assert.deepEqual(
    dropNoOpCorrections([
      { original: '"a"', corrected: "“a”" } as never,
    ]),
    [],
  );
});
