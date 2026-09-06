// The existing translation benchmark asks a judge model to rate each
// paragraph 1-5. On the last run every model scored 4.2-5.0, three of nine
// rows at a flat 5.0, and the largest model judged its own output. These
// metrics replace that with pure functions of two strings: same answer every
// run, no model, no self-judging.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chrf,
  lengthRatio,
  sourceLeakage,
  scoreTranslation,
} from "../src/translationQuality.ts";

// ── chrF ────────────────────────────────────────────────────────────────────

test("an identical translation scores 100", () => {
  const s = "Da brevet kom, havde hun ikke bundet en bog i ni år.";
  assert.equal(Math.round(chrf(s, s)), 100);
});

test("a completely different translation scores near zero", () => {
  const score = chrf("xyz qqq wvu", "Da brevet kom, havde hun ikke bundet en bog.");
  assert.ok(score < 10, `expected near zero, got ${score}`);
});

test("empty input scores 0 rather than dividing by zero", () => {
  assert.equal(chrf("", "noget tekst"), 0);
  assert.equal(chrf("noget tekst", ""), 0);
  assert.equal(chrf("", ""), 0);
});

test("a near miss on inflection stays high — the reason chrF is the metric", () => {
  // Word-level metrics score this pair at zero on the differing token.
  // Character n-grams see that "bogbinderen" and "bogbinder" share a stem,
  // which is the whole point for Danish and German morphology.
  const inflected = chrf("Hun var bogbinderen i byen.", "Hun var bogbinder i byen.");
  assert.ok(inflected > 80, `expected a high score, got ${inflected}`);
});

test("word order matters less than content, but it does matter", () => {
  const ref = "Regnen var holdt op, og en bleg sol skubbede sig frem.";
  const reordered = "En bleg sol skubbede sig frem, og regnen var holdt op.";
  const score = chrf(reordered, ref);
  assert.ok(score > 55 && score < 100, `expected partial credit, got ${score}`);
});

test("chrF++ scores lower than chrF when word order is wrong", () => {
  // The word n-grams chrF++ adds are exactly what reordering breaks.
  const ref = "Regnen var holdt op, og en bleg sol skubbede sig frem.";
  const reordered = "En bleg sol skubbede sig frem, og regnen var holdt op.";
  assert.ok(chrf(reordered, ref, { wordOrder: 2 }) < chrf(reordered, ref));
});

test("recall is weighted above precision — an omission hurts more than padding", () => {
  const ref = "Hun stod i sin mors værksted mellem reoler fulde af tavse bind.";
  const omitted = "Hun stod i sin mors værksted.";
  const padded = ref + " Det var en kold dag i november måned.";
  assert.ok(
    chrf(omitted, ref) < chrf(padded, ref),
    "dropping half the sentence must cost more than adding a clause",
  );
});

// ── length ratio ────────────────────────────────────────────────────────────

test("lengthRatio is 1 for an equal-length rendering", () => {
  assert.equal(lengthRatio("abcde", "abcde"), 1);
});

test("lengthRatio catches a translation that stopped early", () => {
  const ref = "Hun stod i sin mors værksted mellem reoler fulde af tavse bind.";
  assert.ok(lengthRatio("Hun stod i sin mors", ref) < 0.5);
});

test("lengthRatio catches a model that padded or repeated itself", () => {
  const ref = "Hun stod i værkstedet.";
  assert.ok(lengthRatio(ref + ref + ref, ref) > 2);
});

test("lengthRatio treats an empty reference as 0 rather than Infinity", () => {
  assert.equal(lengthRatio("noget", ""), 0);
});

// ── source leakage ──────────────────────────────────────────────────────────

test("untranslated source words are detected", () => {
  const source = "She stood in her mother's workshop between shelves of silent bindings.";
  const reference = "Hun stod i sin mors værksted mellem reoler fulde af tavse bind.";
  const leaked = "Hun stod i sin mors workshop mellem reoler fulde af tavse bindings.";
  assert.ok(sourceLeakage(leaked, source, reference) > 0);
  assert.equal(sourceLeakage(reference, source, reference), 0);
});

test("a proper noun carried across is not leakage", () => {
  // Names are supposed to survive translation untouched.
  const source = "Ejnar Krogh came on Tuesday.";
  const reference = "Ejnar Krogh kom på tirsdag.";
  assert.equal(sourceLeakage("Ejnar Krogh kom på tirsdag.", source, reference), 0);
});

test("a word shared by both languages is not leakage", () => {
  // "bog" is Danish for book; if it is in the reference it is correct here,
  // whatever the source happens to contain.
  const source = "The bog was cold.";
  const reference = "Bogen var kold.";
  assert.equal(sourceLeakage("Bogen var kold.", source, reference), 0);
});

test("leakage is a share, so it is comparable across passage lengths", () => {
  const source = "workshop shelves";
  const reference = "værksted reoler";
  const half = sourceLeakage("workshop reoler", source, reference);
  assert.ok(half > 0.4 && half < 0.6, `expected ~0.5, got ${half}`);
});

// ── the bundle ──────────────────────────────────────────────────────────────

test("scoreTranslation reports all four numbers", () => {
  const source = "She stood in her mother's workshop.";
  const reference = "Hun stod i sin mors værksted.";
  const s = scoreTranslation(reference, source, reference);
  assert.equal(Math.round(s.chrf), 100);
  assert.equal(Math.round(s.chrfPlusPlus), 100);
  assert.equal(s.lengthRatio, 1);
  assert.equal(s.sourceLeakage, 0);
});

test("a bad translation is bad on more than one axis", () => {
  // What the benchmark is meant to catch: the judge rubric scored runs like
  // this a 4 out of 5.
  const source = "She stood in her mother's workshop between shelves of silent bindings.";
  const reference = "Hun stod i sin mors værksted mellem reoler fulde af tavse bind.";
  const bad = "She stood in the workshop.";
  const s = scoreTranslation(bad, source, reference);
  assert.ok(s.chrf < 40, `chrf ${s.chrf}`);
  assert.ok(s.lengthRatio < 0.6, `ratio ${s.lengthRatio}`);
  assert.ok(s.sourceLeakage > 0.2, `leakage ${s.sourceLeakage}`);
});
