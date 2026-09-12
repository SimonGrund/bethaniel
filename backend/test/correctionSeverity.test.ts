// Tests for classifyPublicationBlocking: objective/mechanical errors that
// change actual WORD content (copy edits, spelling, retext, grammar) should
// block publication; subjective line-edit/style suggestions, low-confidence
// dictionary hits on real words/compounds ("spell-check-uncommon"), and
// punctuation-only judgment calls (comma/semicolon/period, no word changed)
// should not — a full copy edit is the right place for those in bulk.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyPublicationBlocking,
  collectConsistentTerms,
  inDialogue,
  isPunctuationOnlyChange,
  fixesCommaSplice,
} from "../src/correctionSeverity.ts";
import type { Correction } from "../src/types.ts";

// ── fixesCommaSplice ──

test("fixesCommaSplice: comma → period is a comma splice, always", () => {
  assert.equal(
    fixesCommaSplice(
      "that looked like some official document, The Rule signet was stamped",
      "that looked like some official document. The Rule signet was stamped",
    ),
    true,
  );
});

test("fixesCommaSplice: period ↔ question mark swaps are NOT comma splices", () => {
  assert.equal(fixesCommaSplice("I have never seen you?", "I have never seen you."), false);
});

test("fixesCommaSplice: semicolon → comma is not a comma splice (no comma in the original)", () => {
  assert.equal(fixesCommaSplice("like that; and he could not", "like that, and he could not"), false);
});

test("fixesCommaSplice: an unrelated comma elsewhere doesn't false-positive when mark counts differ", () => {
  // Adds a comma rather than swapping one — different mark counts, so this
  // check (which only reasons about swaps) stays out of the way.
  assert.equal(fixesCommaSplice("Goodbye Tails.", "Goodbye, Tails."), false);
});

// ── isPunctuationOnlyChange ──

test("isPunctuationOnlyChange: a punctuation-mark swap with no word change", () => {
  assert.equal(isPunctuationOnlyChange("I have never seen you?", "I have never seen you."), true);
  assert.equal(isPunctuationOnlyChange("like that; and he", "like that, and he"), true);
  assert.equal(isPunctuationOnlyChange("Goodbye Tails.", "Goodbye, Tails."), true);
  assert.equal(isPunctuationOnlyChange("teeth-chattering", "teeth chattering"), true);
});

test("isPunctuationOnlyChange: a real word change is not punctuation-only", () => {
  assert.equal(isPunctuationOnlyChange("there has be a way", "there has to be a way"), false);
  assert.equal(isPunctuationOnlyChange("teh", "the"), false);
});

test("isPunctuationOnlyChange: a capitalization-only change is NOT punctuation-only (case-sensitive)", () => {
  assert.equal(isPunctuationOnlyChange("took his consciousness", "Took his consciousness"), false);
});

// ── classifyPublicationBlocking ──

test("combined-edit 'copy' correction with a real word change is blocking", () => {
  const c: Correction = { original: "teh", corrected: "the", editType: "copy", confidence: 5 };
  assert.equal(classifyPublicationBlocking(c, "combined_edit"), true);
  // Unscored, the same claim is a suggestion: nobody has backed it yet.
  assert.equal(classifyPublicationBlocking({ ...c, confidence: undefined }, "combined_edit"), false);
});

test("combined-edit 'copy' correction that's ONLY a punctuation swap is NOT blocking", () => {
  // The exact reported case: scattered "?"→"." swaps in a long passage with
  // no word content changed — a copy-edit-level polish call, not an
  // unambiguous publication blocker.
  const c: Correction = {
    original: "I have never seen you? They say you helped fight in the battle?",
    corrected: "I have never seen you. They say you helped fight in the battle.",
    editType: "copy",
  };
  assert.equal(classifyPublicationBlocking(c, "combined_edit"), false);
});

test("a comma splice fix stays blocking even though it's otherwise punctuation-only", () => {
  // Reported case: "...official document, The Rule signet was stamped..." —
  // a comma joining two independent clauses is a run-on sentence, an
  // objective grammar error, not a debatable style call like "?" vs ".".
  const c: Correction = {
    original: "official document, The Rule signet was stamped at the bottom",
    corrected: "official document. The Rule signet was stamped at the bottom",
    confidence: 5,
  };
  assert.equal(classifyPublicationBlocking(c, "proofread"), true);
  assert.equal(classifyPublicationBlocking({ ...c, reason: "grammar:comma-splice" }, "line_edit"), true);
});

