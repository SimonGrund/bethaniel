// ── Which suggestions the deck offers, and how far through them you are ──
//
// The author reported the 10%-certainty suggestions as consistently wrong.
// Counted over 2,226 corrections from real runs on two books, that bucket —
// reviewer score 1 — was 61% of the whole deck, and six of six sampled were
// plainly wrong: `kneeled → keeled`, `single-handedly → single-offhandedly`,
// `drylands → dry lands` (the author's own coinage). So it is held back.
//
// The line is drawn at the reviewer's score, not at `flagKindOf`'s "doubted",
// which also covers score 2 — and score 2 displays as 45% and reads like a
// coin flip: `the East` against `the east`, `woodsmoke` against `wood smoke`.
// Hiding a bucket that is right half the time would be a worse change than
// the one being fixed, so these tests pin both halves of that line.
//
// That held for a hosted reviewer. Measured on one real novel in October
// 2026, the small local reviewer's 2s and 3s were as wrong as its 1s, so a
// local run now holds back everything under 4 (the tests at the end).
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countRejected,
  heldBack,
  optionalPolish,
  progressOf,
  reviewerKindOf,
  reviewerRejected,
  REVIEWER_REJECTED_SCORE,
} from "../../frontend/src/deckProgress.ts";
import { certaintyPercent, flagKindOf } from "../../frontend/src/types.ts";

// ── Which bucket is held back ──

test("a reviewer's lowest score is held back", () => {
  assert.equal(reviewerRejected({ confidence: 1 }), true);
});

test("the bucket that reads as a coin flip is not", () => {
  // flagKindOf calls score 2 "doubted" as well. It displays 45%, and the
  // author asked about the 10% ones.
  const two = { confidence: 2, flagged: true };
  assert.equal(flagKindOf(two), "doubted");
  assert.equal(certaintyPercent(two), 45);
  assert.equal(reviewerRejected(two), false);
});

test("everything a reviewer stood behind is offered", () => {
  for (const confidence of [2, 3, 4, 5]) {
    assert.equal(reviewerRejected({ confidence }), false, `score ${confidence}`);
  }
});

test("a correction no reviewer scored is offered", () => {
  // No score is not a low score: withholding these would hide work nobody
  // ever judged, which is the opposite of what the reviewer's 1 means.
  assert.equal(reviewerRejected({}), false);
  assert.equal(reviewerRejected({ confidence: undefined }), false);
});

test("the held-back bucket is the one that displays as 10%", () => {
  // Why the SCORE is the test and the displayed percentage is not: the same
  // bucket shows 18% on the few older results where the precision pass
  // (since removed) disagreed with the reviewer, and both are a reviewer's
  // "this is wrong".
  assert.equal(certaintyPercent({ confidence: REVIEWER_REJECTED_SCORE }), 10);
  assert.equal(
    certaintyPercent({ confidence: REVIEWER_REJECTED_SCORE, precisionConfidence: 5 }),
    18,
  );
  assert.equal(reviewerRejected({ confidence: REVIEWER_REJECTED_SCORE }), true);
});

test("counting what would be held back", () => {
  const cs = [
    { confidence: 1 },
    { confidence: 1 },
    { confidence: 5 },
    { confidence: 2 },
    {},
  ];
  // A hosted run holds back the 1s and, since October 2026, the 2s.
  assert.equal(countRejected(cs), 3);
  assert.equal(countRejected([]), 0);
});

// ── How far through ──

test("the ends are exact", () => {
  assert.deepEqual(progressOf(0, 400), { decided: 0, total: 400, percent: 0 });
  assert.deepEqual(progressOf(400, 400), { decided: 400, total: 400, percent: 100 });
});

test("one card still in hand is never 100%", () => {
  // 399 of 400 rounds to 100, and a bar reading 100% with a card left is the
  // one number an author would call a lie.
  assert.equal(progressOf(399, 400).percent, 99);
  assert.equal(progressOf(1999, 2000).percent, 99);
});

