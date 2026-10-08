// ── The translation brief: what Betty asks before she translates ──
//
// Candidate collection is deterministic and runs over the whole book, so the
// model only ever sees a short list. These pin what counts as a candidate.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectBriefCandidates,
  sampleExcerpts,
} from "../src/translationBrief.ts";

const find = (cs: { term: string; kind: string }[], term: string, kind: string) =>
  cs.find((c) => c.term === term && c.kind === kind);

test("a name counts only where it is capitalised mid-sentence, three times or more", () => {
  const text =
    "Anna walked in. She saw Kragehøj from the hill. They loved Kragehøj. " +
    "Later, Kragehøj burned. Kragehøj stood. We met Bo and Bo again.";
  const cs = collectBriefCandidates(text, "en");
  assert.equal(find(cs, "Kragehøj", "name")?.count, 3);
  assert.equal(find(cs, "Anna", "name"), undefined, "sentence-initial only");
  assert.equal(find(cs, "Bo", "name"), undefined, "twice is not enough");
});

test("an invented word is one the dictionary rejects, three times or more", () => {
  const text = "The glimmerwick shone. A glimmerwick fell. Two glimmerwick lights.";
  const known = (w: string) => w.toLowerCase() !== "glimmerwick";
  assert.equal(find(collectBriefCandidates(text, "en", known), "glimmerwick", "invented")?.count, 3);
  assert.equal(
    find(collectBriefCandidates(text, "en"), "glimmerwick", "invented"),
    undefined,
    "no dictionary, no invented words",
  );
});

test("in German a capitalised noun is not a name; without a dictionary there are no names", () => {
  const text =
    "Er sah die Zeit. Die Zeit verging. Mit der Zeit kam Almut. Dann rief Almut. Wo war Almut?";
  const known = (w: string) => w !== "Almut";
  const cs = collectBriefCandidates(text, "de", known);
  assert.equal(find(cs, "Almut", "name")?.count, 3);
  assert.equal(find(cs, "Zeit", "name"), undefined);
  assert.equal(collectBriefCandidates(text, "de").filter((c) => c.kind === "name").length, 0);
});

test("honorifics, units and titles count from their first occurrence", () => {
  const text = "He met Mr Hale. It was three miles off, then two more miles. She read *The Hollow Crown* twice.";
  const cs = collectBriefCandidates(text, "en");
  assert.equal(find(cs, "Mr", "honorific")?.count, 1);
  assert.equal(find(cs, "miles", "unit")?.count, 2);
  assert.equal(find(cs, "The Hollow Crown", "title")?.count, 1);
  assert.equal(find(cs, "Mr", "name"), undefined, "an honorific is not also a name");
});

test("each candidate carries the sentence it first appeared in", () => {
  const text = "Rain fell. Then Kragehøj woke up. We saw Kragehøj. Near Kragehøj, nothing.";
  const c = find(collectBriefCandidates(text, "en"), "Kragehøj", "name");
  assert.equal(c?.example, "Then Kragehøj woke up.");
});

test("the list is ranked by count and capped at 40", () => {
  const names = Array.from({ length: 50 }, (_, i) =>
    "Qa" + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)),
  );
  const text = "start " + names.map((n, i) => `and ${n} `.repeat(3 + (i % 5))).join("");
  const cs = collectBriefCandidates(text, "en");
  assert.equal(cs.length, 40);
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i - 1].count >= cs[i].count);
});

test("excerpts are spread over the book and bounded in length", () => {
  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(100));
  const ex = sampleExcerpts(paras.join("\n\n"), 4, 300);
  assert.equal(ex.length, 4);
  assert.ok(ex[0].startsWith("Paragraph 0 "));
  assert.ok(ex[3].startsWith("Paragraph 30 "));
  for (const e of ex) assert.ok(e.split(/\s+/).length <= 600);
  assert.deepEqual(sampleExcerpts("", 4, 300), []);
});
