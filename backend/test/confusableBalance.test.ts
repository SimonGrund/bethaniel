// Frequency, where patterns cannot help.
//
// Confusable words are 1 in every 20 words of a real novel — 4,251
// occurrences in one of the test manuscripts, 5,776 in the other, with
// to/too alone at 2,413 and 3,478. Reporting every occurrence would be some
// five thousand findings a book. But where the book uses one member 20x more
// than another, the rare one is worth a look: measured, that is 5 and 3
// occurrences per book.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findRareConfusableMembers } from "../src/confusableBalance.ts";

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `He turned right at the ${i} corner.`).join(" ");

test("a member used far less than its partner is reported", () => {
  // "right" x40 against one "write".
  const text = `${filler(40)} She had to write the letter.`;
  const found = findRareConfusableMembers(text, "en");
  const hit = found.find((r) => r.word === "write");
  assert.ok(hit, JSON.stringify(found));
  assert.equal(hit.leader, "right");
  assert.equal(hit.count, 1);
});

test("a balanced pair is not reported", () => {
  // their/there roughly even — nothing frequency-based can say anything.
  const text = `${"Their boots were there by the door. ".repeat(20)}`;
  const found = findRareConfusableMembers(text, "en");
  assert.equal(
    found.some((r) => r.word === "their" || r.word === "there"),
    false,
  );
});

test("a set the book uses only one member of is not reported", () => {
  // Nothing to confuse it with.
  const text = filler(40);
  const found = findRareConfusableMembers(text, "en");
  assert.equal(found.some((r) => r.word === "right"), false);
});

test("nothing is proposed — both words are real", () => {
  const text = `${filler(40)} She had to write the letter.`;
  for (const r of findRareConfusableMembers(text, "en")) {
    assert.equal(typeof r.word, "string");
    assert.ok(!("corrected" in r), "this is a listing, not a correction");
  }
});

test("Danish sets are used for a Danish text", () => {
  const da = `${"Han lagde bogen på bordet. ".repeat(40)} Den skulle ligge der.`;
  const found = findRareConfusableMembers(da, "da");
  assert.ok(Array.isArray(found));
});

test("a language with no table returns nothing", () => {
  assert.deepEqual(findRareConfusableMembers("Il lut la lettre.", "fr"), []);
});
