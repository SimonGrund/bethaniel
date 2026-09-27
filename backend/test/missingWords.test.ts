// ── A word the writer dropped ──
//
// "they expect us to look each other in the same place" — the check that
// finds it is a model sweep, a deterministic shape filter and a model
// verdict (see missingWords.ts). The model parts are measured by benchmark;
// everything here is the deterministic part, plus the verdict logic driven
// by a scripted model.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dropEditorDuplicates,
  findMissingWords,
  insertedFunctionWord,
  isPlainWordSplice,
  missingWordCheckApplies,
  parseSweepOutput,
  parseVerdict,
  shapeCandidates,
  sweepBatches,
  type Complete,
} from "../src/missingWords.ts";
import { classifyPublicationBlocking } from "../src/correctionSeverity.ts";
import { estimateCloudJob } from "../src/cloudEstimate.ts";

// ── Shape ────────────────────────────────────────────────────────────────

test("one function word inside the span is an insertion", () => {
  assert.equal(insertedFunctionWord("look each other", "look for each other"), "for");
  assert.equal(insertedFunctionWord("she never seen", "she had never seen"), "had");
  assert.equal(insertedFunctionWord("stood der Werkstatt", "stood in der Werkstatt", "de"), "in");
});

test("an insertion at either edge is refused — that is how endings are invented", () => {
  // "that someone would." → "would do." and "true." → "was true." were both
  // proposed; the gap of a real dropped word has words on both sides.
  assert.equal(insertedFunctionWord("that someone would.", "that someone would do."), null);
  assert.equal(insertedFunctionWord("true.", "was true."), null);
  assert.equal(insertedFunctionWord("each other", "for each other"), null);
});

test("a content word is writing, not repair", () => {
  assert.equal(insertedFunctionWord("There is no public", "There is no public access"), null);
  assert.equal(insertedFunctionWord("and got back", "and then got back"), null);
});

test("anything but letters and one space spliced in is refused", () => {
  // Tokenising strips these marks, which is how "**på**" and "[is]" first
  // passed as plain insertions.
  assert.equal(isPlainWordSplice("stod Vagt", "stod **på** Vagt"), false);
  assert.equal(isPlainWordSplice("suddenly dry", "suddenly [is] dry"), false);
  assert.equal(insertedFunctionWord("stod Mikkel Vagt", "stod Mikkel **på** Vagt", "da"), null);
  assert.equal(isPlainWordSplice("look each other", "look for each other"), true);
  // A change elsewhere in the span is not an insertion.
  assert.equal(isPlainWordSplice("look each other", "look for each others"), false);
});

test("each language has its own function words, and an unknown one has none", () => {
  assert.equal(insertedFunctionWord("llegó la casa", "llegó a la casa", "es"), "a");
  assert.equal(insertedFunctionWord("pensait son frère", "pensait à son frère", "fr"), "à");
  assert.equal(insertedFunctionWord("gik hen døren", "gik hen til døren", "da"), "til");
  // English "for" is not a German function word.
  assert.equal(insertedFunctionWord("wartete den Bus", "wartete for den Bus", "de"), null);
  assert.equal(insertedFunctionWord("look each other", "look for each other", "it"), null);
});

// ── Parsing the sweep ────────────────────────────────────────────────────

test("strings, phrase arrays and word arrays all parse", () => {
  const raw = parseSweepOutput(
    [
      '{"original": "look each other", "corrected": "look for each other"}',
      '{"original": ["Mein Vater hat so geredet", "wenn müde war"], "corrected": ["Mein Vater hat so geredet", "wenn er müde war"]}',
      '{"original": ["als", "könnte", "fortlaufen"], "corrected": ["als", "könnte", "er", "fortlaufen"]}',
      "NONE",
      "{broken json",
    ].join("\n"),
  );
  assert.deepEqual(raw, [
    { original: "look each other", corrected: "look for each other" },
    // Only the phrase that changed.
    { original: "wenn müde war", corrected: "wenn er müde war" },
    { original: "als könnte fortlaufen", corrected: "als könnte er fortlaufen" },
  ]);
});

