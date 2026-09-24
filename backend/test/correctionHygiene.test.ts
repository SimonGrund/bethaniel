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
  reconcileSpellWithEditor,
  dropNoOpCorrections,
  dropRedundantPunctuationAppends,
  partitionUnlocatable,
  boundaryOccurrences,
  dedupeChapterCorrections,
} from "../src/correctionHygiene.ts";
import { applyCorrections } from "../src/llm.ts";
import type { Correction } from "../src/types.ts";

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

// ── reconcileSpellWithEditor: cross-source agreement pre-approval ──
// The Hunspell spell-checker's top suggestion is often wrong ("teh"→"ten"),
// so a deterministic fix is only trusted enough to bypass the skeptical
// reviewer when an LLM editor independently produced the IDENTICAL change.

test("reconcileSpellWithEditor: pre-approves a fix both sources agree on and drops the editor duplicate", () => {
  const spell: Correction[] = [{ original: "recieve", corrected: "receive" }];
  const editor: Correction[] = [
    { original: "recieve", corrected: "receive" },
    { original: "she ran quick", corrected: "she ran quickly" },
  ];
  const editorKept = reconcileSpellWithEditor(spell, editor);
  assert.equal(spell[0].preApproved, true, "agreed spell fix is pre-approved");
  assert.equal(editorKept.length, 1, "duplicate editor copy is removed");
  assert.equal(editorKept[0].original, "she ran quick");
});

test("reconcileSpellWithEditor: disagreement leaves both under review", () => {
  const spell: Correction[] = [{ original: "teh", corrected: "ten" }]; // bad Hunspell guess
  const editor: Correction[] = [{ original: "teh", corrected: "the" }]; // correct in-context
  const editorKept = reconcileSpellWithEditor(spell, editor);
  assert.notEqual(spell[0].preApproved, true, "disagreed spell fix is NOT pre-approved");
  assert.equal(editorKept.length, 1, "differing editor fix is kept for the reviewer");
  assert.equal(editorKept[0].corrected, "the");
});

test("reconcileSpellWithEditor: a spell fix with no editor match is left for the reviewer", () => {
  const spell: Correction[] = [{ original: "definately", corrected: "definitely" }];
  const editor: Correction[] = [];
  const editorKept = reconcileSpellWithEditor(spell, editor);
  assert.notEqual(spell[0].preApproved, true);
  assert.equal(editorKept.length, 0);
});

// ── dropNoOpCorrections ──

test("dropNoOpCorrections: removes a correction that changes nothing", () => {
  const cs: Correction[] = [
    { original: ".", corrected: "." },
    { original: "the the", corrected: "the" },
  ];
  const kept = dropNoOpCorrections(cs);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].original, "the the");
});

test("dropNoOpCorrections: whitespace-only differences also count as no-ops", () => {
  const cs: Correction[] = [{ original: "Cool sweat", corrected: "Cool  sweat" }];
  // trim + collapse-whitespace normalization treats these as identical
  const kept = dropNoOpCorrections(cs);
  assert.equal(kept.length, 0);
});

test("dropNoOpCorrections: real changes survive", () => {
  const cs: Correction[] = [{ original: "recieve", corrected: "receive" }];
  assert.deepEqual(dropNoOpCorrections(cs), cs);
});

test("dropNoOpCorrections: a no-op hidden behind a zero-width space is still dropped", () => {
  // A model-introduced ZERO WIDTH SPACE (U+200B) makes two strings byte-
  // distinct while reading identically to a user — "replacing a dot with a
  // dot". Built from a code point, never typed as a literal character.
  const zwsp = String.fromCharCode(0x200b);
  const cs: Correction[] = [{ original: "sweat.", corrected: `sweat.${zwsp}` }];
  assert.deepEqual(dropNoOpCorrections(cs), []);
});

test("dropNoOpCorrections: a soft hyphen difference is also a no-op", () => {
  const softHyphen = String.fromCharCode(0x00ad);
  const cs: Correction[] = [
    { original: `pass${softHyphen}word`, corrected: "password" },
  ];
  assert.deepEqual(dropNoOpCorrections(cs), []);
});

// ── dropRedundantPunctuationAppends ──

test("dropRedundantPunctuationAppends: drops a period the source already has right after", () => {
  const text =
    "as the last sliver of power from Katja and John faded into nothing. Broken, Flint roared into the night.";
  const cs: Correction[] = [
    {
      original: "the last sliver of power from Katja and John faded into nothing",
      corrected: "the last sliver of power from Katja and John faded into nothing.",
    },
  ];
  assert.deepEqual(dropRedundantPunctuationAppends(text, cs), []);
});

test("dropRedundantPunctuationAppends: a genuinely missing period is kept", () => {
  const text = "He reached for the door and then he stopped Something was wrong.";
  const cs: Correction[] = [
    {
      original: "He reached for the door and then he stopped",
      corrected: "He reached for the door and then he stopped.",
    },
  ];
  assert.deepEqual(dropRedundantPunctuationAppends(text, cs), cs);
});

