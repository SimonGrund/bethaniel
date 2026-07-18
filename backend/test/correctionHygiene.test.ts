// Tests for quote hygiene and export-time auto-repair. The scenarios are
// taken verbatim from real corrections stored in a user's task database:
//  - the model re-quoting curly-quoted dialogue with straight quotes,
//    splicing “"…"” pairs into the export;
//  - two overlapping corrections splicing "the studentss" — a misspelling
//    the export check could not pin on a single accepted correction.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dominantQuoteStyle,
  sanitizeQuoteCorrections,
  collapseIntroducedQuotePairs,
  collapseIntroducedPunctuationPairs,
  foldContainedCorrections,
  revertSuspectRuns,
} from "../src/correctionHygiene.ts";
import { applyCorrections } from "../src/llm.ts";

// ── dominantQuoteStyle ──

test("dominant style: curly manuscript", () => {
  assert.equal(dominantQuoteStyle("“Hello,” she said. “Go.”"), "curly");
});

test("dominant style: straight manuscript", () => {
  assert.equal(dominantQuoteStyle('"Hello," she said. "Go."'), "straight");
});

// ── sanitizeQuoteCorrections ──

test("drops a correction that only re-quotes existing curly dialogue", () => {
  // Real case: text has “We can try.” — the model emitted
  // original 'We can try.' → corrected 'We can try."'
  const text = "“We can try.” Bria nodded.";
  const { kept, dropped } = sanitizeQuoteCorrections(text, [
    { original: "We can try.", corrected: 'We can try."' },
  ]);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test("drops same-style duplicate closing quote", () => {
  // Real case: '…go,' → '…go,”' where the text already has ”
  const text = "“Let me and my mother go,” she pleaded.";
  const { kept, dropped } = sanitizeQuoteCorrections(text, [
    { original: "Let me and my mother go,", corrected: "Let me and my mother go,”" },
  ]);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test("strips duplicated edge quotes but keeps a real fix", () => {
  // The model wraps the span in straight quotes AND fixes a word.
  const text = "“Give it a few ours, and you might change your mind,” he said.";
  const { kept, dropped } = sanitizeQuoteCorrections(text, [
    {
      original: "Give it a few ours, and you might change your mind,",
      corrected: '"Give it a few hours, and you might change your mind,"',
    },
  ]);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(
    kept[0].corrected,
    "Give it a few hours, and you might change your mind,",
  );
});

test("converts genuinely added quotes to the manuscript's curly style", () => {
  // Dialogue truly missing quotes; the model adds straight ones. The
  // manuscript is curly-dominant, so the added quotes must be curly.
  const text =
    "“Fourteen are ready,” Kindra said.\n\nSure. We will send both of them.\n\n“Good,” Bria replied.";
  const { kept, dropped } = sanitizeQuoteCorrections(text, [
    {
      original: "Sure. We will send both of them.",
      corrected: '"Sure. We will send both of them."',
    },
  ]);
  assert.equal(dropped.length, 0);
  assert.equal(kept[0].corrected, "“Sure. We will send both of them.”");
});

test("leaves corrections without quote changes untouched", () => {
  const text = "He trusted no-one, not even his mom.";
  const cs = [{ original: "no-one", corrected: "no one" }];
  const { kept, dropped, adjusted } = sanitizeQuoteCorrections(text, cs);
  assert.equal(dropped.length, 0);
  assert.equal(adjusted, 0);
  assert.deepEqual(kept, cs);
});

// ── collapseIntroducedQuotePairs ──

test("collapses introduced mixed and doubled pairs to the dominant style", () => {
  const before = "“Watch it,” he said. “And untie me now?”";
  const after = "““Watch it,\"” he said. \"“And untie me now?\"”";
  const { text, fixes } = collapseIntroducedQuotePairs(before, after);
  assert.equal(text, before);
  assert.equal(fixes.length, 4);
});

test("leaves pre-existing doubled quotes and directional pairs alone", () => {
  const before = 'He typed ""quoted"" on purpose. An empty “” pair.';
  const { text, fixes } = collapseIntroducedQuotePairs(before, before);
  assert.equal(text, before);
  assert.equal(fixes.length, 0);
});

// ── revertSuspectRuns ──

test("reverts the real studentss splice to the original wording", () => {
  const before =
    "Karim had sent most of the students, soldiers and guards–and even the emissaries—off the island.";
  // "the student" → "the students" spliced into "the students," plus a
  // legitimate dash fix from an overlapping correction.
  const after =
    "Karim had sent most of the studentss, soldiers and guards—and even the emissaries—off the island.";
  const { text, reverted } = revertSuspectRuns(before, after, ["studentss"]);
  assert.deepEqual(reverted, ["studentss"]);
  assert.ok(text.includes("most of the students, soldiers"));
  assert.ok(!text.includes("studentss"));
  // The unrelated dash fix survives.
  assert.ok(text.includes("guards—and"));
});

test("revert with no suspects is a no-op", () => {
  const { text, reverted } = revertSuspectRuns("a b c", "a B c", []);
  assert.equal(text, "a B c");
  assert.equal(reverted.length, 0);
});

// ── foldContainedCorrections ──
// Real case: combined_edit produced a sentence-level line edit AND a
// contained word fix ("knifes"→"knives"). The word fix applied first and the
// rewrite was then skipped as "not found (collision with nearby edit)".

const KNIFES_TEXT =
  "Bria and Kindra stood ready; Kindra with a sword and shield, Bria with her two knifes and her enhanced speed and strength. " +
  "Her heart beat fast and the knifes were in her hands before she even noticed it.";
const KNIFES_REWRITE_1 = {
  original:
    "Bria and Kindra stood ready; Kindra with a sword and shield, Bria with her two knifes and her enhanced speed and strength.",
  corrected:
    "Bria and Kindra stood ready: Kindra with a sword and shield, Bria with her two knives and her enhanced speed and strength.",
};
const KNIFES_REWRITE_2 = {
  original:
    "Her heart beat fast and the knifes were in her hands before she even noticed it.",
  corrected:
    "Her heart beat fast, and the knives were in her hands before she even noticed.",
};

test("fold: drops a word fix fully covered by sentence rewrites", () => {
  const { kept, dropped } = foldContainedCorrections(KNIFES_TEXT, [
    KNIFES_REWRITE_1,
    KNIFES_REWRITE_2,
    { original: "knifes", corrected: "knives" },
  ]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].original, "knifes");
  assert.equal(kept.length, 2);
  // The rewrites already contain the fix — corrected text unchanged.
  assert.equal(kept[0].corrected, KNIFES_REWRITE_1.corrected);
  assert.equal(kept[1].corrected, KNIFES_REWRITE_2.corrected);
});

test("fold: merges the fix into a rewrite that missed it", () => {
  const text = "He took the knifes away before dinner.";
  const { kept, dropped } = foldContainedCorrections(text, [
    {
      original: "He took the knifes away before dinner.",
      corrected: "He took the knifes away well before dinner.",
    },
    { original: "knifes", corrected: "knives" },
  ]);
  assert.equal(dropped.length, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].corrected, "He took the knives away well before dinner.");
});

test("fold: keeps a word fix that also occurs outside the rewrite", () => {
  const text =
    "The knifes gleamed in the light. She hid the knifes under the floorboard.";
  const { kept, dropped } = foldContainedCorrections(text, [
    {
      original: "The knifes gleamed in the light.",
      corrected: "The knives gleamed in the lamplight.",
    },
    { original: "knifes", corrected: "knives" },
  ]);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 2);
});

test("fold: word-boundary safe — no folding inside larger words", () => {
  const text = "The rat scurried while the strategy unfolded.";
  const { kept, dropped } = foldContainedCorrections(text, [
    {
      original: "The rat scurried while the strategy unfolded.",
      corrected: "The rat scurried away while the strategy unfolded.",
    },
    { original: "rat", corrected: "mouse" },
  ]);
  // "rat" occurs inside "strategy" as a substring but only the whole word
  // counts; folding must replace only the standalone "rat".
  assert.equal(dropped.length, 1);
  assert.equal(
    kept[0].corrected,
    "The mouse scurried away while the strategy unfolded.",
  );
});

// ── applyCorrections overlap resolution ──

test("apply: larger rewrite wins over a contained fix (old stored data)", () => {
  const [out, applied, skipped] = applyCorrections(KNIFES_TEXT, [
    { original: "knifes", corrected: "knives" },
    KNIFES_REWRITE_1,
    KNIFES_REWRITE_2,
  ]);
  assert.equal(
    out,
    KNIFES_REWRITE_1.corrected + " " + KNIFES_REWRITE_2.corrected,
  );
  assert.equal(applied.length, 2);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason ?? "", /overlaps a larger applied edit/);
});