test("a verdict is read off the first answer word", () => {
  assert.equal(parseVerdict("B"), "B");
  assert.equal(parseVerdict("A — A is grammatical and B is worse"), "A");
  assert.equal(parseVerdict("BOTH"), "BOTH");
  assert.equal(parseVerdict("<think>\n</think>\nNEITHER"), "NEITHER");
  assert.equal(parseVerdict("maybe"), null);
});

test("batches follow paragraphs and stay small", () => {
  const para = Array(100).fill("word").join(" ");
  const text = Array(10).fill(para).join("\n\n");
  const batches = sweepBatches(text, 250);
  assert.equal(batches.length, 5);
  for (const b of batches) assert.ok(b.split(/\s+/).length <= 250);
});

// ── Anchoring ────────────────────────────────────────────────────────────

const CHAPTER =
  "Probably, that means they expect us to look each other in the same place. " +
  'Er lachte. "Mein Vater hat so geredet, wenn müde war." Sie ging.';

test("a candidate carries the sentence as written and as repaired", () => {
  const [c] = shapeCandidates(CHAPTER, [{ original: "look each other", corrected: "look for each other" }]);
  assert.equal(c.word, "for");
  assert.equal(
    c.sentenceA,
    "Probably, that means they expect us to look each other in the same place.",
  );
  assert.equal(
    c.sentenceB,
    "Probably, that means they expect us to look for each other in the same place.",
  );
});

test("words the text separates with punctuation are found anyway, against the text as written", () => {
  const [c] = shapeCandidates(
    CHAPTER,
    [{ original: "geredet wenn müde", corrected: "geredet wenn er müde" }],
    "de",
  );
  assert.equal(c.original, "geredet, wenn müde");
  assert.equal(c.corrected, "geredet, wenn er müde");
});

test("two spans around the same gap are one candidate", () => {
  const cs = shapeCandidates(
    CHAPTER,
    [
      { original: "wenn müde war", corrected: "wenn er müde war" },
      { original: "geredet wenn müde", corrected: "geredet wenn er müde" },
    ],
    "de",
  );
  assert.equal(cs.length, 1);
});

test("an original that occurs twice, or not at all, is dropped", () => {
  const text = "She went the door. Later she went the door again.";
  assert.equal(
    shapeCandidates(text, [{ original: "went the door", corrected: "went to the door" }]).length,
    0,
  );
  assert.equal(
    shapeCandidates(text, [{ original: "ran the hill", corrected: "ran up the hill" }]).length,
    0,
  );
});

// ── The whole check, with a scripted model ───────────────────────────────

/** A model that proposes one fix and answers the verdicts as scripted. */
function scripted(verdict: string, solo: Record<"A" | "B", string> = { A: "YES", B: "YES" }): Complete {
  return async (system, user) => {
    if (system.includes("looking for ONE kind of error")) {
      return '{"original": "look each other", "corrected": "look for each other"}';
    }
    if (system.includes("two versions of one sentence")) return verdict;
    // The solo check sees one sentence; the repaired one contains "look for".
    return user.includes("look for") ? solo.B : solo.A;
  };
}
const TEXT = "Probably, that means they expect us to look each other in the same place.";

test("a B verdict keeps the fix, pre-approved and tagged", async () => {
  const r = await findMissingWords(TEXT, "en", scripted("B"));
  assert.equal(r.corrections.length, 1);
  const c = r.corrections[0];
  assert.equal(c.corrected, "look for each other");
  assert.equal(c.reason, "missing-word");
  assert.equal(c.preApproved, true);
  assert.equal(c.editType, "copy");
});