test("dropRedundantPunctuationAppends: a substantive (non-punctuation-only) append is kept", () => {
  const text = "He nodded and said okay to the plan.";
  const cs: Correction[] = [
    { original: "He nodded and said okay", corrected: "He nodded and said okay, sure" },
  ];
  assert.deepEqual(dropRedundantPunctuationAppends(text, cs), cs);
});

// ── boundaryOccurrences ──

test("boundaryOccurrences: finds only whole-word-boundary matches", () => {
  const text = "He clenched his fists. Not saving John.";
  assert.deepEqual(boundaryOccurrences(text, "his fists"), [text.indexOf("his fists")]);
  // "is" is inside "his"/"fists" — must not match as a substring hit
  assert.deepEqual(boundaryOccurrences(text, "is"), []);
});

// ── dedupeChapterCorrections ──

test("dedupeChapterCorrections: drops no-op corrections", () => {
  const text = "He wiped the sweat from his face. Cool sweat trickled down.";
  const cs: Correction[] = [{ original: ".", corrected: "." }];
  assert.deepEqual(dedupeChapterCorrections(text, cs), []);
});

test("dedupeChapterCorrections: exact duplicates (whitespace-insensitive) collapse to one", () => {
  const text = "It was  broken beyond repair.";
  const cs: Correction[] = [
    { original: "It was  broken", corrected: "It was fixed" },
    { original: "It was broken", corrected: "It was  fixed" }, // same fix, re-normalized
  ];
  const out = dedupeChapterCorrections(text, cs);
  assert.equal(out.length, 1);
});

test("dedupeChapterCorrections: true subsumption still collapses (same location, less context)", () => {
  const text = 'Flint said, "Not saving John and Katja is no excuse."';
  const cs: Correction[] = [
    {
      original: 'Flint said, "Not saving John and Katja is no excuse."',
      corrected: 'Flint said, "Not saving John and Katja is no excuse!"',
    },
    { original: 'excuse."', corrected: 'excuse!"' },
  ];
  const out = dedupeChapterCorrections(text, cs);
  assert.equal(out.length, 1, "the shorter, same-location fix subsumes the longer one");
  assert.equal(out[0].original, 'excuse."');
});

test("dedupeChapterCorrections: an unlocatable 'container' no longer forces a drop by string coincidence alone", () => {
  // The old subsumption pass compared correction STRINGS only, with no check
  // that either correction actually occurs in the manuscript — a longer
  // correction whose wording was hallucinated/paraphrased (not verbatim in
  // the text) could still lexically contain a shorter correction's strings
  // and get treated as "the same fix with more context" purely by
  // coincidence. Since it can't be verified to occur where it claims to,
  // the position-aware check now leaves it alone instead of asserting a
  // same-location relationship it cannot confirm.
  const text = "Flint's words hit Aaron like a punch in the stomach, He clenched his fists.";
  const cs: Correction[] = [
    {
      // Real, locatable fix: comma splice → period.
      original: "stomach, He",
      corrected: "stomach. He",
    },
    {
      // Hallucinated: "clenched hard" never appears verbatim in the text
      // (the real text says "clenched his fists"), so this correction is not
      // locatable — but it still lexically CONTAINS the real fix's strings.
      original: "punch in the stomach, He clenched hard",
      corrected: "punch in the stomach. He clenched hard",
    },
  ];
  const out = dedupeChapterCorrections(text, cs);
  // The real, locatable fix always survives (Pass 2 only ever drops the
  // longer side of a pair); the unverifiable one is no longer force-dropped
  // as if it were confirmed redundant — both are left for downstream review.
  assert.equal(out.length, 2);
  assert.ok(out.some((c) => c.original === "stomach, He"));
});

test("a correction that only swaps quote or apostrophe style is a no-op", () => {
  const kept = dropNoOpCorrections([
    { original: "don't", corrected: "don\u2019t" },
    { original: "\u201CHello,\u201D she said.", corrected: '"Hello," she said.' },
    { original: "it's", corrected: "its" },
    { original: "\u2018quoted\u2019", corrected: "'quoted'" },
  ]);
  assert.deepEqual(kept.map((c) => c.corrected), ["its"]);
});

// Quote-style normalisation survives the no-op filter.
//
// a342be5 added that filter deliberately: a correction whose only difference
// is the style of a quotation mark was noise. It still is, from an LLM — but
// the deterministic normalisation pass is now the one thing in the run whose
// ENTIRE job is that difference, and the filter would delete all of it.

test("a quote-style correction is not dropped as a no-op", () => {
  const kept = dropNoOpCorrections([
    {
      original: '"We can try," she said.',
      corrected: "“We can try,” she said.",
      reason: "quote-style",
    } as never,
  ]);
  assert.equal(kept.length, 1);
});

