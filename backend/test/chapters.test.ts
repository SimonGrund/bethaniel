// Tests for part grouping — the middle tier of the story-analysis hierarchy.
// Explicit Part/Book headings win; otherwise chapters are auto-grouped into
// runs of 4-6; short books (< 8 chapters) get a single implicit part.

import { test } from "node:test";
import assert from "node:assert/strict";

import { groupIntoParts } from "../src/chapters.ts";

test("explicit Part headings define the groups", () => {
  const names = [
    "Part One",
    "Chapter 1",
    "Chapter 2",
    "Chapter 3",
    "Part Two: Reunion",
    "Chapter 4",
    "Chapter 5",
  ];
  const parts = groupIntoParts(names);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, "Part One");
  assert.deepEqual(parts[0].unitIndices, [0, 1, 2, 3]);
  assert.equal(parts[1].title, "Part Two: Reunion");
  assert.deepEqual(parts[1].unitIndices, [4, 5, 6]);
});

test("leading units (prologue) attach to the first explicit part", () => {
  const names = ["Prologue", "Part One", "Chapter 1", "Part Two", "Chapter 2"];
  const parts = groupIntoParts(names);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].unitIndices, [0, 1, 2]);
  assert.deepEqual(parts[1].unitIndices, [3, 4]);
});

test("localized part headings are recognized (Del 2)", () => {
  const names = [
    "Del 1",
    "Kapitel 1",
    "Kapitel 2",
    "Del 2",
    "Kapitel 3",
    "Kapitel 4",
  ];
  const parts = groupIntoParts(names);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, "Del 1");
  assert.equal(parts[1].title, "Del 2");
});

test("short book (< 8 chapters) gets a single implicit part", () => {
  const names = ["Ch 1", "Ch 2", "Ch 3", "Ch 4", "Ch 5", "Ch 6", "Ch 7"];
  const parts = groupIntoParts(names);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].unitIndices, [0, 1, 2, 3, 4, 5, 6]);
});

test("a single part heading does not count as explicit structure", () => {
  const names = ["Part One", "Ch 1", "Ch 2", "Ch 3"];
  const parts = groupIntoParts(names);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].unitIndices, [0, 1, 2, 3]);
});

test("8 chapters auto-group as 4+4", () => {
  const names = Array.from({ length: 8 }, (_, i) => `Chapter ${i + 1}`);
  const parts = groupIntoParts(names);
  assert.deepEqual(
    parts.map((p) => p.unitIndices.length),
    [4, 4],
  );
});

test("13 chapters auto-group with sizes between 4 and 6, in order", () => {
  const names = Array.from({ length: 13 }, (_, i) => `Chapter ${i + 1}`);
  const parts = groupIntoParts(names);
  const sizes = parts.map((p) => p.unitIndices.length);
  assert.equal(
    sizes.reduce((a, b) => a + b, 0),
    13,
  );
  for (const s of sizes) assert.ok(s >= 4 && s <= 6, `bad size ${s}`);
  // Indices are contiguous and cover 0..12 in order
  assert.deepEqual(
    parts.flatMap((p) => p.unitIndices),
    Array.from({ length: 13 }, (_, i) => i),
  );
});

test("auto-group titles describe the chapter range", () => {
  const names = Array.from({ length: 10 }, (_, i) => `Chapter ${i + 1}`);
  const parts = groupIntoParts(names);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].title.includes("1"));
  assert.ok(parts[0].title.includes("5"));
});

test("chapter names containing 'part' mid-title are not part headings", () => {
  const names = [
    "Chapter 1: A Part of Me",
    "Chapter 2",
    "Chapter 3",
    "Chapter 4",
  ];
  const parts = groupIntoParts(names);
  assert.equal(parts.length, 1);
});
