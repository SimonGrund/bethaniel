// The spell pass ran on nspell, a JavaScript reimplementation of Hunspell, and
// paid for it twice in bugs that each showed up in exactly one language:
//
//   Danish  den -> gen, kom -> gom, havde -> hævde. nspell does not strip the
//           morphological tags Hunspell allows after a headword, so `den al:dens`
//           was indexed whole and plain `den` was unknown. 26,232 entries.
//   German  kommen unknown while Kommen was fine. nspell keeps one of a
//           lowercase/capitalised pair, and German capitalises every noun, so
//           `kommen` collided with `Kommen` and lost. 87,955 entries.
//
// Both had workarounds here. A third limitation could not be worked around:
// nspell does not implement COMPOUNDRULE, so every novel compound in a
// compounding language read as a misspelling. That is not an edge case in
// Danish or German, it is how the languages build words.
//
// These tests now run against Hunspell itself, compiled to WebAssembly. They
// keep the old bugs pinned as regressions and add the compound case that only
// the real engine can pass.

import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
  getWordValidator,
  getSpellCorrections,
  initSpellchecker,
  isSpellcheckReady,
} from "../src/spellcheck.ts";

// Hunspell is WebAssembly, so the module load is async. Production does this
// once at startup (index.ts); tests do it once here.
before(async () => {
  await initSpellchecker();
});

test("the spell checker reports itself ready", () => {
  assert.ok(isSpellcheckReady(), "Hunspell should have loaded");
});

// ── Danish: the morphological-tag bug ───────────────────────────────────────

const DANISH_BASICS = [
  "den", "det", "sin", "havde", "kom", "gik", "hendes", "hende",
  "været", "ville", "dem", "kunne", "nogen", "nogle", "lagde",
];

test("the commonest Danish words are known", () => {
  const known = getWordValidator("da");
  assert.ok(known, "the Danish dictionary should load");
  for (const word of DANISH_BASICS) {
    assert.ok(known!(word), `"${word}" must be a known Danish word`);
  }
});

test("error-free Danish prose is not 'corrected'", () => {
  const clean =
    "Da brevet kom, havde hun ikke bundet en bog i ni år. " +
    "Hun stod i sin mors værksted, og hun vidste, at nogen havde været der. " +
    "Hun lagde det på bænken, og det gik som det skulle.";
  assert.deepEqual(
    getSpellCorrections(clean, "da").map((c) => c.original),
    [],
    "no word in ordinary Danish prose should be flagged",
  );
});

// ── German: the case-collision bug ──────────────────────────────────────────

test("common lowercase German words are known", () => {
  const known = getWordValidator("de");
  assert.ok(known, "the German dictionary should load");
  for (const word of ["kommen", "recht", "gehen", "stand", "paar", "gut", "sagen"]) {
    assert.ok(known!(word), `"${word}" must be a known German word`);
  }
});

test("a lowercased German noun is still unknown, so capitalization is caught", () => {
  // The pair that makes this hard: German needs `kommen` accepted and `haus`
  // rejected, and they look identical to a checker that folds case. The old
  // workaround had to thread this needle by hand; Hunspell does it natively.
  const known = getWordValidator("de")!;
  for (const word of ["haus", "werkstatt", "papier", "tisch", "buch"]) {
    assert.equal(known(word), false, `lowercase "${word}" must stay unknown`);
  }
});

test("German umlauts survive the dictionary's encoding", () => {
  // de_DE shipped as ISO-8859-1 and is now UTF-8, SET line included. Get this
  // wrong and every ä/ö/ü/ß word reads as a misspelling — 92 of them on the
  // stress fixture, which is how the conversion got noticed.
  const known = getWordValidator("de")!;
  for (const word of ["Gehäuse", "Händen", "öffnete", "Großmutter", "Blätter"]) {
    assert.ok(known(word), `"${word}" must survive encoding`);
  }
});

// ── Compounds: what no workaround could have fixed ──────────────────────────

test("novel compounds are accepted in the compounding languages", () => {
  // nspell has no COMPOUNDRULE, so these read as misspellings — and a Danish
  // or German novel is full of them. Hunspell composes them from their parts.
  const da = getWordValidator("da")!;
  for (const word of ["messinglup", "rådhusarkivet", "blækplettede"]) {
    assert.ok(da(word), `Danish compound "${word}" must be accepted`);
  }
  const de = getWordValidator("de")!;
  for (const word of ["Messinglupe", "Werkstattfenster"]) {
    assert.ok(de(word), `German compound "${word}" must be accepted`);
  }
});

// ── The pass must still catch real errors ───────────────────────────────────

test("a real misspelling is still caught in every language", () => {
  const cases: [string, string, string][] = [
    ["da", "Hun stod i sin mors værkstd.", "værkstd"],
    // Lowercase on purpose: a capitalised word mid-sentence is protected as a
    // proper noun by collectMidSentenceCapitals, whatever the dictionary says.
    ["de", "Er gingg in die Werkstatt.", "gingg"],
    ["es", "He encuardenado libros durante treinta años.", "encuardenado"],
    ["en_US", "She kept a notebok in her coat.", "notebok"],
  ];
  for (const [lang, text, expected] of cases) {
    assert.ok(
      getSpellCorrections(text, lang).some((c) => c.original === expected),
      `${lang}: "${expected}" must still be reported`,
    );
  }
});

test("every bundled dictionary loads", () => {
  for (const lang of ["da", "de", "es", "en_US", "en_GB"]) {
    assert.ok(getWordValidator(lang), `${lang} should load`);
  }
});
