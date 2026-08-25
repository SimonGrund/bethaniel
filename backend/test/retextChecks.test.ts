// Tests for the retext deterministic checks: each retext plugin message must
// become a Correction whose `original` carries enough surrounding context to
// be applied unambiguously (short actuals like "a" are not unique), and
// applying the corrections must fix the text.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getRetextCorrections, findRepeatedPhrases } from "../src/retextChecks.ts";
import { applyCorrections } from "../src/llm.ts";

async function fix(text: string): Promise<string> {
  const cs = await getRetextCorrections(text, "en");
  const [out] = applyCorrections(text, cs);
  return out;
}

test("indefinite article: 'a hour' → 'an hour' (context makes it unique)", async () => {
  const cs = await getRetextCorrections("She waited a hour before a train left.", "en");
  // "a" is not unique — the correction's original must include context.
  assert.ok(cs.length >= 1);
  assert.ok(cs.every((c) => c.original.length > 1), "originals need surrounding context");
  assert.equal(await fix("She waited a hour before a train left."), "She waited an hour before a train left.");
});

test("contractions: missing apostrophe is fixed", async () => {
  assert.equal(await fix("I dont know."), "I don't know.");
});

test("repeated words: collapse preserves the first token's capitalization", async () => {
  // expected[] from retext is lowercased ("the"); we must keep "The".
  assert.equal(await fix("The the cat ran."), "The cat ran.");
});

test("redundant acronyms: 'PIN number' → 'PIN'", async () => {
  assert.equal(await fix("Enter your PIN number now."), "Enter your PIN now.");
});

test("clean English text produces no corrections", async () => {
  assert.deepEqual(await getRetextCorrections("The cat ran fast. She smiled.", "en"), []);
});

test("non-English manuscripts are skipped (English-only rules)", async () => {
  assert.deepEqual(await getRetextCorrections("Han gik hjem a hour.", "da"), []);
});

test("each correction is tagged with a retext reason", async () => {
  const cs = await getRetextCorrections("I dont know.", "en");
  assert.ok(cs.length >= 1);
  assert.ok(cs.every((c) => (c.reason ?? "").startsWith("retext")));
});

// ── findRepeatedPhrases: duplicated multi-word phrases, e.g. "in weeks in weeks" ──

test("repeated phrase: 'in weeks in weeks' is flagged and fixed", () => {
  const text = "The first hint of a smile in weeks in weeks.";
  const cs = findRepeatedPhrases(text);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].reason, "retext:repeated-phrase");
  const [out] = applyCorrections(text, cs);
  assert.equal(out, "The first hint of a smile in weeks.");
});

test("repeated phrase: a single repeated word is left to retext-repeated-words", () => {
  // "north north" is a single-word repeat, not a phrase repeat — out of scope here.
  assert.deepEqual(findRepeatedPhrases("ride to the north north, or south"), []);
});

test("repeated phrase: repetition split across a sentence boundary is not flagged", () => {
  assert.deepEqual(
    findRepeatedPhrases("She waited in silence. In silence, she waited."),
    [],
  );
});

test("repeated phrase: clean text produces nothing", () => {
  assert.deepEqual(findRepeatedPhrases("The cat ran fast. She smiled."), []);
});

test("getRetextCorrections also surfaces repeated phrases", async () => {
  const cs = await getRetextCorrections(
    "The first hint of a smile in weeks in weeks.",
    "en",
  );
  assert.ok(cs.some((c) => c.reason === "retext:repeated-phrase"));
});