test("an LLM's quote-style change is still dropped", () => {
  const kept = dropNoOpCorrections([
    {
      original: '"We can try," she said.',
      corrected: "“We can try,” she said.",
    } as never,
  ]);
  assert.equal(kept.length, 0);
});

// ── A period the sentence already has ──
//
// From a real run. The editor's context window ends before the sentence's
// own full stop, so it "finishes" the sentence for you:
//
//   original : 'And all of it, made sense'
//   corrected: 'And all of it made sense.'
//   source   : '…And all of it, made sense.\n\n“Let’s go,” Karim said.'
//
// The comma removal is a real fix; the period is already there. Applying it
// whole gives "made sense..", and the review screen renders the pair adjacent
// so it reads as "made sense. .".
//
// The guard used to require a PURE append (corrected.startsWith(original)),
// which this is not — so it sailed through.

const SOURCE =
  "Even the heartbeats were clear to him. And all of it, made sense.\n\n“Let’s go,” Karim said.";

test("a redundant period is trimmed, and the real fix survives", () => {
  const [c] = dropRedundantPunctuationAppends(SOURCE, [
    {
      original: "And all of it, made sense",
      corrected: "And all of it made sense.",
    } as never,
  ]);
  assert.ok(c, "the comma fix must not be thrown away with the period");
  assert.equal(c.corrected, "And all of it made sense");
});

test("a correction that was ONLY the redundant period is dropped whole", () => {
  assert.deepEqual(
    dropRedundantPunctuationAppends(SOURCE, [
      { original: "made sense", corrected: "made sense." } as never,
    ]),
    [],
  );
});

test("a period the sentence does NOT have is left alone", () => {
  const text = "He walked on. And all of it made sense\n\nThe end.";
  const [c] = dropRedundantPunctuationAppends(text, [
    {
      original: "And all of it made sense",
      corrected: "And all of it made sense.",
    } as never,
  ]);
  assert.equal(c.corrected, "And all of it made sense.", "a real fix");
});

test("punctuation the correction did not add is untouched", () => {
  // The original already ends in a full stop; nothing was appended.
  const text = "And all of it, made sense. The end.";
  const [c] = dropRedundantPunctuationAppends(text, [
    {
      original: "And all of it, made sense.",
      corrected: "And all of it made sense.",
    } as never,
  ]);
  assert.equal(c.corrected, "And all of it made sense.");
});

// ── A correction whose text is not in the manuscript ──
//
// From a real run. The model quoted the sentence without the stammer the
// author wrote, then "corrected" it by putting the stammer back:
//
//   manuscript: Tobias paused his struggling too. “I… I’ll tell you later. …
//   original  : “I’ll tell you later. There’s a lot to tell you.”
//   corrected : “I… I’ll tell you later. There’s a lot to tell you.”
//
// `original` does not occur, so findAllOccurrences returns [] and accepting
// it changes nothing — but it was still offered as a decision AND counted as
// a publication blocker. It also rendered garbled: the card's context comes
// from locateInText, whose last-ditch fallback matched the single word
// "There’s", so the surrounding context repeated the very text the diff was
// showing.
//
// It is moved to `skipped` rather than deleted: the review screen lists those
// ("left alone"), and a finding the author never sees is worse than a noisy
// one.

const MANUSCRIPT =
  "Tobias paused his struggling too. “I… I’ll tell you later. There’s a lot to tell you.”\n\nThe masses continued yelling.";

test("a correction that cannot be located is not offered as a decision", () => {
  const { kept, unlocatable } = partitionUnlocatable(MANUSCRIPT, [
    {
      original: "“I’ll tell you later. There’s a lot to tell you.”",
      corrected: "“I… I’ll tell you later. There’s a lot to tell you.”",
    } as never,
  ]);
  assert.equal(kept.length, 0, "it can never be applied");
  assert.equal(unlocatable.length, 1, "and it is listed, not deleted");
});

test("a correction that IS in the manuscript is untouched", () => {
  const { kept, unlocatable } = partitionUnlocatable(MANUSCRIPT, [
    { original: "The masses continued yelling.", corrected: "The masses kept yelling." } as never,
  ]);
  assert.equal(kept.length, 1);
  assert.equal(unlocatable.length, 0);
});

test("whitespace differences do not make a correction unlocatable", () => {
  // A chunk boundary can normalise a newline into a space. That is a real
  // correction quoted slightly differently, not a hallucinated one.
  const { kept } = partitionUnlocatable("one two\nthree four", [
    { original: "two three", corrected: "two, three" } as never,
  ]);
  assert.equal(kept.length, 1);
});

test("a withheld guess is never called unlocatable", () => {
  // corrected === original, and the word is in the text; it is a finding
  // about a word, not a rewrite.
  const { kept } = partitionUnlocatable(MANUSCRIPT, [
    { original: "Tobias", corrected: "Tobias", reason: "spell-check-unknown" } as never,
  ]);
  assert.equal(kept.length, 1);
});
