// ── The text around a suggestion on a review card ──
//
// The card's context used to run out to the nearest ". ! ?", and dialogue,
// headings and scene breaks end in none of them — so one card could carry
// several paragraphs and push Accept and Dismiss below the fold. These pin
// the compact reading to the change's own paragraph and sentence, and the
// extended one to a paragraph either side.
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMPACT_SIDE,
  EXTENDED_SIDE,
  compactContext,
  extendedContext,
} from "../../frontend/src/deckContext.ts";

test("compact: the sentence around the change", () => {
  const text = "It rained. Instead she felt only a quiet , surprising tenderness. Then he left.";
  const ctx = compactContext("quiet ,", text);
  assert.equal(ctx.before, "Instead she felt only a");
  assert.equal(ctx.after, "surprising tenderness.");
});

test("compact: never crosses a line break, even with no full stop", () => {
  const text = [
    "“Where are you going”",
    "",
    "“Out”",
    "",
    "* * *",
    "",
    "She walked to the door and teh wind came in",
    "",
    "“Close it”",
    "",
    "“No”",
  ].join("\n");
  const ctx = compactContext("teh", text);
  assert.equal(ctx.before, "She walked to the door and");
  assert.equal(ctx.after, "wind came in");
  assert.ok(!ctx.before.includes("\n") && !ctx.after.includes("\n"));
});

test("compact: a change opening its sentence brings the one before", () => {
  const text = "He sat down. She stood. Teh room was cold.";
  const ctx = compactContext("Teh", text);
  assert.equal(ctx.before, "She stood.");
  assert.equal(ctx.after, "room was cold.");
});

test("compact: a closing quote still ends the sentence", () => {
  const text = "“Go home.” She said it twice. teh end came later.";
  const ctx = compactContext("She said", text);
  assert.equal(ctx.before, "“Go home.”");
  assert.equal(ctx.after, "it twice. teh end came later.");
});

test("compact: a long run-on sentence is capped on both sides", () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const text = `${words} teh ${words}`;
  const ctx = compactContext("teh", text);
  assert.ok(ctx.before.startsWith("…"));
  assert.ok(ctx.after.endsWith("…"));
  assert.ok(ctx.before.length <= COMPACT_SIDE + 1);
  assert.ok(ctx.after.length <= COMPACT_SIDE + 1);
});

test("extended: one paragraph either side, blank runs collapsed", () => {
  const text = "First.\n\nSecond para.\n\n\n\nThird has teh change.\n\nFourth.\n\nFifth.";
  const ctx = extendedContext("teh", text);
  assert.equal(ctx.before, "Second para.\n\nThird has");
  assert.equal(ctx.after, "change.\n\nFourth.");
});

test("extended: a change at a paragraph's edge keeps the break", () => {
  const text = "Before.\n\nTeh start.\n\nAfter.";
  assert.equal(extendedContext("Teh", text).before, "Before.\n\n");
  const end = "Before.\n\nAt the end teh\n\nAfter.";
  assert.equal(extendedContext("teh", end).after, "\n\nAfter.");
});

test("extended: a page-long paragraph is still capped", () => {
  const words = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" ");
  const ctx = extendedContext("teh", `${words} teh ${words}`);
  assert.ok(ctx.before.length <= EXTENDED_SIDE + 1);
  assert.ok(ctx.after.length <= EXTENDED_SIDE + 1);
});

test("nothing found: no context rather than the wrong one", () => {
  assert.deepEqual(compactContext("absent phrase", "Some text."), { before: "", after: "" });
  assert.deepEqual(extendedContext("absent phrase", "Some text."), { before: "", after: "" });
});
