// A title page is not a chapter, and neither is a chapter heading stranded on
// a page of its own.
//
// Both look exactly like chapter starts to the detector, so an uploaded
// manuscript arrived with "My Novel" and "Chapter One" as their own units — a
// handful of words each, queued and edited as if they were prose. Anything
// shorter than a chapter plausibly can be belongs to the chapter it introduces.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findChapters, MIN_CHAPTER_WORDS } from "../src/chapters.ts";

/** ~n words of filler prose, so a section reads as a real chapter. */
function prose(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
}

/** Every chapter's text, so nothing can be silently dropped by a merge. */
function coverage(text: string, chapters: { start: number; end: number }[]) {
  return chapters.map((c) => text.slice(c.start, c.end)).join("");
}

test("a title page is folded into the chapter it introduces", () => {
  const text = [
    "# My Novel",
    "",
    "A novel by Simon Grund",
    "",
    "# Chapter One",
    "",
    prose(300),
    "",
    "# Chapter Two",
    "",
    prose(300),
  ].join("\n");

  const chapters = findChapters(text);
  assert.equal(chapters.length, 2, chapters.map((c) => c.title).join(" | "));
  assert.equal(chapters[0].title, "Chapter One");
  assert.equal(chapters[1].title, "Chapter Two");

  // The title page must still be IN the manuscript, just not its own chapter.
  assert.match(text.slice(chapters[0].start, chapters[0].end), /My Novel/);
  assert.equal(coverage(text, chapters), text, "text was lost in the merge");
});

test("several short sections in a row all fold into the first real chapter", () => {
  const text = [
    "# My Novel",
    "",
    "A novel by Simon Grund",
    "",
    "# Copyright",
    "",
    "All rights reserved.",
    "",
    "# Dedication",
    "",
    "For my mother.",
    "",
    "# Chapter One",
    "",
    prose(300),
  ].join("\n");

  const chapters = findChapters(text);
  assert.equal(chapters.length, 1, chapters.map((c) => c.title).join(" | "));
  assert.equal(chapters[0].title, "Chapter One");
  assert.match(text.slice(chapters[0].start, chapters[0].end), /Dedication/);
  assert.equal(coverage(text, chapters), text);
});

test("a chapter heading stranded on its own page joins its prose", () => {
  // The heading is detected, then the page break before the body is detected
  // too, so the heading became a unit of two words.
  const text = [
    "# Chapter One",
    "",
    prose(300),
    "",
    "# Chapter Two",
    "",
    "",
    "# Chapter Two",
    "",
    prose(300),
  ].join("\n");

  const chapters = findChapters(text);
  assert.ok(
    chapters.every((c) => c.wordCount >= MIN_CHAPTER_WORDS),
    chapters.map((c) => `${c.title}:${c.wordCount}`).join(" | "),
  );
  assert.equal(coverage(text, chapters), text);
});

test("a short section at the very end folds backwards instead", () => {
  // Nothing follows it, so the only place it can belong is the chapter before.
  const text = [
    "# Chapter One",
    "",
    prose(300),
    "",
    "# Chapter Two",
    "",
    prose(300),
    "",
    "# The End",
    "",
    "Thank you for reading.",
  ].join("\n");

  const chapters = findChapters(text);
  assert.equal(chapters.length, 2, chapters.map((c) => c.title).join(" | "));
  assert.equal(chapters[1].title, "Chapter Two");
  assert.match(text.slice(chapters[1].start, chapters[1].end), /Thank you/);
  assert.equal(coverage(text, chapters), text);
});

test("real chapters are left exactly as they were", () => {
  const text = [
    "# Chapter One",
    "",
    prose(300),
    "",
    "# Chapter Two",
    "",
    prose(300),
    "",
    "# Chapter Three",
    "",
    prose(300),
  ].join("\n");

  const chapters = findChapters(text);
  assert.equal(chapters.length, 3);
  assert.deepEqual(
    chapters.map((c) => c.title),
    ["Chapter One", "Chapter Two", "Chapter Three"],
  );
});

test("a book whose chapters are ALL short is left alone", () => {
  // Poetry, a children's book, a novel of one-page chapters: here short is the
  // chapter length, and merging would collapse the whole work into one unit.
  // The rule exists to catch a title page among real chapters, not to overrule
  // a book's own shape.
  const text = [
    "# One",
    "",
    "A few words.",
    "",
    "# Two",
    "",
    "A few more.",
    "",
    "# Three",
    "",
    "And a few after that.",
  ].join("\n");
  const chapters = findChapters(text);
  assert.equal(chapters.length, 3, chapters.map((c) => c.title).join(" | "));
  assert.equal(coverage(text, chapters), text);
});

test("a collection of short pieces around one long one is still a collection", () => {
  // 20 poems and one longer closing piece. A bare "is there anything
  // substantial to merge into?" test would sweep all twenty into the last one.
  const pieces: string[] = [];
  for (let i = 1; i <= 20; i++) {
    pieces.push(`# Poem ${i}`, "", "A short verse, barely a breath long.", "");
  }
  pieces.push("# The Long One", "", prose(300));
  const text = pieces.join("\n");

  const chapters = findChapters(text);
  assert.equal(chapters.length, 21, `collapsed to ${chapters.length}`);
  assert.equal(coverage(text, chapters), text);
});

test("a single short chapter is left alone", () => {
  const text = "# Chapter One\n\nIt was over before it began.";
  const chapters = findChapters(text);
  assert.ok(chapters.length <= 1);
  if (chapters.length === 1) {
    assert.equal(coverage(text, chapters), text);
  }
});

test("word counts are recomputed after a merge, not carried over", () => {
  const text = [
    "# My Novel",
    "",
    "A novel by Simon Grund",
    "",
    "# Chapter One",
    "",
    prose(300),
  ].join("\n");

  const [only] = findChapters(text);
  const actual = text
    .slice(only.start, only.end)
    .split(/\s+/)
    .filter(Boolean).length;
  assert.equal(only.wordCount, actual);
});