test("apply: rival rewrites of the same sentence — one applies, honest reason", () => {
  const text = "The fighters fell backwards, stumbling over their comrades.";
  const [out, applied, skipped] = applyCorrections(text, [
    {
      original: "The fighters fell backwards, stumbling over their comrades.",
      corrected: "The fighters fell backward, stumbling over their comrades.",
    },
    {
      original: "The fighters fell backwards, stumbling over their comrades.",
      corrected: "The fighters fell backward, tripping over their comrades.",
    },
  ]);
  assert.equal(applied.length, 1);
  assert.equal(out, "The fighters fell backward, stumbling over their comrades.");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason ?? "", /alternative rewrite of the same text/);
});

// ── applyCorrections edge boundaries (root cause of the splice) ──

// ── applyCorrections seam punctuation (the ".." splice) ──
// Real case: the model emitted original '…from his shoulder' → corrected
// '…from his shoulder.' — the snippet omits the sentence-final period the
// manuscript already has, so the splice doubled it: "shoulder..".

test("apply: period-appending correction does not double an existing period", () => {
  const text =
    "Aaron dropped the satchel from his shoulder. “Yes, he mentioned it might be possible.”";
  const [out] = applyCorrections(text, [
    {
      original: "Aaron dropped the satchel from his shoulder",
      corrected: "Aaron dropped the satchel from his shoulder.",
    },
  ]);
  assert.equal(out, text);
  assert.ok(!out.includes(".."));
});

