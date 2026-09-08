// A wide "original" span costs the author precision: to fix one comma they must
// accept or reject a whole rewritten sentence. Cloud-served models produce these
// far more than local ones (median 15 words vs 3 on the same fixture and the same
// model), so the span is narrowed deterministically here rather than by asking
// the prompt more firmly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { narrowCorrectionSpans } from "../src/correctionHygiene.ts";
import type { Correction } from "../src/types.ts";

const c = (original: string, corrected: string): Correction => ({
  original,
  corrected,
});

test("narrows a sentence rewrite down to the words that actually changed", () => {
  const text =
    "She opened the door. Rain tapped against the front window in a slow patient rhythm and the bell had not rung. She waited.";
  const r = narrowCorrectionSpans(text, [
    c(
      "Rain tapped against the front window in a slow patient rhythm and the bell had not rung.",
      "Rain tapped against the front window in a slow, patient rhythm, and the bell had not rung.",
    ),
  ]);
  // Two independent comma insertions become two corrections, not one rewrite.
  assert.equal(r.kept.length, 2);
  for (const k of r.kept) {
    assert.ok(
      k.original.split(/\s+/).length <= 6,
      `span still wide: ${k.original}`,
    );
    assert.ok(text.includes(k.original), `not verbatim: ${k.original}`);
    assert.notEqual(k.original, k.corrected);
  }
  assert.equal(r.split, 1);
});

test("applying the narrowed pieces reproduces the original rewrite", () => {
  const text = "the room was cold and dark and she left";
  const wide = c(
    "the room was cold and dark and she left",
    "the room was cold, and dark, and she left",
  );
  const r = narrowCorrectionSpans(text, [wide]);
  let out = text;
  for (const k of r.kept) out = out.replace(k.original, k.corrected);
  assert.equal(out, wide.corrected);
});

test("a correction that is already minimal is left untouched", () => {
  const text = "she put it in her hand and it was warm";
  const one = c("hand and it", "hand, and it");
  const r = narrowCorrectionSpans(text, [one]);
  assert.deepEqual(r.kept, [one]);
  assert.equal(r.narrowed, 0);
});

test("keeps enough context to stay unique when the short span repeats", () => {
  const text = "the cat sat and the cat sat and waited by the door";
  const r = narrowCorrectionSpans(text, [
    c("the cat sat and waited by the door", "the cat sat and waited by the gate"),
  ]);
  for (const k of r.kept) {
    const occurrences = text.split(k.original).length - 1;
    assert.equal(occurrences, 1, `ambiguous span: ${k.original}`);
  }
});

test("never emits a span that is not verbatim in the text", () => {
  const text = "he walked slowly toward the light";
  const r = narrowCorrectionSpans(text, [
    c("walked slowly toward the light", "walked slowly towards the light"),
  ]);
  for (const k of r.kept) assert.ok(text.includes(k.original));
});

test("refuses to narrow when it would unbalance markdown markers", () => {
  const text = "and then *she wisphered softly and left* the room";
  const wide = c("*she wisphered softly and left*", "*she whispered softly and left*");
  const r = narrowCorrectionSpans(text, [wide]);
  for (const k of r.kept) {
    const stars = (s: string) => (s.match(/\*/g) ?? []).length;
    assert.equal(stars(k.original), stars(k.corrected));
  }
});

test("carries correction metadata onto every piece", () => {
  const text = "it was cold and dark and she left the house";
  const r = narrowCorrectionSpans(text, [
    {
      ...c(
        "it was cold and dark and she left",
        "it was cold, and dark, and she left",
      ),
      reason: "comma",
      preApproved: true,
      confidence: 4,
    },
  ]);
  // Two commas nine characters apart are one edit, not two — the assertion
  // here is that whatever pieces come out keep the metadata, not that it split.
  assert.ok(r.kept.length >= 1);
  assert.equal(r.narrowed, 1);
  for (const k of r.kept) {
    assert.equal(k.reason, "comma");
    assert.equal(k.preApproved, true);
    assert.equal(k.confidence, 4);
  }
});

test("leaves a correction alone when it cannot be split safely", () => {
  const text = "one two three four five six seven eight nine ten";
  // Wholesale replacement — no unchanged anchor to split on.
  const wide = c(
    "one two three four five six seven eight nine ten",
    "alpha beta gamma delta epsilon zeta eta theta iota kappa",
  );
  const r = narrowCorrectionSpans(text, [wide]);
  assert.deepEqual(r.kept, [wide]);
});

test("an empty input yields an empty result", () => {
  const r = narrowCorrectionSpans("some text", []);
  assert.deepEqual(r.kept, []);
  assert.equal(r.narrowed, 0);
  assert.equal(r.split, 0);
});
