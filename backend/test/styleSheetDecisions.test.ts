// ── The author's answers about Betty's reading of their style sheet ──

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decisionWithoutCard,
  knownStatements,
  markWord,
  needsCard,
  rulesForRun,
  type SheetDecision,
} from "../../frontend/src/styleSheetDecisions.ts";

const guide = "Pirates speak wrong on purpose.\nWrite “traveled”, not “travelled”.";

const decisions: Record<string, SheetDecision> = {
  "Pirates speak wrong on purpose.": {
    kind: "dialogue",
    source: "Pirates speak wrong on purpose.",
    accepted: true,
    speakers: ["Lulu"],
  },
  "Write “traveled”, not “travelled”.": {
    kind: "replace",
    source: "Write “traveled”, not “travelled”.",
    accepted: false,
    prefer: "traveled",
    avoid: ["travelled"],
  },
  "A line the author has since deleted.": {
    kind: "keep",
    source: "A line the author has since deleted.",
    accepted: true,
    terms: ["Gone"],
  },
};

test("only notes and the author's own house-style answers skip the card", () => {
  assert.equal(needsCard({ kind: "note", source: "x" }), false);
  assert.equal(needsCard({ kind: "replace", source: "x", settled: true }), false);
  assert.equal(needsCard({ kind: "keep", source: "x", terms: ["A"] }), true);
  // A settled line is a rule without asking; a note is not a rule.
  assert.equal(decisionWithoutCard({ kind: "replace", source: "x", settled: true }).accepted, true);
  assert.equal(decisionWithoutCard({ kind: "note", source: "y" }).accepted, false);
});

test("a statement is read once while it is in the guide", () => {
  assert.deepEqual(knownStatements(decisions, guide), [
    "Pirates speak wrong on purpose.",
    "Write “traveled”, not “travelled”.",
  ]);
  assert.deepEqual(knownStatements(undefined, guide), []);
});

test("the run carries the accepted rules still in the guide, without the answer flag", () => {
  assert.deepEqual(rulesForRun(decisions, guide), [
    { kind: "dialogue", source: "Pirates speak wrong on purpose.", speakers: ["Lulu"] },
  ]);
});

test("the word in question is marked in its sentence, whole-word only", () => {
  assert.deepEqual(markWord("He gave in, and she would give it.", "give"), ["He gave in, and she would ", "give", " it."]);
  assert.deepEqual(markWord("Forgive me.", "give"), ["Forgive me.", "", ""]);
  assert.deepEqual(markWord("No word.", undefined), ["No word.", "", ""]);
});
