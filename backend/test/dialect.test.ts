// Tests for the deterministic English-dialect normalization pass. The LLM
// prompt's "convert known pairs" instruction misses occurrences (a real
// manuscript shipped with both "Grey" and "Gray" under the American setting);
// this pass catches every curated pair mechanically, with case preserved.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getDialectCorrections, detectDialect } from "../src/dialect.ts";

function pairs(cs: { original: string; corrected: string }[]) {
  return cs.map((c) => `${c.original}→${c.corrected}`).sort();
}

test("american: converts British spellings with inflections", () => {
  const cs = getDialectCorrections(
    "The grey sky greyed further over the harbour as they travelled.",
    "american",
  );
  assert.deepEqual(pairs(cs), [
    "greyed→grayed",
    "grey→gray",
    "harbour→harbor",
    "travelled→traveled",
  ]);
});

test("american: case is preserved per surface form", () => {
  const cs = getDialectCorrections(
    "Grey walls. The grey door. COLOUR everywhere, colour on colour.",
    "american",
  );
  assert.deepEqual(pairs(cs), [
    "COLOUR→COLOR",
    "Grey→Gray",
    "colour→color",
    "grey→gray",
  ]);
});

test("british: converts American spellings", () => {
  const cs = getDialectCorrections(
    "The gray fog hid the color of the theater.",
    "british",
  );
  assert.deepEqual(pairs(cs), [
    "color→colour",
    "gray→grey",
    "theater→theatre",
  ]);
});

test("british: one-directional pairs never fire in the unsafe direction", () => {
  const cs = getDialectCorrections(
    "He wrote a check, kicked the curb, changed a tire, told a story, got a license to practice, walked a meter.",
    "british",
  );
  assert.deepEqual(cs, []);
});

test("american: the same one-directional pairs DO fire", () => {
  const cs = getDialectCorrections(
    "He wrote a cheque, kicked the kerb, changed a tyre, on the third storey, licence to practise.",
    "american",
  );
  assert.deepEqual(pairs(cs), [
    "cheque→check",
    "kerb→curb",
    "licence→license",
    "practise→practice",
    "storey→story",
    "tyre→tire",
  ]);
});

test("word boundaries: substrings inside larger words never match", () => {
  // "discolored" contains "colored" but not as a whole word; "greyhound"
  // contains "grey" but not as a whole word.
  assert.deepEqual(
    getDialectCorrections("The discolored greyhound raced by.", "british"),
    [],
  );
  assert.deepEqual(
    getDialectCorrections("The greyhound raced.", "american"),
    [],
  );
});

test("style-guide names are skipped", () => {
  const cs = getDialectCorrections(
    "Mr. Grey wore a grey coat.",
    "american",
    { styleGuideNames: ["Character names: Grey, Tobias"] },
  );
  // "grey" (the color word, lowercase or capitalized) is skipped entirely
  // because the style guide claims the word — better to under-correct than
  // to rename a character.
  assert.deepEqual(cs, []);
});

test("repeated occurrences of one surface form emit a single correction", () => {
  const cs = getDialectCorrections(
    "grey walls, grey doors, grey floors",
    "american",
  );
  assert.equal(cs.length, 1);
  assert.equal(cs[0].original, "grey");
});

test("maxHints caps the output", () => {
  const text = Array.from({ length: 60 }, (_, i) => `colour${i % 2 ? "s" : ""} grey harbour theatre litre fibre`).join(" ");
  const cs = getDialectCorrections(text, "american", { maxHints: 5 });
  assert.equal(cs.length, 5);
});

test("british: newly-added families convert (fervour / -ise / -ment / -yse / -ae)", () => {
  const cs = getDialectCorrections(
    "He realized his fervor, materialized a plan, analyzed the fulfillment, and took an anesthetic.",
    "british",
  );
  assert.deepEqual(pairs(cs), [
    "analyzed→analysed",
    "anesthetic→anaesthetic",
    "fervor→fervour",
    "fulfillment→fulfilment",
    "materialized→materialised",
    "realized→realised",
  ]);
});

