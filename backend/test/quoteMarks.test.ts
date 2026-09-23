// One reading of a quotation mark, shared by the publication scan and the
// quote repair. The two used to disagree — quoteRepair counted straight
// marks, publicationScan did not — and every defect the scan missed on a
// real book lived in exactly that gap.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  expectedRoles,
  detectQuoteFamily,
  detectDominantStyle,
  resolveConvention,
  readMarks,
} from "../src/quoteMarks.ts";

test("English curly is the default family", () => {
  const f = detectQuoteFamily("“Hello,” she said. “Goodbye.”");
  assert.equal(f.open, "“");
  assert.equal(f.close, "”");
});

test("German „ “ wins over English, whose opener is its closer", () => {
  const f = detectQuoteFamily("„Guten Tag,“ sagte sie. „Auf Wiedersehen.“");
  assert.equal(f.open, "„");
  assert.equal(f.close, "“");
});

test("French guillemets are read as their own family", () => {
  const f = detectQuoteFamily("« Bonjour », dit-elle. « Au revoir. »");
  assert.equal(f.open, "«");
  assert.equal(f.close, "»");
});

test("a book of curly marks with a few strays is curly", () => {
  const text = `${"“Yes,” she said. ".repeat(10)}"No," he said.`;
  assert.equal(detectDominantStyle(text), "curly");
});

test("a book of straight marks is straight, and is not an error", () => {
  const text = '"Yes," she said. "No," he said. "Maybe," they said.';
  assert.equal(detectDominantStyle(text), "straight");
});

test("too few marks is no style at all", () => {
  assert.equal(detectDominantStyle('He said "yes".'), null);
});

test("genuinely mixed is no style at all", () => {
  const text = `${'"Yes," she said. '.repeat(5)}${"“No,” he said. ".repeat(5)}`;
  assert.equal(detectDominantStyle(text), null);
});

test("a declared style beats the manuscript's own majority", () => {
  const mostlyCurly = "“Yes,” she said. ".repeat(10);
  assert.equal(resolveConvention(mostlyCurly, "straight").style, "straight");
  assert.equal(resolveConvention(mostlyCurly).style, "curly");
});

test("a declared style still leaves the family read off the text", () => {
  const french = "« Bonjour », dit-elle. « Au revoir. » « Oui. »";
  assert.equal(resolveConvention(french, "curly").family.open, "«");
});

test("straight marks take their role from alternation", () => {
  const conv = resolveConvention("“a” “b” “c” “d”");
  const marks = readMarks('“But—"', conv);
  assert.deepEqual(
    marks.map((m) => m.role),
    ["open", "close"],
  );
  assert.deepEqual(
    marks.map((m) => m.char),
    ["“", '"'],
  );
});

test("family marks take their role from their character, not alternation", () => {
  const conv = resolveConvention("“a” “b” “c” “d”");
  // Two closers in a row: a real defect, and alternation would call the
  // second one an opener. The character is the truth.
  const marks = readMarks("”Good.”", conv);
  assert.deepEqual(
    marks.map((m) => m.role),
    ["close", "close"],
  );
});

test("indexes point at the marks themselves", () => {
  const conv = resolveConvention("“a” “b” “c” “d”");
  const marks = readMarks("“Hi.”", conv);
  assert.deepEqual(
    marks.map((m) => m.index),
    [0, 4],
  );
});

test("apostrophes and single quotes are not marks", () => {
  const conv = resolveConvention("“a” “b” “c” “d”");
  assert.equal(readMarks("It’s Bria’s ‘thing’, he said.", conv).length, 0);
});

test("expected roles alternate, whatever the characters say", () => {
  const conv = resolveConvention("“a” “b” “c” “d”");
  // “Good.“ — the closing mark typed the wrong way round. readMarks reports
  // what it IS (two openers); expectedRoles reports what it SHOULD be, which
  // is how the quote repair knows to turn the second one around.
  const marks = readMarks("“Good.“", conv);
  assert.deepEqual(
    marks.map((m) => m.role),
    ["open", "open"],
  );
  assert.deepEqual(expectedRoles(marks), ["open", "close"]);
});
