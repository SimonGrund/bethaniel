// ── The brief the author's answers become ──
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultAnswers,
  renderTranslationBrief,
  type BriefQuestion,
} from "../../frontend/src/translationBrief.ts";

const qs: BriefQuestion[] = [
  {
    id: "q1",
    term: "Kragehøj",
    question: "Behold stednavnet?",
    options: [{ id: "a", label: "Behold" }, { id: "b", label: "Oversæt" }],
    suggested: "a",
    why: "",
  },
  {
    id: "q2",
    question: "Miles?",
    options: [{ id: "a", label: "Keep miles" }, { id: "b", label: "Convert to km" }],
    suggested: "b",
    why: "",
  },
];

test("matching the tone with nothing to answer is no brief at all", () => {
  assert.equal(renderTranslationBrief("match", [], {}), "");
});

test("a softer or stricter tone is said plainly", () => {
  assert.match(renderTranslationBrief("softer", [], {}), /Tone: softer/);
  assert.match(renderTranslationBrief("stricter", [], {}), /Tone: stricter and shorter/);
});

test("each answer is a line, with the term quoted and the question kept", () => {
  const brief = renderTranslationBrief("match", qs, { q1: { optionId: "b" }, q2: { optionId: "a" } });
  assert.match(brief, /^TRANSLATION BRIEF/);
  assert.match(brief, /- "Kragehøj" — Behold stednavnet\? → Oversæt/);
  assert.match(brief, /- Miles\? → Keep miles/);
});

test("an author's own answer is kept verbatim; an empty one falls back to Betty's suggestion", () => {
  const own = renderTranslationBrief("match", qs, { q1: { other: " Krähenhügel " }, q2: { other: "" } });
  assert.match(own, /→ "Krähenhügel"/);
  assert.match(own, /- Miles\? → Convert to km/);
});

test("by default every question takes Betty's suggestion", () => {
  assert.deepEqual(defaultAnswers(qs), { q1: { optionId: "a" }, q2: { optionId: "b" } });
});
