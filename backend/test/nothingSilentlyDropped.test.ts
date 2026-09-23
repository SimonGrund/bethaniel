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

test("every deterministic producer's real finding survives it", () => {
  // A finding that CHANGES something is never dropped, whoever produced it.
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
      { original: "a", corrected: "b", reason } as never,
    ]);
    assert.equal(kept.length, 1, `${reason} was dropped`);
  }
});

test("a deterministic no-op goes, EXCEPT a withheld guess", () => {
  // The two cases differ, which is why the filter does not simply keep
  // anything deterministic. A quote-style correction that changes nothing is
  // a bug — it would show the author an empty change. A withheld guess that
  // changes nothing is the finding itself: the word is what is being
  // reported, and there is deliberately no replacement.
  for (const reason of ["quote-style", "dialect", "retext:doubled-word"]) {
    assert.deepEqual(
      dropNoOpCorrections([{ original: "a", corrected: "a", reason } as never]),
      [],
      `${reason} no-op should go`,
    );
  }
  assert.equal(
    dropNoOpCorrections([
      { original: "barque", corrected: "barque", reason: "spell-check-unknown" } as never,
    ]).length,
    1,
    "the author must still see the word",
  );
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

// ── The one place a finding SHOULD be withdrawn ──

test("a withheld guess on the author's own word is dropped, and listed", async () => {
  // The lexicon is the author saying "this is my word". Telling them
  // afterwards that no dictionary recognises it is the noise the list exists
  // to stop. It is handed back with the term, so the review screen lists it
  // as left alone rather than making it vanish.
  const { gateProtectedTerms } = await import("../src/lexicon.ts");
  const res = gateProtectedTerms(
    [
      {
        original: "warhammer",
        corrected: "warhammer",
        reason: "spell-check-unknown",
      } as never,
    ],
    { words: ["warhammer"], phrases: [] },
  );
  assert.equal(res.kept.length, 0);
  assert.equal(res.dropped.length, 1, "listed, not vanished");
  assert.equal(res.dropped[0].term, "warhammer");
});

test("a withheld guess on a word the author has NOT vouched for survives", async () => {
  const { gateProtectedTerms } = await import("../src/lexicon.ts");
  const res = gateProtectedTerms(
    [
      {
        original: "barque",
        corrected: "barque",
        reason: "spell-check-unknown",
      } as never,
    ],
    { words: ["warhammer"], phrases: [] },
  );
  assert.equal(res.kept.length, 1);
});
