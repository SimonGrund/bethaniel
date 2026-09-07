// The precision pass is a second, narrower audit of proposed corrections —
// see prompts.ts's buildPrecisionPassPrompt and reviewResilience.ts's
// applyPrecisionPass. Its output format is deliberately identical to the
// main reviewer's (index/confidence/reason JSONL) so it reuses
// parseReviewScores unchanged; these tests confirm that contract holds and
// that the prompt actually asks the narrower question it's meant to.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPrecisionPassPrompt } from "../src/prompts.ts";
import { parseReviewScores } from "../src/llm.ts";
import { applyPrecisionPass } from "../src/reviewResilience.ts";
import type { Correction } from "../src/types.ts";

test("buildPrecisionPassPrompt asks whether a fix was needed, not whether it's well-formed", () => {
  const p = buildPrecisionPassPrompt();
  assert.match(p, /original text actually needed fixing at all/i);
  assert.match(p, /unforced rewording/i);
  assert.match(p, /unwanted punctuation/i);
  assert.match(p, /wording change/i);
  assert.match(p, /not.*your job|not re-score/i);
});

test("buildPrecisionPassPrompt's output format is parseable by the shared review-score parser", () => {
  const p = buildPrecisionPassPrompt();
  const jsonlLine = /\{"index":\s*\d+,\s*"confidence":\s*\d,\s*"reason":\s*"[^"]+"\}/;
  assert.match(p, jsonlLine, "prompt must demonstrate the exact JSONL shape parseReviewScores expects");

  const sampleOutput = [
    '{"index": 0, "confidence": 5, "reason": "Original had a real typo"}',
    '{"index": 1, "confidence": 1, "reason": "Original was already correct"}',
  ].join("\n");
  const scores = parseReviewScores(sampleOutput);
  assert.equal(scores.get(0)?.confidence, 5);
  assert.equal(scores.get(1)?.confidence, 1);
});

test("buildPrecisionPassPrompt includes the manuscript language block when given one", () => {
  const p = buildPrecisionPassPrompt(undefined, "da");
  assert.match(p, /MANUSCRIPT LANGUAGE: Danish/);
});

test("buildPrecisionPassPrompt includes the style guide when given one", () => {
  const p = buildPrecisionPassPrompt("Character names: Wren, Constance.");
  assert.match(p, /Wren, Constance/);
});

// ── Deterministic corrections survive the precision pass ──
//
// Regression: the pass deleted anything it scored below threshold, including
// Hunspell and LanguageTool findings. Measured on the German stress fixture,
// that cost misspelling recall 68% -> 30% and comma recall 68% -> 5% — it was
// removing roughly four sound corrections for every unsound one. A dictionary
// is not an opinion the model gets to out-vote, so these are kept and flagged.

test("applyPrecisionPass: a doubted spell-check fix is kept and flagged, not dropped", () => {
  const cs: Correction[] = [
    { original: "recieve", corrected: "receive", reason: "spell-check" },
  ];
  const scores = new Map([[0, { confidence: 1, reason: "unnecessary" }]]);
  const r = applyPrecisionPass(cs, [scores], 3);
  assert.equal(r.removed.length, 0);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].flagged, true);
  assert.equal(r.spared, 1);
  assert.ok(r.kept[0].reviewReason);
});

test("applyPrecisionPass: LanguageTool, retext and dialect findings are spared too", () => {
  const cs: Correction[] = [
    { original: "a apple", corrected: "an apple", reason: "retext:indefinite-article" },
    { original: "haus", corrected: "Haus", reason: "grammar:typos" },
    { original: "colour", corrected: "color", reason: "dialect" },
  ];
  const scores = new Map([
    [0, { confidence: 1, reason: "x" }],
    [1, { confidence: 2, reason: "x" }],
    [2, { confidence: 1, reason: "x" }],
  ]);
  const r = applyPrecisionPass(cs, [scores], 3);
  assert.equal(r.removed.length, 0);
  assert.equal(r.spared, 3);
  for (const k of r.kept) assert.equal(k.flagged, true);
});

