// Quote style is a convention the manuscript can answer for itself, like the
// dialect and the comma rules beside it. It is detected so the author can
// confirm it — never so the app can decide alone. A book that is 60% curly
// must not be "normalised" to curly behind its author's back.

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectQuoteStyle, detectSettings } from "../src/detectSettings.ts";

const NARRATION =
  "He walked on through the rain, and the road went with him. ".repeat(40);

test("a curly manuscript is detected as curly", () => {
  const md = `${NARRATION}\n\n${"“Yes,” she said. ".repeat(20)}`;
  const d = detectQuoteStyle(md);
  assert.equal(d.status, "detected");
  assert.equal(d.status === "detected" && d.value, "curly");
});

test("a straight manuscript is detected as straight, not corrected", () => {
  const md = `${NARRATION}\n\n${'"Yes," she said. '.repeat(20)}`;
  const d = detectQuoteStyle(md);
  assert.equal(d.status, "detected");
  assert.equal(d.status === "detected" && d.value, "straight");
});

test("an evenly mixed manuscript is unsure, so the author is asked", () => {
  const md = `${NARRATION}\n\n${"“Yes,” she said. ".repeat(10)}${'"No," he said. '.repeat(10)}`;
  assert.equal(detectQuoteStyle(md).status, "unsure");
});

test("a manuscript with no dialogue at all is unsure", () => {
  assert.equal(detectQuoteStyle(NARRATION).status, "unsure");
});

test("the counts behind the answer are reported for the badge", () => {
  const md = `${NARRATION}\n\n${"“Yes,” she said. ".repeat(20)}${'"No," he said. '.repeat(2)}`;
  const d = detectQuoteStyle(md);
  assert.equal(d.support, 40);
  assert.equal(d.against, 4);
  assert.equal(d.sample, 44);
});

test("quote style joins the settings read at upload", () => {
  const md = `${NARRATION}\n\n${"“Yes,” she said. ".repeat(20)}`;
  const found = detectSettings(md);
  assert.equal(found.quoteStyle?.status, "detected");
});

test("quote style is read for a non-English manuscript too", () => {
  // Unlike the dialect and comma conventions, quote style is not gated on
  // English: a French novel in guillemets still has a curly-vs-straight
  // answer, and the scan needs it.
  const french =
    "Elle marchait sous la pluie et la route l’accompagnait. ".repeat(40) +
    "« Oui », dit-elle. ".repeat(20);
  const found = detectSettings(french);
  assert.equal(found.quoteStyle?.status, "detected");
});
