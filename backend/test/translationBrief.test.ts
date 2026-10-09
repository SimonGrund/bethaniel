// ── The translation brief: what Betty asks before she translates ──
//
// Candidate collection is deterministic and runs over the whole book, so the
// model only ever sees a short list. These pin what counts as a candidate.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectBriefCandidates,
  sampleExcerpts,
  parseBriefQuestions,
  runBriefQuestions,
  combineTranslationNotes,
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

test("the list is ranked by count and capped at 60", () => {
  const names = Array.from({ length: 70 }, (_, i) =>
    "Qa" + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)),
  );
  const text = "start " + names.map((n, i) => `and ${n} `.repeat(3 + (i % 5))).join("");
  const cs = collectBriefCandidates(text, "en");
  assert.equal(cs.length, 60);
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

// ── The questions ──

const SOURCE = "They loved Kragehøj. We saw Kragehøj. Near Kragehøj, nothing.";

const q = (over: Record<string, unknown> = {}) => ({
  id: "q1",
  term: "Kragehøj",
  question: "Behold navnet?",
  options: [{ id: "a", label: "Behold" }, { id: "b", label: "Oversæt" }],
  suggested: "a",
  why: "Det er et stednavn.",
  ...over,
});

test("a valid answer parses, code fences or not", () => {
  const raw = JSON.stringify({ questions: [q()] });
  assert.equal(parseBriefQuestions(raw, SOURCE)?.length, 1);
  assert.equal(parseBriefQuestions("```json\n" + raw + "\n```", SOURCE)?.[0].term, "Kragehøj");
});

test("prose, or no questions array, is unusable", () => {
  assert.equal(parseBriefQuestions("I cannot help with that.", SOURCE), null);
  assert.equal(parseBriefQuestions('{"answer": 1}', SOURCE), null);
  assert.deepEqual(parseBriefQuestions('{"questions": []}', SOURCE), []);
});

test("a bad question is dropped on its own, the rest kept", () => {
  const raw = JSON.stringify({
    questions: [
      q({ id: "bad1", suggested: "z" }),
      q({ id: "bad2", options: [{ id: "a", label: "Only" }] }),
      q({ id: "bad3", term: "Ravnsborg" }), // not in the book
      q({ id: "bad4", options: [{ id: "a", label: "X" }, { id: "a", label: "Y" }] }),
      q({ id: "good" }),
      q({ id: "good" }), // duplicate id
      q({ id: "noterm", term: undefined }),
    ],
  });
  const out = parseBriefQuestions(raw, SOURCE)!;
  assert.deepEqual(out.map((x) => x.id), ["good", "noterm"]);
  assert.equal(out[1].term, undefined);
});

test("no more than five questions are kept", () => {
  const raw = JSON.stringify({ questions: Array.from({ length: 7 }, (_, i) => q({ id: `q${i}` })) });
  assert.equal(parseBriefQuestions(raw, SOURCE)?.length, 5);
});

test("the runner asks once when the first answer is good, in the interface language", async () => {
  const calls: { system: string; user: string }[] = [];
  const out = await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "French", uiLang: "da" },
    {
      llm: async (system, user) => {
        calls.push({ system, user });
        return JSON.stringify({ questions: [q()] });
      },
    },
  );
  assert.equal(out.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /in Danish/);
  assert.match(calls[0].system, /into French/);
  assert.match(calls[0].user, /Kragehøj/);
});

test("the runner retries once on a bad answer, then gives up with no questions", async () => {
  let n = 0;
  const retried = await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "French", uiLang: "en" },
    {
      llm: async (_s, user) => {
        if (++n === 1) return "nope";
        assert.match(user, /PREVIOUS RESPONSE/);
        return JSON.stringify({ questions: [q()] });
      },
    },
  );
  assert.equal(retried.length, 1);
  assert.equal(n, 2);

  let m = 0;
  const none = await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "French", uiLang: "en" },
    { llm: async () => (m++, "still nope") },
  );
  assert.deepEqual(none, []);
  assert.equal(m, 2);
});

test("an interface language Betty does not speak falls back to English", async () => {
  let system = "";
  await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "German", uiLang: "fr" },
    { llm: async (s) => ((system = s), '{"questions": []}') },
  );
  assert.match(system, /label" and every "why" in English/);
});

test("the brief goes first and wins; either side may be empty", () => {
  const both = combineTranslationNotes("TRANSLATION BRIEF:\n- x", "Use Oxford commas.");
  assert.ok(both.indexOf("TRANSLATION BRIEF") < both.indexOf("Oxford"));
  assert.match(both, /brief above wins/);
  assert.equal(combineTranslationNotes("", " Use Oxford commas. "), "Use Oxford commas.");
  assert.equal(combineTranslationNotes(" B ", ""), "B");
  assert.equal(combineTranslationNotes("", ""), "");
});

// ── Professional vocabulary ──

test("a repeated run of content words is a phrase; function words break it", () => {
  const text =
    "The buyer must complete due diligence before signing. Due diligence covers the accounts. " +
    "Without due diligence, the data controller is liable. The data controller keeps records, " +
    "and the data controller answers to the authority.";
  const cs = collectBriefCandidates(text, "en");
  assert.equal(find(cs, "due diligence", "phrase")?.count, 3);
  assert.equal(find(cs, "data controller", "phrase")?.count, 3);
  assert.equal(
    cs.filter((c) => c.kind === "phrase").some((c) => /\b(the|before|is)\b/.test(c.term)),
    false,
  );
});

test("a longer phrase wins over the shorter one inside it", () => {
  const text = Array.from({ length: 3 }, () => "We test the load bearing wall today.").join(" ");
  const cs = collectBriefCandidates(text, "en");
  assert.ok(find(cs, "load bearing wall", "phrase"));
  assert.equal(find(cs, "load bearing", "phrase"), undefined);
  assert.equal(find(cs, "bearing wall", "phrase"), undefined);
});

test("acronyms count from two uses; Roman numerals are not acronyms", () => {
  const text = "Under GDPR the processor reports. GDPR applies here. In Part II and Part II again, the SLA is met once.";
  const cs = collectBriefCandidates(text, "en");
  assert.equal(find(cs, "GDPR", "acronym")?.count, 2);
  assert.equal(find(cs, "II", "acronym"), undefined);
  assert.equal(find(cs, "SLA", "acronym"), undefined, "once is not enough");
  assert.equal(find(cs, "GDPR", "name"), undefined);
});
