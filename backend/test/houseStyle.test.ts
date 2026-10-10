// ── House-style questions before an edit ──
//
// Counted from the manuscript, no model: where the text disagrees with itself,
// Betty asks which form is the author's, so the edit stops "correcting" a
// deliberate choice. Nothing settled is asked again.

import { test } from "node:test";
import assert from "node:assert/strict";

import { houseStyleQuestions } from "../src/houseStyle.ts";

const rep = (s: string, n: number) => Array.from({ length: n }, () => s).join(" ");
const kinds = (qs: { kind: string }[]) => qs.map((q) => q.kind);

test("British and American spellings of the same word are a question, most used first", () => {
  const text = `${rep("The grey sky.", 5)} ${rep("A gray coat.", 2)}`;
  const [q] = houseStyleQuestions(text, "en", "");
  assert.equal(q.kind, "spelling");
  assert.deepEqual(q.forms, [{ form: "grey", count: 5 }, { form: "gray", count: 2 }]);
});

test("spelling pairs are English only, and need three uses in all", () => {
  assert.deepEqual(houseStyleQuestions("grey gray", "en", ""), []);
  assert.deepEqual(kinds(houseStyleQuestions(rep("grey gray", 3), "da", "")), []);
});

test("a hyphenated word and its closed or open form are a question", () => {
  const text = `${rep("Send an e-mail.", 3)} ${rep("Read the email.", 2)} Check your e mail.`;
  const q = houseStyleQuestions(text, "en", "").find((x) => x.kind === "compound")!;
  assert.deepEqual(q.forms, [{ form: "e-mail", count: 3 }, { form: "email", count: 2 }, { form: "e mail", count: 1 }]);
});

test("numbers under a hundred, words against digits; years, times, decimals and chapters are not counted", () => {
  const text =
    `${rep("She waited ten minutes.", 3)} ${rep("He had 12 apples.", 3)} ` +
    "In 1984 at 10:30 it rose 2.5 per cent, 40% more, as chapter 3 says.";
  const q = houseStyleQuestions(text, "en", "").find((x) => x.kind === "numbers")!;
  assert.deepEqual(q.forms, [{ form: "words", count: 3 }, { form: "digits", count: 3 }]);
  // Only digits: nothing to choose between.
  assert.equal(houseStyleQuestions(rep("He had 12 apples.", 5), "en", "").some((x) => x.kind === "numbers"), false);
});

test("Danish number words count too", () => {
  const text = `${rep("Hun ventede ti minutter.", 3)} ${rep("Han havde 12 æbler.", 3)}`;
  assert.ok(houseStyleQuestions(text, "da", "").some((x) => x.kind === "numbers"));
});

test("two dash styles are a question", () => {
  const text = `${rep("It was late – too late.", 3)} ${rep("It was late—too late.", 2)}`;
  const q = houseStyleQuestions(text, "en", "").find((x) => x.kind === "dashes")!;
  assert.deepEqual(q.forms, [{ form: "spaced-en", count: 3 }, { form: "closed-em", count: 2 }]);
});

test("the style guide settles a question: a form it names, or the topic", () => {
  const text = `${rep("The grey sky.", 5)} ${rep("A gray coat.", 2)} ${rep("ten", 3)} ${rep("12", 3)}`;
  assert.equal(houseStyleQuestions(text, "en", "Always write grey.").some((q) => q.kind === "spelling"), false);
  assert.equal(houseStyleQuestions(text, "en", "Spell out numbers under 100.").some((q) => q.kind === "numbers"), false);
  assert.equal(houseStyleQuestions(text, "da", "Tal under 100 skrives med bogstaver.").some((q) => q.kind === "numbers"), false);
});

test("at most five, the most frequent conflicts first, and ids are stable", () => {
  const pairs = [["grey", "gray"], ["colour", "color"], ["favour", "favor"], ["centre", "center"], ["honour", "honor"], ["theatre", "theater"]];
  const text = pairs.map(([a, b], i) => `${rep(a, 3 + i)} ${rep(b, 1)}`).join(" ");
  const qs = houseStyleQuestions(text, "en", "");
  assert.equal(qs.length, 5);
  const totals = qs.map((q) => q.forms.reduce((n, f) => n + f.count, 0));
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a));
  assert.equal(qs[0].id, "spelling:theatre|theater");
});

// Found on a real book: image descriptions and the contents page were counted
// as the author's prose — "cartoon style" (from eleven picture descriptions)
// became a question, and page numbers swelled the digits.
test("image descriptions, links and contents-page numbers are not the author's prose", () => {
  const text = [
    ...Array.from({ length: 6 }, (_, i) => `![People in a simple cartoon style ${i}](media/x/image${i}.png)`),
    "A cartoon-style drawing.", "Another cartoon-style drawing.",
    ...Array.from({ length: 5 }, (_, i) => `[Kapitel ${i + 2} 1${i}](#TOC2501${i})`),
    "Sætte rammen\t72", "Invitere til deltagelse 75",
    "Hun ventede ti minutter. Han havde tre æbler. De gik fem km.",
  ].join("\n\n");
  const qs = houseStyleQuestions(text, "da", "");
  assert.equal(qs.some((q) => q.kind === "compound"), false, "cartoon style came only from pictures");
  assert.equal(qs.some((q) => q.kind === "numbers"), false, "every digit was a page number");
});
