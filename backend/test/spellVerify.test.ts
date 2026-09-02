// Tests for the post-apply spell safety net: findNewSuspectWords (introduced
// misspellings only) and applyCorrectionsVerified (revert + flag offenders).

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCorrectionsVerified } from "../src/llm.ts";
import { findNewSuspectWords } from "../src/spellcheck.ts";

const spellOpts = { englishDialect: "american" };
const findNewSuspects = (before: string, after: string) =>
  findNewSuspectWords(before, after, "en", spellOpts);

test("findNewSuspectWords: detects an introduced non-word, capitalized included", () => {
  const before = "Apparently, the plan worked. He didn't mind.";
  const after = "Appwrently, the plan worked. He did't mind.";
  const suspects = findNewSuspects(before, after);
  assert.ok(suspects, "dictionary should be available");
  assert.ok(suspects!.includes("Appwrently"));
  assert.ok(suspects!.includes("did't"));
});

test("findNewSuspectWords: words already suspect in `before` are not reported", () => {
  const before = "The zzorgle waited.";
  const after = "The zzorgle waited patiently.";
  assert.deepEqual(findNewSuspects(before, after), []);
});

test("findNewSuspectWords: style-guide names are skipped", () => {
  const before = "She arrived.";
  const after = "Bethaniel arrived.";
  const suspects = findNewSuspectWords(before, after, "en", {
    ...spellOpts,
    styleGuideNames: ["Bethaniel"],
  });
  assert.deepEqual(suspects, []);
});

test("findNewSuspectWords: returns null for an unsupported language", () => {
  assert.equal(findNewSuspectWords("a b", "a b c", "xx"), null);
});

test("applyCorrectionsVerified: reverts a correction that introduces a misspelling", () => {
  // No isAcceptableWord validator — simulates the validator-null case where
  // the apply-time spell gate is off and only the post-apply net can catch it.
  const text = "Apparently the plan worked. I went to teh store.";
  const [out, applied, , reverted] = applyCorrectionsVerified(
    text,
    [
      { original: "Apparently", corrected: "Appwrently" },
      { original: "teh", corrected: "the" },
    ],
    { findNewSuspects },
  );
  assert.equal(out, "Apparently the plan worked. I went to the store.");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].corrected, "the");
  assert.equal(reverted.length, 1);
  assert.equal(reverted[0].flagged, true);
  assert.match(reverted[0].reviewReason ?? "", /introduced misspelling "Appwrently"/);
});

test("applyCorrectionsVerified: clean corrections are untouched, reverted empty", () => {
  const [out, applied, skipped, reverted] = applyCorrectionsVerified(
    "I went to teh store.",
    [{ original: "teh", corrected: "the" }],
    { findNewSuspects },
  );
  assert.equal(out, "I went to the store.");
  assert.equal(applied.length, 1);
  assert.equal(skipped.length, 0);
  assert.equal(reverted.length, 0);
});

test("applyCorrectionsVerified: unattributable suspect causes no revert and no crash", () => {
  // Stub reports a suspect that no correction's `corrected` side contains —
  // like an overlap-strip artifact. The apply result must stand.
  const [out, applied, , reverted] = applyCorrectionsVerified(
    "I went to teh store.",
    [{ original: "teh", corrected: "the" }],
    { findNewSuspects: () => ["ghostword"] },
  );
  assert.equal(out, "I went to the store.");
  assert.equal(applied.length, 1);
  assert.equal(reverted.length, 0);
});

test("applyCorrectionsVerified: without findNewSuspects behaves like applyCorrections", () => {
  const [out, applied, , reverted] = applyCorrectionsVerified(
    "Apparently fine.",
    [{ original: "Apparently", corrected: "Appwrently" }],
    {},
  );
  assert.equal(out, "Appwrently fine.");
  assert.equal(applied.length, 1);
  assert.equal(reverted.length, 0);
});

test("applyCorrectionsVerified: multiple offenders are all reverted", () => {
  const text = "Apparently the dog barked. Definitely the cat slept.";
  const [out, , , reverted] = applyCorrectionsVerified(
    text,
    [
      { original: "Apparently", corrected: "Appwrently" },
      { original: "Definitely", corrected: "Definately" },
    ],
    { findNewSuspects },
  );
  assert.equal(out, text);
  assert.equal(reverted.length, 2);
});