test("apply: real edit with trailing period keeps a single period", () => {
  const text =
    "He waved with his staff, accompanying the motion with a rapid exhale. Aaron copied.";
  const [out, applied] = applyCorrections(text, [
    {
      original: "accompanying the motion with a rapid exhale",
      corrected: "matching the motion with a rapid exhale.",
    },
  ]);
  assert.equal(applied.length, 1);
  assert.ok(out.includes("matching the motion with a rapid exhale. Aaron"));
  assert.ok(!out.includes(".."));
});

test("apply: leading seam punctuation is not doubled either", () => {
  const text = "one, two, three";
  const [out] = applyCorrections(text, [
    { original: " two", corrected: ", two" },
  ]);
  assert.equal(out, text);
  assert.ok(!out.includes(",,"));
});

test("apply: trailing period next to an author ellipsis leaves the ellipsis intact", () => {
  const text = "He paused... then left the room.";
  const [out] = applyCorrections(text, [
    { original: "He paused", corrected: "He paused." },
  ]);
  assert.equal(out, text);
  assert.ok(!out.includes("...."));
});

// ── collapseIntroducedPunctuationPairs (assembly/export safety net) ──

test("punct: collapses an introduced doubled period", () => {
  const before = "He gestured with a rapid exhale. Aaron copied.";
  const after = "He gestured with a rapid exhale.. Aaron copied.";
  const { text, fixes } = collapseIntroducedPunctuationPairs(before, after);
  assert.equal(text, before);
  assert.deepEqual(fixes, [".."]);
});

test("punct: collapses introduced doubled exclamation and comma", () => {
  const before = "Run!! he cried, again and again.";
  const after = "Run!! he cried,, again!! and again.";
  const { text, fixes } = collapseIntroducedPunctuationPairs(before, after);
  // The pre-existing "Run!!" survives; the introduced ",," and "!!" collapse.
  assert.equal(text, "Run!! he cried, again! and again.");
  assert.deepEqual(fixes.sort(), ["!!", ",,"]);
});

test("punct: pre-existing doubled marks are left alone", () => {
  const before = "Wait.. what?? He typed on.";
  const { text, fixes } = collapseIntroducedPunctuationPairs(before, before);
  assert.equal(text, before);
  assert.equal(fixes.length, 0);
});

test("punct: ellipsis runs are never touched", () => {
  const before = "He paused, then left.";
  const after = "He paused... then left....";
  const { text, fixes } = collapseIntroducedPunctuationPairs(before, after);
  assert.equal(text, after);
  assert.equal(fixes.length, 0);
});

test("multi-word original cannot match the prefix of a longer word", () => {
  const text =
    "Karim had sent most of the students, soldiers and guards off. Kindra asked the student to take off their robes.";
  const [out, applied] = applyCorrections(text, [
    { original: "the student", corrected: "the students" },
  ]);
  assert.equal(applied.length, 1);
  assert.ok(out.includes("most of the students, soldiers")); // untouched
  assert.ok(out.includes("asked the students to take off")); // fixed
  assert.ok(!out.includes("studentss"));
});
