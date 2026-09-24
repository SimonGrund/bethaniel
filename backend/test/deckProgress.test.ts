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
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countRejected,
  progressOf,
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
  // bucket shows 18% on the few where the second check disagrees with the
  // reviewer, and both are a reviewer's "this is wrong".
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
  assert.equal(countRejected(cs), 2);
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
