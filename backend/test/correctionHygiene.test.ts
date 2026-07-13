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

// ── applyCorrections edge boundaries (root cause of the splice) ──

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