test("real work done is never 0%", () => {
  // 1 of 400 rounds to 0, which reads as "nothing has happened" to someone
  // who just answered a card.
  assert.equal(progressOf(1, 400).percent, 1);
  assert.equal(progressOf(1, 5000).percent, 1);
});

test("nothing to decide is finished, not nothing", () => {
  // A chapter with no suggestions is done, and 0/0 must be neither NaN nor a
  // bar sitting empty on a chapter there is nothing to do in.
  assert.deepEqual(progressOf(0, 0), { decided: 0, total: 0, percent: 100 });
});

test("ordinary fractions round the usual way", () => {
  assert.equal(progressOf(1, 2).percent, 50);
  assert.equal(progressOf(1, 3).percent, 33);
  assert.equal(progressOf(2, 3).percent, 67);
  assert.equal(progressOf(12, 31).percent, 39);
});

test("nonsense in cannot produce nonsense out", () => {
  // The deck subtracts one count from another to get `decided`, and a stale
  // render can hand this more decided than total.
  assert.equal(progressOf(500, 400).percent, 100);
  assert.equal(progressOf(-3, 400).percent, 0);
  assert.equal(progressOf(5, -1).percent, 100);
});

// ── Whose reviewer it was (measured 12 October 2026, deckProgress.ts) ──

test("the reviewer's kind is read off the task's model", () => {
  assert.equal(reviewerKindOf("Qwen3.5-4B-Q4_K_M.gguf"), "local");
  assert.equal(reviewerKindOf("custom:gguf"), "local");
  assert.equal(reviewerKindOf("custom:bethaniel-cloud"), "hosted");
  assert.equal(reviewerKindOf("custom:deepseek-chat"), "hosted");
  // Older results without a model keep the old rule.
  assert.equal(reviewerKindOf(undefined), "hosted");
});

test("a local run holds back everything under 4; a hosted one its 1s and 2s", () => {
  for (const score of [1, 2, 3]) assert.equal(heldBack({ confidence: score }, "local"), true);
  for (const score of [4, 5]) assert.equal(heldBack({ confidence: score }, "local"), false);
  for (const score of [1, 2]) assert.equal(heldBack({ confidence: score }, "hosted"), true);
  for (const score of [3, 4, 5]) assert.equal(heldBack({ confidence: score }, "hosted"), false);
  // Never scored: not a verdict, so not held back.
  assert.equal(heldBack({}, "local"), false);
  assert.equal(countRejected([{ confidence: 1 }, { confidence: 2 }, { confidence: 3 }, { confidence: 4 }], "local"), 3);
  assert.equal(countRejected([{ confidence: 1 }, { confidence: 2 }, { confidence: 3 }, { confidence: 4 }]), 2);
});

test("a local run holds back its line edits whatever they scored; a hosted one does not", () => {
  // Re-measured on the same novel: Local Betty's 4-5 line edits were 3 right,
  // 3 neutral, 10 wrong.
  assert.equal(heldBack({ confidence: 5, editType: "line" }, "local"), true);
  assert.equal(heldBack({ editType: "line" }, "local"), true);
  assert.equal(heldBack({ confidence: 5, editType: "copy" }, "local"), false);
  assert.equal(heldBack({ confidence: 5, editType: "line" }, "hosted"), false);
});

test("a hosted reviewer's 3s are optional polish; its 2s are held back; a local run has none", () => {
  assert.equal(optionalPolish({ confidence: 2 }, "hosted"), false);
  assert.equal(optionalPolish({ confidence: 3 }, "hosted"), true);
  assert.equal(optionalPolish({ confidence: 4 }, "hosted"), false);
  assert.equal(optionalPolish({ confidence: 1 }, "hosted"), false);
  assert.equal(optionalPolish({ confidence: 2 }, "local"), false);
});