// ── Typographic (curly) apostrophe handling ──
// Manuscripts use ’ (U+2019); the dictionaries and skip-list use '. Every
// tokenizer and lookup must treat them as equivalent, or corrupted
// contractions ("did’t") become invisible to the spell safeguards and the
// spell-checker invents junk corrections from contraction stems
// ("hadn’t" → token "hadn" → suggestion "hadj").

import { getSpellCorrections, getWordValidator, findSuspectWords } from "../src/spellcheck.ts";
import { applyCorrections } from "../src/llm.ts";

test("curly apostrophes: no junk corrections from contraction stems", () => {
  const text = "He hadn’t seen it. She didn’t care. They couldn’t stop.";
  assert.deepEqual(getSpellCorrections(text, "en_GB", {}), []);
  assert.deepEqual(getSpellCorrections(text, "en_US", {}), []);
  assert.deepEqual(findSuspectWords(text, "en_US", {}).suspectWords, []);
});

test("curly apostrophes: validator accepts real contractions, rejects corrupted ones", () => {
  const validate = getWordValidator("en", { englishDialect: "american" })!;
  assert.equal(validate("didn’t"), true);
  assert.equal(validate("hadn’t"), true);
  assert.equal(validate("did’t"), false);
  assert.equal(validate("hadj’t"), false);
});

test("curly apostrophes: spell gate rejects corrupted contractions", () => {
  const validate = getWordValidator("en", { englishDialect: "american" })!;
  const text = "She didn’t care at all. He hadn’t seen it.";
  const [out, applied, skipped] = applyCorrections(
    text,
    [
      { original: "didn’t", corrected: "did’t" },
      { original: "hadn’t", corrected: "hadj’t" },
    ],
    { isAcceptableWord: validate },
  );
  assert.equal(out, text, "corrupted contractions must not be applied");
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 2);
});

test("curly apostrophes: findNewSuspectWords sees introduced corruption", () => {
  const before = "She didn’t care.";
  const after = "She did’t care.";
  const suspects = findNewSuspectWords(before, after, "en", { englishDialect: "american" });
  assert.ok(suspects);
  assert.deepEqual(suspects, ["did’t"]);
});

test("curly vs straight apostrophe swap is not reported as introduced", () => {
  const suspects = findNewSuspectWords("She didn’t care.", "She didn't care.", "en", {
    englishDialect: "american",
  });
  assert.deepEqual(suspects, []);
});

// ── Manuscript language: non-English dictionaries ──
// The Danish (da_DK) dictionary ships with the app; the manuscript-language
// setting routes spell-check through it instead of the English ones, which
// used to flood Danish text with false positives and English suggestions.

test("Danish: validator accepts real Danish words, rejects corruptions", () => {
  const validate = getWordValidator("da");
  assert.ok(validate, "da_DK dictionary should be available");
  assert.equal(validate!("kærlighed"), true);
  assert.equal(validate!("hest"), true);
  assert.equal(validate!("kærlighedd"), false);
});

test("Danish: getSpellCorrections has no false positives where en_US floods", () => {
  const text = "Hesten løb over marken, og kærlighed fyldte hans hjerte.";
  assert.deepEqual(getSpellCorrections(text, "da", {}), []);
  // The old hardcoded-English path treats most Danish words as misspelled —
  // this is the bug the manuscript-language setting fixes.
  assert.ok(getSpellCorrections(text, "en_US", {}).length > 0);
});

// de_DE.aff declares `SET ISO8859-1` — unlike every other bundled dictionary
// (all UTF-8) — because it's inherited from the igerman98 source. Reading it
// as UTF-8 regardless mangled every non-ASCII German letter into U+FFFD,
// which meant correctly-spelled words like "über" failed validation (their
// dictionary entry didn't byte-match) and getSpellCorrections surfaced
// garbled "suggestions" like "über" → "�ber" — a real corrupted-Unicode
// correction a user could have accepted into their manuscript.

test("German: validator accepts real umlaut/ß words, rejects corruptions", () => {
  const validate = getWordValidator("de");
  assert.ok(validate, "de_DE dictionary should be available");
  assert.equal(validate!("über"), true);
  assert.equal(validate!("große"), true);
  assert.equal(validate!("drückte"), true);
  assert.equal(validate!("schließlich"), true);
  assert.equal(validate!("übxr"), false);
});