test("applyPrecisionPass: an LLM-authored correction is still dropped", () => {
  const cs: Correction[] = [
    { original: "the old house", corrected: "the ancient house" },
    { original: "she walked", corrected: "she strode", reason: "reads better" },
  ];
  const scores = new Map([
    [0, { confidence: 1, reason: "unforced rewording" }],
    [1, { confidence: 1, reason: "unforced rewording" }],
  ]);
  const r = applyPrecisionPass(cs, [scores], 3);
  assert.equal(r.removed.length, 2);
  assert.equal(r.kept.length, 0);
  assert.equal(r.spared, 0);
});

test("applyPrecisionPass: a well-scored deterministic correction is not flagged", () => {
  const cs: Correction[] = [
    { original: "recieve", corrected: "receive", reason: "spell-check" },
  ];
  const scores = new Map([[0, { confidence: 5, reason: "real typo" }]]);
  const r = applyPrecisionPass(cs, [scores], 3);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].flagged, undefined);
  assert.equal(r.spared, 0);
});

// A downgraded spell correction is still the dictionary talking. spellcheck.ts
// tags an unrecognised word whose suggestion it will not vouch for as
// "spell-check-uncommon"; if that tag falls outside isDeterministicCorrection,
// the downgrade quietly hands the correction back to the precision pass to
// delete — undoing this guard for exactly the words it was written to protect.
test("applyPrecisionPass: a DOWNGRADED spell correction is spared, not dropped", () => {
  const cs: Correction[] = [
    { original: "Werkzueg", corrected: "Werkzeug", reason: "spell-check-uncommon" },
    { original: "walked slowly", corrected: "ambled", reason: "tightens the prose" },
  ];
  const scores = new Map([
    [0, { confidence: 1, reason: "the original may be a coined compound" }],
    [1, { confidence: 1, reason: "unforced rewording" }],
  ]);

  const { kept, removed, spared } = applyPrecisionPass(cs, [scores], 3);

  assert.equal(spared, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].original, "Werkzueg");
  assert.equal(kept[0].flagged, true);
  // The model-authored rewrite is still dropped — that is what the pass is for.
  assert.equal(removed.length, 1);
  assert.equal(removed[0].corrected, "ambled");
});

// Deleting and doubting are different acts. Below the delete threshold a
// correction is removed; between it and the reviewer's flag threshold it
// survives wearing the doubt, so the noise a lower delete cut lets through
// reaches the author as a suggestion rather than a finding. Measured on the
// four stress fixtures, moving the delete cut from 3 to 2 took Baby Betty's
// recall 54% -> 58% and clean-text flags 12 -> 20, but 18 of those 20 arrive
// marked: unmarked noise on clean text stayed at 2 either way.
test("applyPrecisionPass: a doubted correction above the delete cut is flagged, not dropped", () => {
  const cs: Correction[] = [
    { original: "a b", corrected: "a c", reason: "worth a look" },   // conf 2 — doubted
    { original: "d e", corrected: "d f", reason: "unforced" },        // conf 1 — deleted
    { original: "g h", corrected: "g i", reason: "solid" },           // conf 5 — untouched
  ];
  const scores = new Map([
    [0, { confidence: 2, reason: "may not need fixing" }],
    [1, { confidence: 1, reason: "unforced rewording" }],
    [2, { confidence: 5, reason: "clear error" }],
  ]);

  // delete below 2, flag below 3
  const { kept, removed, doubted } = applyPrecisionPass(cs, [scores], 2, 3);

  assert.equal(removed.length, 1);
  assert.equal(removed[0].corrected, "d f");
  assert.equal(kept.length, 2);
  assert.equal(doubted, 1);

  const survivor = kept.find((c) => c.corrected === "a c")!;
  assert.equal(survivor.flagged, true);
  assert.match(survivor.reviewReason!, /may not need fixing/i);

  // The confident one is left alone entirely.
  const confident = kept.find((c) => c.corrected === "g i")!;
  assert.equal(confident.flagged, undefined);
});

test("applyPrecisionPass: flagBelow defaults to the delete threshold, flagging nothing extra", () => {
  const cs: Correction[] = [{ original: "a b", corrected: "a c", reason: "x" }];
  const scores = new Map([[0, { confidence: 4, reason: "fine" }]]);
  const { kept, doubted } = applyPrecisionPass(cs, [scores], 3);
  assert.equal(doubted, 0);
  assert.equal(kept[0].flagged, undefined);
});
