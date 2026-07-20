// Tests for the deterministic English-dialect normalization pass. The LLM
// prompt's "convert known pairs" instruction misses occurrences (a real
// manuscript shipped with both "Grey" and "Gray" under the American setting);
// this pass catches every curated pair mechanically, with case preserved.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getDialectCorrections } from "../src/dialect.ts";

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

test("no false positives in neutral text", () => {
  assert.deepEqual(
    getDialectCorrections(
      "She checked the meter reading and told a story about surprise dialogue.",
      "american",
    ),
    [],
  );
});