test("German: getSpellCorrections never suggests a replacement character", () => {
  const text = "Er ging uber die grosse Strasse und drueckte die Tur.";
  const corrections = getSpellCorrections(text, "de", {});
  assert.ok(corrections.length > 0, "misspellings should still be caught");
  for (const c of corrections) {
    assert.ok(
      !c.corrected.includes("�"),
      `suggestion for "${c.original}" was corrupted: "${c.corrected}"`,
    );
  }
});

test("Danish: findNewSuspectWords flags an introduced non-word, accepts real Danish", () => {
  const before = "Han gik hjem til sin hest.";
  const goodAfter = "Han gik hjem til sin smukke hest.";
  const badAfter = "Han gik hjem til sin hesst.";
  assert.deepEqual(findNewSuspectWords(before, goodAfter, "da"), []);
  const suspects = findNewSuspectWords(before, badAfter, "da");
  assert.ok(suspects);
  assert.deepEqual(suspects, ["hesst"]);
});

test("unsupported free-text language: spell-check is skipped, not English-checked", () => {
  const text = "Le cheval courait dans le pré.";
  assert.deepEqual(getSpellCorrections(text, "French", {}), []);
  assert.equal(getWordValidator("French"), null);
  assert.equal(findNewSuspectWords("a", "a b", "French"), null);
});

// ── attributeSuspects (shared by applyCorrectionsVerified and the
//    /verify-corrections export check) ──

import { attributeSuspects } from "../src/llm.ts";

test("attributeSuspects: maps suspect to the correction containing it", () => {
  const cs = [
    { id: "a", corrected: "went to the store" },
    { id: "b", corrected: "Appwrently so" },
  ];
  const m = attributeSuspects(["Appwrently"], cs);
  assert.equal(m.size, 1);
  assert.equal(m.get(cs[1]), "Appwrently");
});

test("attributeSuspects: word-boundary — no match inside a larger word", () => {
  const cs = [{ id: "a", corrected: "informal note" }];
  assert.equal(attributeSuspects(["form"], cs).size, 0);
});

test("attributeSuspects: case-insensitive and curly-apostrophe aware", () => {
  const cs = [{ id: "a", corrected: "He hadj’t seen it" }];
  const m = attributeSuspects(["hadj’t"], cs);
  assert.equal(m.get(cs[0]), "hadj’t");
  // boundary: "hadj" alone must not match inside "hadj’t" (’ is a word char)
  assert.equal(attributeSuspects(["hadj"], cs).size, 0);
});

test("attributeSuspects: unattributable suspect is omitted", () => {
  const cs = [{ id: "a", corrected: "clean text" }];
  assert.equal(attributeSuspects(["ghostword"], cs).size, 0);
});

test("export-check integration: accepted corruption is identified by id", () => {
  // Simulates the /verify-corrections flow: the user accepted a junk
  // correction ("hadn" → "hadj") and the frontend assembled the chapter.
  const before = "He hadn’t seen it coming.";
  const after = "He hadj’t seen it coming.";
  const accepted = [
    { id: "junk-1", corrected: "hadj" },
    { id: "ok-2", corrected: "the" },
  ];
  const suspects = findNewSuspectWords(before, after, "en", {
    englishDialect: "american",
  });
  assert.ok(suspects);
  assert.deepEqual(suspects, ["hadj’t"]);
  // "hadj’t" appears in no correction verbatim — the stem fallback must
  // attribute it to the correction that contributed "hadj".
  const offenders = attributeSuspects(suspects!, accepted);
  assert.equal(offenders.size, 1);
  assert.equal(offenders.get(accepted[0]), "hadj’t");
});

test("attributeSuspects: stem fallback catches multi-word contraction splices", () => {
  // {original: "He hadn", corrected: "He had"} applied inside "He hadn’t"
  // (multi-word originals skip the whole-word boundary check).
  const cs = [
    { id: "splice", corrected: "He had" },
    { id: "bystander", corrected: "went home" },
  ];
  const m = attributeSuspects(["had’t"], cs);
  assert.equal(m.size, 1);
  assert.equal(m.get(cs[0]), "had’t");
});
