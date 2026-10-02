// ── The deck's copy of dropCoveredFindings ──
//
// Results saved before the backend learned to drop a no-fix finding that
// another fix already answers still carry both, so the deck filters them
// too. Same rule, same cases as correctionHygiene.test.ts — keep in step.
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import { dropCoveredFindings } from "../../frontend/src/coveredFindings.ts";

const text =
  "These ships carried the greatest fighters from his empire: brutal barbarian warriors from the north, swift sworddancers of the east, and talented archers from the South.";
const finding = { original: "sworddancers", corrected: "sworddancers", confidence: 5 };
const fix = { original: "swift sworddancers of", corrected: "swift sword dancers of", confidence: 5 };

test("the finding goes when a fix of the same word covers it (the HP1 case)", () => {
  assert.deepEqual(dropCoveredFindings(text, [fix, finding]), [fix]);
});

test("a fix that keeps the word answers nothing", () => {
  const comma = { original: "sworddancers of", corrected: "sworddancers, of", confidence: 4 };
  assert.equal(dropCoveredFindings(text, [comma, finding]).length, 2);
});

test("a fix the reviewer rejected answers nothing", () => {
  const rejected = { original: "sworddancers", corrected: "sword-dancers", confidence: 1 };
  assert.equal(dropCoveredFindings(text, [rejected, finding]).length, 2);
});

test("an occurrence no fix touches keeps the finding", () => {
  const more = `${text} Later the sworddancers rested.`;
  assert.equal(dropCoveredFindings(more, [fix, finding]).length, 2);
});

test("a word inside a longer word is not an occurrence", () => {
  const glued = `${text} The sworddancersguild met.`;
  assert.deepEqual(dropCoveredFindings(glued, [fix, finding]), [fix]);
});

test("no findings: the list comes back as it was", () => {
  const cs = [fix];
  assert.equal(dropCoveredFindings(text, cs), cs);
});

test("a fix that only changes the word's case answers nothing", () => {
  const caps = { original: "swift sworddancers of", corrected: "swift Sworddancers of", confidence: 5 };
  assert.equal(dropCoveredFindings(text, [caps, finding]).length, 2);
});