test("american: '-wards' directional adverbs drop the trailing -s", () => {
  const cs = getDialectCorrections(
    "She walked towards the door, glanced backwards, then moved forwards and upwards, onwards and outwards.",
    "american",
  );
  assert.deepEqual(pairs(cs), [
    "backwards→backward",
    "forwards→forward",
    "onwards→onward",
    "outwards→outward",
    "towards→toward",
    "upwards→upward",
  ]);
});

test("british: '-wards' directional adverbs gain the trailing -s", () => {
  const cs = getDialectCorrections(
    "She walked toward the door, glanced backward, then moved forward and upward.",
    "british",
  );
  assert.deepEqual(pairs(cs), [
    "backward→backwards",
    "forward→forwards",
    "toward→towards",
    "upward→upwards",
  ]);
});

test("'-wards' matching respects word boundaries (toward is not a substring hit inside towards)", () => {
  assert.deepEqual(getDialectCorrections("towards", "british"), []);
  assert.deepEqual(getDialectCorrections("towards", "american"), [
    { original: "towards", corrected: "toward" },
  ]);
});

test("american: 'no-one' becomes 'no one'", () => {
  assert.deepEqual(getDialectCorrections("No-one came.", "american"), [
    { original: "No-one", corrected: "No one" },
  ]);
});

test("british: 'no one' becomes 'no-one'", () => {
  assert.deepEqual(getDialectCorrections("No one came.", "british"), [
    { original: "No one", corrected: "No-one" },
  ]);
});

test("misc unambiguous pairs: artefact/artifact and cosy/cozy convert both ways", () => {
  assert.deepEqual(
    pairs(getDialectCorrections("The artefact sat in a cosy corner.", "american")),
    ["artefact→artifact", "cosy→cozy"],
  );
  assert.deepEqual(
    pairs(getDialectCorrections("The artifact sat in a cozy corner.", "british")),
    ["artifact→artefact", "cozy→cosy"],
  );
});

test("always -ise words are never touched (either direction)", () => {
  const text =
    "They advertise a surprise that will comprise and compromise the exercise.";
  assert.deepEqual(getDialectCorrections(text, "american"), []);
  assert.deepEqual(getDialectCorrections(text, "british"), []);
});

test("no false positives in neutral text", () => {
  assert.deepEqual(
    getDialectCorrections(
      "She checked the meter reading and told a story about surprise dialogue.",
      "american",
    ),
    [],
  );
});

// ── detectDialect ──

test("detectDialect: a clearly British manuscript is detected as british", () => {
  const text =
    "The grey harbour smelled of the sea. She realised her favourite colour had faded, and the neighbours gathered by the harbour to watch the theatre troupe travelling through, favoured by all.";
  const d = detectDialect(text);
  assert.equal(d.dialect, "british");
  assert.equal(d.mixed, false);
});

test("detectDialect: a clearly American manuscript is detected as american", () => {
  const text =
    "The gray harbor smelled of the sea. She realized her favorite color had faded, and the neighbors gathered by the harbor to watch the theater troupe traveling through, favored by all.";
  const d = detectDialect(text);
  assert.equal(d.dialect, "american");
  assert.equal(d.mixed, false);
});

test("detectDialect: text with no dialect markers returns null, not a guess", () => {
  const d = detectDialect("The cat sat on the mat and looked at the door.");
  assert.equal(d.dialect, null);
  assert.equal(d.mixed, false);
});

test("detectDialect: one stray outlier is not 'mixed'", () => {
  // Mostly British, with a single incidental American spelling — not enough
  // to call the manuscript inconsistent.
  const text =
    "The grey harbour smelled of the sea. She realised her favourite colour had faded. The neighbours gathered by the harbour. The theatre troupe travelled through, favoured by all. Someone mentioned the color once.";
  const d = detectDialect(text);
  assert.equal(d.dialect, "british");
  assert.equal(d.mixed, false);
});

test("detectDialect: genuinely mixed usage is flagged", () => {
  const text =
    "The grey harbour smelled of the sea. She realised her favourite colour had faded. " +
    "The gray harbor smelled of rain. He realized his favorite color had changed too. " +
    "More neighbours gathered by the harbour to watch the theatre troupe.";
  const d = detectDialect(text);
  assert.equal(d.mixed, true);
});
