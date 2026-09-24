// ── The typographic marks that are not quotation marks ──
//
// The check exists because two finished books carried 100 and 70 straight
// apostrophes among thousands of curly ones. Every one of those 160 was an
// ordinary contraction or possessive — `the young boy's devotion`, `we don't
// make it home` — and one was a defect neither author had seen: an
// apostrophe typed twice, `the children's’ eager to get started`.
//
// Most of what follows is about what the check must NOT touch. A style is
// only a fault when the book contradicts itself, and the positions where an
// apostrophe and a quotation mark look alike are where a confident repair
// would corrupt someone's dialogue.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectApostropheStyle,
  detectEllipsisStyle,
  findTypographyIssues,
  getTypographyCorrections,
  repairApostrophes,
  repairEllipses,
  repairInvisibles,
} from "../src/typography.ts";

/** A body of curly-apostrophe prose, so a majority exists to judge against. */
const CURLY_BOOK = Array.from(
  { length: 20 },
  (_, i) => `She didn’t answer, and it wasn’t Tobias’s place to ask. ${i}`,
).join("\n\n");

// ── Reading the book's own habit ──

test("the apostrophe style is the manuscript's own majority", () => {
  assert.equal(detectApostropheStyle(CURLY_BOOK), "curly");
  assert.equal(
    detectApostropheStyle(CURLY_BOOK.replace(/’/g, "'")),
    "straight",
  );
});

test("a book set in straight apostrophes is left alone", () => {
  // The whole premise: style is the author's choice, and only inconsistency
  // is a fault. A consistently straight book must produce nothing.
  const straight = CURLY_BOOK.replace(/’/g, "'");
  assert.deepEqual(findTypographyIssues(straight), []);
  assert.deepEqual(getTypographyCorrections(straight), []);
});

test("too few apostrophes to judge means no answer", () => {
  assert.equal(detectApostropheStyle("She didn’t answer."), null);
});

test("a book evenly split has no majority to normalise towards", () => {
  // Picking one would rewrite half the book on a coin toss.
  const mixed = Array.from(
    { length: 10 },
    (_, i) => `She didn’t answer. He didn't either. ${i}`,
  ).join("\n\n");
  assert.equal(detectApostropheStyle(mixed), null);
});

// ── What the repair touches ──

test("an apostrophe between two letters is repaired", () => {
  // The one position no quotation mark can occupy.
  assert.equal(
    repairApostrophes("She didn't answer, and it wasn't Tobias's place.", "curly"),
    "She didn’t answer, and it wasn’t Tobias’s place.",
  );
});

test("a possessive plural is repaired when nothing could have opened a quote", () => {
  assert.equal(
    repairApostrophes("The boys' boots were gone.", "curly"),
    "The boys’ boots were gone.",
  );
});

test("a single-quoted phrase is never touched", () => {
  // The dangerous case, and the reason the trailing position is conditional:
  // the mark after `secret` is a closing quotation mark, not a possessive.
  const nested = `He said, 'a secret' and turned away.`;
  assert.equal(repairApostrophes(nested, "curly"), nested);
});

test("a leading elision is left alone entirely", () => {
  // `'tis` and `'90s` are indistinguishable by position from an opening
  // single quote, and both test books contained three of them between them.
  // Not worth the risk of splicing a mark into someone's dialogue.
  const elision = "It was the '90s, and 'tis a pity.";
  assert.equal(repairApostrophes(elision, "curly"), elision);
});

test("the repair is idempotent", () => {
  const once = repairApostrophes("She didn't go.", "curly");
  assert.equal(repairApostrophes(once, "curly"), once);
});

// ── Ellipses ──

test("three dots become the character in a book that uses it", () => {
  const book = `${"She waited… and waited… and waited…\n\n".repeat(4)}He said... nothing.`;
  assert.equal(detectEllipsisStyle(book), "character");
  assert.equal(repairEllipses("He said... nothing.", "character"), "He said… nothing.");
});