test("when the comparison hedges, the sentences judged alone can still keep it", async () => {
  const kept = await findMissingWords(TEXT, "en", scripted("BOTH", { A: "NO", B: "YES" }));
  assert.equal(kept.corrections.length, 1);
  const dropped = await findMissingWords(TEXT, "en", scripted("BOTH", { A: "YES", B: "YES" }));
  assert.equal(dropped.corrections.length, 0);
  const neither = await findMissingWords(TEXT, "en", scripted("A", { A: "NO", B: "NO" }));
  assert.equal(neither.corrections.length, 0);
});

test("a model that fails costs the findings, never the chunk", async () => {
  const r = await findMissingWords(TEXT, "en", async () => {
    throw new Error("socket hang up");
  });
  assert.deepEqual(r.corrections, []);
});

test("an unsupported language is not swept at all", async () => {
  let calls = 0;
  const r = await findMissingWords(TEXT, "it", async () => {
    calls++;
    return "";
  });
  assert.equal(calls, 0);
  assert.deepEqual(r.corrections, []);
});

// ── Pipeline edges ───────────────────────────────────────────────────────

test("the check runs in the copy edit, combined edit and readthrough only", () => {
  for (const m of ["copy_edit", "combined_edit", "proofread"]) {
    assert.ok(missingWordCheckApplies(m, "en"), m);
    assert.ok(missingWordCheckApplies(m, "da"), m);
  }
  assert.equal(missingWordCheckApplies("line_edit", "en"), false);
  assert.equal(missingWordCheckApplies("translate", "en"), false);
  assert.equal(missingWordCheckApplies("copy_edit", "it"), false);
  // No language recorded means English, as everywhere else.
  assert.ok(missingWordCheckApplies("copy_edit", undefined));
});

test("an editor correction making the same insertion is dropped; others stay", () => {
  const found = [{ original: "look each other", corrected: "look for each other" }];
  const editor = [
    { original: "to look each", corrected: "to look for each" }, // same gap, same word
    { original: "look each other", corrected: "look at each other" }, // same gap, other word
    { original: "same place", corrected: "same spot" },
  ];
  const kept = dropEditorDuplicates(TEXT, found, editor);
  assert.deepEqual(
    kept.map((c) => c.corrected),
    ["look at each other", "same spot"],
  );
});

test("a confirmed missing word blocks publication", () => {
  const c = {
    original: "look each other",
    corrected: "look for each other",
    reason: "missing-word",
    preApproved: true,
  };
  assert.equal(classifyPublicationBlocking(c, "proofread", { text: TEXT }), true);
});

test("the cloud quote prices the check where it runs, and only there", () => {
  const base = {
    units: [{ wordCount: 10_000 }],
    wordsPerChunk: 2500,
    runMode: "speed" as const,
    reviewMode: true,
    styleComplianceAgent: false,
    extraPass: false,
    numPredict: 4096,
  };
  // Danish runs the check, Italian does not: the difference is the check's
  // measured per-word share (MISSING_WORD_PER_WORD in cloudEstimate.ts).
  const da = estimateCloudJob({ ...base, modes: ["copy_edit"], manuscriptLang: "da" });
  const it = estimateCloudJob({ ...base, modes: ["copy_edit"], manuscriptLang: "it" });
  assert.equal(da.estimatedInputTokens - it.estimatedInputTokens, 33_800);
  assert.equal(da.estimatedOutputTokens - it.estimatedOutputTokens, 1_300);
  // A line edit runs no check, in any language.
  const lineDa = estimateCloudJob({ ...base, modes: ["line_edit"], manuscriptLang: "da" });
  const lineIt = estimateCloudJob({ ...base, modes: ["line_edit"], manuscriptLang: "it" });
  assert.equal(lineDa.estimatedTotalTokens, lineIt.estimatedTotalTokens);
  // Still far inside the Worker's 40-tokens-per-word guard (quote.ts).
  assert.ok(da.estimatedTotalTokens / 10_000 < 25);
});