test("a re-casing is never a blocker — the capitalisation of a term is the author's", () => {
  // On a real scan the model lower-cased an invented term ("Taking" →
  // "taking") a dozen times and re-cased every chapter heading; none of it
  // is a fault a reader would take for a typo.
  const c: Correction = {
    original: "took his consciousness",
    corrected: "Took his consciousness",
    editType: "copy",
  };
  assert.equal(classifyPublicationBlocking(c, "combined_edit"), false);
  assert.equal(
    classifyPublicationBlocking({ original: "colosseum", corrected: "Colosseum", reason: "spell-check" }, "proofread"),
    false,
  );
});

test("combined-edit 'line' corrections are never blocking, regardless of mode", () => {
  const c: Correction = {
    original: "He walked quickly",
    corrected: "He hurried",
    editType: "line",
  };
  assert.equal(classifyPublicationBlocking(c, "combined_edit"), false);
});

test("a single-mode proofread/copy_edit correction with no editType tag is blocking", () => {
  // Single-mode tasks never get a "kind"/editType tag (only combined_edit
  // prompts request one) — the task's own mode has to stand in, since its
  // prompt is scoped to objective errors just like a copy edit.
  const c: Correction = { original: "there has be a way", corrected: "there has to be a way", confidence: 4 };
  assert.equal(classifyPublicationBlocking(c, "proofread"), true);
  assert.equal(classifyPublicationBlocking(c, "copy_edit"), true);
});

test("a single-mode line_edit correction with no editType tag is NOT blocking", () => {
  const c: Correction = { original: "He walked quickly", corrected: "He hurried" };
  assert.equal(classifyPublicationBlocking(c, "line_edit"), false);
});

test("spell-check reason is blocking, regardless of mode", () => {
  const c: Correction = { original: "amd", corrected: "and", reason: "spell-check" };
  assert.equal(classifyPublicationBlocking(c, "line_edit"), true);
  assert.equal(classifyPublicationBlocking(c, "proofread"), true);
});

test("spell-check-uncommon (valid compound/inflection) is NOT blocking, even in an objective-scope mode", () => {
  // Regression: deterministic-checker corrections never carry an editType,
  // so a naive mode-based fallback ("no editType + proofread mode ⇒
  // blocking") would swallow this into blocking regardless of its reason.
  // e.g. "iron-clad" / "storages" — real words or plausible inflections a
  // dictionary doesn't enumerate, not clear typos like "amd" or "whe".
  const c: Correction = {
    original: "storages",
    corrected: "storage",
    reason: "spell-check-uncommon",
  };
  assert.equal(classifyPublicationBlocking(c, "line_edit"), false);
  assert.equal(classifyPublicationBlocking(c, "proofread"), false);
});

test("retext-sourced reasons are blocking (repeated words/phrases, spacing, etc.)", () => {
  assert.equal(
    classifyPublicationBlocking(
      {
        original: "in weeks in weeks",
        corrected: "in weeks",
        reason: "retext:repeated-phrase",
      },
      "line_edit",
    ),
    true,
  );
  assert.equal(
    classifyPublicationBlocking(
      {
        original: "streets.  Still",
        corrected: "streets. Still",
        reason: "retext:sentence-spacing",
      },
      "line_edit",
    ),
    true,
  );
});

test("grammar (LanguageTool): a reason that changes actual words is blocking", () => {
  const c: Correction = {
    original: "prison in world",
    corrected: "prison in the world",
    reason: "grammar:agreement",
  };
  assert.equal(classifyPublicationBlocking(c, "line_edit"), true);
});

test("grammar (LanguageTool): a punctuation-only reason is NOT blocking", () => {
  const c: Correction = {
    original: "like that; and he could not",
    corrected: "like that, and he could not",
    reason: "grammar:punctuation",
  };
  assert.equal(classifyPublicationBlocking(c, "line_edit"), false);
});

test("an unlabeled, unreasoned correction on a line_edit task defaults to non-blocking", () => {
  assert.equal(
    classifyPublicationBlocking({ original: "a", corrected: "b" }, "line_edit"),
    false,
  );
});

// ── What the real scan taught the rule ──
// Measured on a 32-chapter fantasy manuscript: 972 of 1,139 corrections
// were marked blocking, almost none deserved it. Each case below is one of
// the patterns that made up the noise, pinned so it stays out.

const BOOK = [
  "Abernathy Silverhand rode north. The Silverhand banner flew. A Silverhand never yields.",
  "Roak waited at the gate. Roak had always waited. Roak would wait again.",
].join("\n\n");
const terms = new Set(collectConsistentTerms([BOOK]));