test("the character becomes three dots in a book that types them", () => {
  const book = `${"She waited... and waited... and waited...\n\n".repeat(4)}He said… nothing.`;
  assert.equal(detectEllipsisStyle(book), "dots");
  assert.equal(repairEllipses("He said… nothing.", "dots"), "He said... nothing.");
});

test("four dots are not an ellipsis and are left alone", () => {
  // A sentence-ending ellipsis is four marks in some house styles, and
  // guessing which of the four is the period is not this check's business.
  assert.equal(repairEllipses("He stopped.... Then went on.", "character"),
    "He stopped.... Then went on.");
});

// ── Characters that cannot be seen ──

test("a non-breaking space becomes an ordinary one", () => {
  // It survives every export and holds two words together through
  // justification, opening a river down a printed page.
  assert.equal(repairInvisibles("her thought"), "her thought");
});

test("a zero-width character is removed", () => {
  assert.equal(repairInvisibles("Tobi​as"), "Tobias");
});

test("tabs and trailing spaces are not touched", () => {
  // Invisible too, but structural in Markdown — two trailing spaces are a
  // line break — so removing them would change the text rather than clean it.
  assert.equal(repairInvisibles("a\tb  \n"), "a\tb  \n");
});

// ── Placeholders ──

test("a drafting placeholder is found", () => {
  const issues = findTypographyIssues("He walked in. TODO: describe the room.");
  const found = issues.find((i) => i.kind === "placeholder");
  assert.ok(found, "expected a placeholder finding");
  assert.deepEqual(found.markers, ["TODO"]);
});

test("a placeholder is never auto-corrected", () => {
  // What should replace TODO is the one thing here only the author knows.
  const cs = getTypographyCorrections("He walked in. TODO: describe the room.");
  assert.deepEqual(cs, []);
});

test("an ordinary word is not a placeholder", () => {
  // All-caps and bounded by non-letters, so a name and a word that merely
  // contains the letters are both safe.
  for (const text of ["She met Tk at dawn.", "A todo list lay open.", "Toxxxic."]) {
    assert.deepEqual(
      findTypographyIssues(text).filter((i) => i.kind === "placeholder"),
      [],
      text,
    );
  }
});

// ── How it is reported ──

test("one finding per kind, carrying its count", () => {
  // Ninety-three straight apostrophes is one decision applied ninety-three
  // times. Listing them separately would bury every other finding, and —
  // before the score's info band was capped — put a clean book in the red.
  const book = `${CURLY_BOOK}\n\n${"He didn't. She wasn't. They weren't.\n\n".repeat(5)}`;
  const issues = findTypographyIssues(book);
  const apostrophe = issues.filter((i) => i.kind === "apostrophe-style");
  assert.equal(apostrophe.length, 1);
  assert.equal(apostrophe[0].count, 15);
  assert.ok(apostrophe[0].example.includes("didn't"), apostrophe[0].example);
});

test("a declared style outranks the manuscript's own majority", () => {
  // Same rule as resolveConvention: a book set to curly is told about its
  // straight apostrophes even at 60% curly, because that is the direction
  // the copy edit would move it.
  const mixed = Array.from(
    { length: 10 },
    (_, i) => `She didn’t answer. He didn't either. ${i}`,
  ).join("\n\n");
  assert.equal(findTypographyIssues(mixed).length, 0);
  const declared = findTypographyIssues(mixed, "curly");
  assert.equal(declared[0].kind, "apostrophe-style");
  assert.equal(declared[0].count, 10);
});

test("a correction is one paragraph, pre-approved, and applies cleanly", () => {
  // One per paragraph for quoteRepair's reason: two corrections cut from the
  // same paragraph have overlapping spans, and applying the first leaves the
  // second unable to find its own text.
  const book = `${CURLY_BOOK}\n\nHe didn't go. She wasn't there. They weren't either.`;
  const cs = getTypographyCorrections(book);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].preApproved, true);
  assert.equal(cs[0].reason, "typography");
  assert.ok(book.includes(cs[0].original), "the original must be in the text");
  assert.equal(
    cs[0].corrected,
    "He didn’t go. She wasn’t there. They weren’t either.",
  );
});
