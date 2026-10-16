// A contents page lists every chapter title, so its lines used to be taken
// for the chapters themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findChapters } from "../src/chapters.ts";

const body = (n: number) => `It was a long day at the harbour, number ${n}. `.repeat(12).trim();
const book = (contents: string) =>
  [contents, ...[1, 2, 3, 4].map((n) => `Chapter ${n}\n\n${body(n)}`)].join("\n\n");

const titles = (text: string, cells?: Set<string>) =>
  findChapters(text, cells).map((c) => c.title);

test("a contents page with page numbers is not chapters", () => {
  const text = book("Contents\n\nChapter 1 ........ 3\n\nChapter 2 ........ 9\n\nChapter 3 ........ 15\n\nChapter 4 ........ 22");
  assert.deepEqual(titles(text), ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"]);
  const ch1 = findChapters(text)[0];
  assert.ok(text.slice(ch1.start, ch1.end).includes("harbour, number 1"));
  assert.ok(!text.slice(findChapters(text)[1].start).includes("........"));
});

test("a contents list without page numbers is not chapters", () => {
  const text = book("Chapter 1\n\nChapter 2\n\nChapter 3\n\nChapter 4");
  const found = findChapters(text);
  assert.deepEqual(found.map((c) => c.title), ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"]);
  // Each chapter's text is its own, not the contents entry before it.
  assert.ok(text.slice(found[1].start, found[1].end).includes("number 2"));
  assert.ok(!text.slice(found[1].start, found[1].end).includes("number 1"));
});

test("a contents table from a .docx is not chapters", () => {
  const cells = ["Chapter 1", "3", "Chapter 2", "9"];
  const text = [cells.join("\n\n"), `Chapter 1\n\n${body(1)}`, `Chapter 2\n\n${body(2)}`].join("\n\n");
  const found = findChapters(text, new Set(["3", "9"]));
  assert.ok(text.slice(found[found.length - 1].start).includes("number 2"));
  assert.ok(!text.slice(found[found.length - 1].start).includes("number 1"));
});

test("a part heading straight before a chapter heading still counts", () => {
  const text = `Part One\n\nChapter 1\n\n${body(1)}\n\nChapter 2\n\n${body(2)}`;
  assert.ok(titles(text).includes("Chapter 1"));
  assert.ok(titles(text).includes("Chapter 2"));
});