test("LanguageTool splitting a name that is spelled the same way throughout is not a blocker", () => {
  const c: Correction = { original: "Abernathy Silverhand,", corrected: "Abernathy Silver hand,", reason: "grammar:typos", confidence: 5, precisionConfidence: 5 };
  assert.equal(classifyPublicationBlocking(c, "proofread", { consistentTerms: terms }), false);
  // The same hit on a word the manuscript does not vouch for still blocks.
  const d: Correction = { original: "Silverhnad", corrected: "Silverhand", reason: "grammar:typos", confidence: 5, precisionConfidence: 5 };
  assert.equal(classifyPublicationBlocking(d, "proofread", { consistentTerms: terms }), true);
});

test("the dictionary respelling a recurring name is not a blocker", () => {
  const c: Correction = { original: "Roak", corrected: "Road", reason: "spell-check", confidence: 5, precisionConfidence: 5 };
  assert.equal(classifyPublicationBlocking(c, "proofread", { consistentTerms: terms }), false);
});

test("a compound split or joined, or a diacritic added, is not a blocker", () => {
  for (const [original, corrected] of [
    ["woodchips", "wood chips"],
    ["for ever", "forever"],
    ["every-day-adventures", "everyday adventures"],
    ["naivete", "naïveté"],
  ]) {
    const c: Correction = { original, corrected, reason: "grammar:typos", confidence: 5, precisionConfidence: 5 };
    assert.equal(classifyPublicationBlocking(c, "proofread"), false, `${original} → ${corrected}`);
  }
});

test("inside speech nothing is a blocker but a doubled word", () => {
  const text = "She sighed. “Cause he’s gonna go, ain’t he,” she said. He he nodded.";
  assert.equal(inDialogue(text, "Cause he’s"), true);
  assert.equal(inDialogue(text, "He he nodded"), false);
  const c: Correction = { original: "“Cause he’s", corrected: "“Because he’s", reason: "grammar:grammar", confidence: 5, precisionConfidence: 5 };
  assert.equal(classifyPublicationBlocking(c, "proofread", { text }), false);
  const g: Correction = { original: "gonna", corrected: "going to", reason: "spell-check", confidence: 5 };
  assert.equal(classifyPublicationBlocking(g, "proofread", { text }), false);
  const dbl: Correction = { original: "He he nodded", corrected: "He nodded", reason: "retext:repeated-words" };
  assert.equal(classifyPublicationBlocking(dbl, "proofread", { text }), true);
});

test("a spell hit the second check scored down is not a blocker; one it backed is", () => {
  const doubted: Correction = { original: "stablehands", corrected: "stagehands", reason: "spell-check", confidence: 5, precisionConfidence: 1 };
  assert.equal(classifyPublicationBlocking(doubted, "proofread"), false);
  const backed: Correction = { original: "Bootsteps", corrected: "Footsteps", reason: "spell-check", confidence: 5, precisionConfidence: 5 };
  assert.equal(classifyPublicationBlocking(backed, "proofread"), true);
});

test("LanguageTool style, collocation and redundancy hits are suggestions, not blockers", () => {
  for (const reason of ["grammar:style", "grammar:collocations", "grammar:redundancy", "grammar:repetitions_style", "grammar:casing", "grammar:british_english"]) {
    const c: Correction = { original: "revealing several soldiers", corrected: "revealing many soldiers", reason, confidence: 5, precisionConfidence: 5 };
    assert.equal(classifyPublicationBlocking(c, "proofread"), false, reason);
  }
});

test("a model rewrite or word swap is not a blocker; a respelling, an apostrophe or a dropped word is", () => {
  const sure = { confidence: 5, precisionConfidence: 5 };
  for (const [original, corrected] of [
    ["room", "door"],
    ["Part of her wished it.", "Part of her wished otherwise."],
    ["set into motion,", "set himself into motion,"],
    ["Chapter thirty-one", "Chapter Thirty-One"],
  ]) {
    assert.equal(classifyPublicationBlocking({ original, corrected, ...sure }, "proofread"), false, `${original} → ${corrected}`);
  }
  for (const [original, corrected] of [
    ["man’s voice rung", "man's voice rang"],
    ["Keenans", "Keenan's"],
    ["there has be a way", "there has to be a way"],
    ["teh", "the"],
    ["the the harbour", "the harbour"],
  ]) {
    assert.equal(classifyPublicationBlocking({ original, corrected, ...sure }, "proofread"), true, `${original} → ${corrected}`);
  }
});

test("a model correction the scores do not back is not a blocker, however mechanical", () => {
  const c: Correction = { original: "gushes of sand", corrected: "gusts of sand", confidence: 5, precisionConfidence: 2 };
  assert.equal(classifyPublicationBlocking(c, "proofread"), false);
});
