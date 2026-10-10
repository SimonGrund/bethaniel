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
  parseBriefResponse,
  mergeSavedGlossary,
  glossaryRowsToSave,
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
  assert.equal(out.questions.length, 1);
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
  assert.equal(retried.questions.length, 1);
  assert.equal(n, 2);

  let m = 0;
  const none = await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "French", uiLang: "en" },
    { llm: async () => (m++, "still nope") },
  );
  assert.deepEqual(none.questions, []);
  assert.deepEqual(none.glossary, []);
  assert.equal(m, 2);
});

test("an interface language Betty does not speak falls back to English", async () => {
  let system = "";
  await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "German", uiLang: "fr" },
    { llm: async (s) => ((system = s), '{"questions": []}') },
  );
  assert.match(system, /"label" and "why" in English/);
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

// ── The glossary table ──

const BOOK = "The data controller signs. The data controller pays. Under GDPR, Kragehøj is a place. They loved Kragehøj.";

test("the glossary comes back beside the questions, each row checked on its own", () => {
  const raw = JSON.stringify({
    glossary: [
      { term: "data controller", rendering: "responsable du traitement", keep: false },
      { term: "GDPR", rendering: "RGPD" },
      { term: "Kragehøj", keep: true },
      { term: "invented thing", rendering: "x" }, // not in the book
      { term: "data controller", rendering: "duplicate" },
      { term: "GDPR" }, // no rendering and not kept
      "nonsense",
    ],
    questions: [],
  });
  const out = parseBriefResponse(raw, BOOK)!;
  assert.deepEqual(out.glossary, [
    { term: "data controller", rendering: "responsable du traitement", keep: false },
    { term: "GDPR", rendering: "RGPD", keep: false },
    { term: "Kragehøj", rendering: "Kragehøj", keep: true },
  ]);
});

test("a term Betty asks about is not also in the table", () => {
  const raw = JSON.stringify({
    glossary: [{ term: "Kragehøj", rendering: "Corbeaumont" }],
    questions: [q({ term: "Kragehøj" })],
  });
  const out = parseBriefResponse(raw, BOOK)!;
  assert.equal(out.questions.length, 1);
  assert.deepEqual(out.glossary, []);
});

test("an answer with questions but no glossary is still usable", () => {
  const out = parseBriefResponse(JSON.stringify({ questions: [q()] }), BOOK);
  assert.deepEqual(out?.glossary, []);
  assert.equal(parseBriefResponse("no json here", BOOK), null);
});

test("the table holds at most forty rows", () => {
  const terms = Array.from({ length: 45 }, (_, i) => `Term${String.fromCharCode(65 + (i % 26))}${i}`);
  const book = terms.join(" ");
  const raw = JSON.stringify({ glossary: terms.map((t) => ({ term: t, rendering: t })), questions: [] });
  assert.equal(parseBriefResponse(raw, book)!.glossary.length, 40);
});

test("a saved rendering replaces Betty's, and a saved term she missed is added", () => {
  const rows = [
    { term: "data controller", rendering: "contrôleur", keep: false },
    { term: "GDPR", rendering: "RGPD", keep: false },
  ];
  const saved = [
    { term: "data controller", rendering: "responsable du traitement", keep: false },
    { term: "Kragehøj", rendering: "Kragehøj", keep: true },
    { term: "not in this book", rendering: "x", keep: false },
  ];
  assert.deepEqual(mergeSavedGlossary(rows, saved, BOOK), [
    { term: "data controller", rendering: "responsable du traitement", keep: false, saved: true },
    { term: "GDPR", rendering: "RGPD", keep: false },
    { term: "Kragehøj", rendering: "Kragehøj", keep: true, saved: true },
  ]);
});

test("the runner merges the saved glossary, even when the model's answer is unusable", async () => {
  const saved = [{ term: "Kragehøj", rendering: "Kragehøj", keep: true }];
  const out = await runBriefQuestions(
    { text: BOOK, manuscriptLang: "en", targetLang: "French", uiLang: "en" },
    { llm: async () => "nope", savedGlossary: saved },
  );
  assert.deepEqual(out.questions, []);
  assert.deepEqual(out.glossary, [{ ...saved[0], saved: true }]);
});

test("the prompt asks for the table, rendered in the target language", async () => {
  let system = "";
  await runBriefQuestions(
    { text: BOOK, manuscriptLang: "en", targetLang: "French", uiLang: "da" },
    { llm: async (s) => ((system = s), '{"glossary": [], "questions": []}') },
  );
  assert.match(system, /"glossary"/);
  assert.match(system, /rendering" is in French/);
});

test("what is saved is trimmed, deduplicated and bounded", () => {
  const rows = glossaryRowsToSave([
    { term: " GDPR ", rendering: " RGPD ", keep: false },
    { term: "Kragehøj", rendering: "", keep: true },
    { term: "GDPR", rendering: "again", keep: false },
    { term: "", rendering: "x", keep: false },
    { term: "no rendering", rendering: "  ", keep: false },
    { term: "x".repeat(201), rendering: "y", keep: false },
    "junk",
  ]);
  assert.deepEqual(rows, [
    { term: "GDPR", rendering: "RGPD", keep: false },
    { term: "Kragehøj", rendering: "Kragehøj", keep: true },
  ]);
  assert.deepEqual(glossaryRowsToSave("not an array"), []);
  const many = Array.from({ length: 1200 }, (_, i) => ({ term: `t${i}`, rendering: "r", keep: false }));
  assert.equal(glossaryRowsToSave(many).length, 1000);
});

// ── What is already decided stays decided ──

test("an option keeps the exact rendering it stands for", () => {
  const raw = JSON.stringify({
    questions: [q({
      options: [
        { id: "a", label: "Behold som Kragehøj", rendering: "Kragehøj" },
        { id: "b", label: "Oversæt", rendering: "  Corbeaumont " },
        { id: "c", label: "Noget andet", rendering: 7 },
      ],
    })],
  });
  const opts = parseBriefResponse(raw, SOURCE)!.questions[0].options;
  assert.deepEqual(opts, [
    { id: "a", label: "Behold som Kragehøj", rendering: "Kragehøj" },
    { id: "b", label: "Oversæt", rendering: "Corbeaumont" },
    { id: "c", label: "Noget andet" },
  ]);
});

test("a term the saved glossary already settles is not asked again, and the model is told", async () => {
  let user = "";
  const out = await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "French", uiLang: "en" },
    {
      llm: async (_s, u) => {
        user = u;
        return JSON.stringify({ questions: [q({ id: "x", term: "Kragehøj" }), q({ id: "y", term: undefined })] });
      },
      savedGlossary: [{ term: "kragehøj", rendering: "Kragehøj", keep: true }],
    },
  );
  assert.deepEqual(out.questions.map((x) => x.id), ["y"]);
  assert.match(user, /"decided"/);
});

// ── Noise the real runs showed ──

test("a modal verb ends a phrase", () => {
  const text = Array.from({ length: 3 }, () => "The data processor shall act. ").join("");
  const cs = collectBriefCandidates(text, "en");
  assert.ok(find(cs, "data processor", "phrase"));
  assert.equal(cs.some((c) => /shall/.test(c.term)), false);
});

test("a row that is another's plural is the same term", () => {
  const book = "data subject, data subjects, data subjekter, Datenschutz";
  const raw = JSON.stringify({
    glossary: [
      { term: "data subject", rendering: "betroffene Person" },
      { term: "data subjects", rendering: "betroffene Personen" },
      { term: "data subjekter", rendering: "x" }, // a longer ending is a different word
    ],
    questions: [],
  });
  assert.deepEqual(parseBriefResponse(raw, book)!.glossary.map((r) => r.term), ["data subject", "data subjekter"]);
  // And a saved term covers its plural in Betty's table.
  const merged = mergeSavedGlossary(
    [{ term: "data subjects", rendering: "betroffene Personen", keep: false }],
    [{ term: "data subject", rendering: "betroffene Person", keep: false }],
    book,
  );
  assert.deepEqual(merged.map((r) => r.term), ["data subject"]);
});

// ── The author's term list, merged with Betty's reading ──

const DPA = "The data controller signs. The data controller pays. Under GDPR, the sub-processor reports. The DPO audits. joint controllers share.";

test("the author's list rows are decided: in the table as theirs, never asked about", async () => {
  let user = "";
  const out = await runBriefQuestions(
    {
      text: DPA,
      manuscriptLang: "en",
      targetLang: "German",
      uiLang: "da",
      termList: "Data Controller = Verantwortlicher\nGDPR = DSGVO\nAudit Committee = Prüfungsausschuss\nUse formal Sie throughout.",
    },
    {
      llm: async (_s, u) => {
        user = u;
        return JSON.stringify({
          glossary: [
            { term: "GDPR", rendering: "GDPR" },
            { term: "joint controllers", rendering: "gemeinsam Verantwortliche" },
            { term: "DPO", rendering: "DSB", fromNotes: true },
          ],
          questions: [q({ id: "g", term: "GDPR" }), q({ id: "s", term: "sub-processor" })],
        });
      },
    },
  );
  const payload = JSON.parse(user);
  assert.deepEqual(payload.decided.slice(0, 2), [
    { term: "Data Controller", rendering: "Verantwortlicher" },
    { term: "GDPR", rendering: "DSGVO" },
  ]);
  assert.equal(payload.authorNotes, "Use formal Sie throughout.");
  assert.deepEqual(out.questions.map((x) => x.id), ["s"]);
  // The author's rows lead: the list's in its order, then the one Betty
  // made from their notes, then hers.
  assert.deepEqual(out.glossary, [
    { term: "Data Controller", rendering: "Verantwortlicher", keep: false, author: true },
    { term: "GDPR", rendering: "DSGVO", keep: false, author: true },
    { term: "DPO", rendering: "DSB", keep: false, author: true },
    { term: "joint controllers", rendering: "gemeinsam Verantwortliche", keep: false },
  ]);
  assert.equal(out.authorNotes, "Use formal Sie throughout.");
  // The whole list is kept for saving, terms this book lacks included.
  assert.deepEqual(out.listRows.map((r) => r.term), ["Data Controller", "GDPR", "Audit Committee"]);
});

test("a glossary in the style guide is decided too, after the list", async () => {
  let user = "";
  const out = await runBriefQuestions(
    {
      text: DPA,
      manuscriptLang: "en",
      targetLang: "German",
      uiLang: "en",
      termList: "GDPR = DSGVO",
      styleGuide: "Spell out numbers.\nGDPR = General Data Protection Regulation\nsub-processor = Unterauftragsverarbeiter",
    },
    { llm: async (_s, u) => ((user = u), '{"glossary": [], "questions": []}') },
  );
  assert.deepEqual(
    JSON.parse(user).decided.map((d: { term: string; rendering: string }) => `${d.term}=${d.rendering}`),
    ["GDPR=DSGVO", "sub-processor=Unterauftragsverarbeiter"],
  );
  assert.deepEqual(out.glossary.map((r) => r.term), ["GDPR", "sub-processor"]);
  assert.equal(out.listRows.length, 1, "the style guide is kept where it is, not saved again");
  assert.equal(out.authorNotes, "", "the style guide's prose already reaches the translator");
});

// ── Ordinary words are not terms ──

const CONTRACT =
  "# Data Processing Agreement\n\n## 2. Instructions\n\nThe data processor acts. This Data Processing Agreement binds. " +
  "The data is kept. Under this Data Processing Agreement the processor reports.\n\n## 3. Security\n\nThe processor encrypts data. " +
  "The Services start. At the end of the Services, the Services stop. In the Services the data processor works.\n\n" +
  "## 4. Audits\n\nThe auditor checks. A Data Processing Agreement names the Data officer, and Data stays here.";

test("a capital after a heading line or a word also used in lowercase is no name", () => {
  const cs = collectBriefCandidates(CONTRACT, "en");
  assert.equal(find(cs, "The", "name"), undefined, "a line after a heading opens a sentence");
  assert.equal(find(cs, "Data", "name"), undefined, "the text says 'data' too");
  assert.ok(find(cs, "Services", "name"), "always capitalised: a defined term");
});

test("Betty's own rows for such words are dropped too", () => {
  const raw = JSON.stringify({
    glossary: [
      { term: "The", rendering: "Der" },
      { term: "Data", rendering: "Daten" },
      { term: "Services", rendering: "Leistungen" },
      { term: "Data Processing Agreement", rendering: "Auftragsverarbeitungsvertrag" },
    ],
    questions: [],
  });
  assert.deepEqual(
    parseBriefResponse(raw, CONTRACT)!.glossary.map((r) => r.term),
    ["Services", "Data Processing Agreement"],
  );
});

// ── A long brief: read in full, condensed for every chunk ──

test("Betty reads the author's notes in full, up to 30,000 characters", async () => {
  let user = "";
  const notes = "Keep the tone calm and supportive. ".repeat(600); // ~21,000 chars
  await runBriefQuestions(
    { text: DPA, manuscriptLang: "en", targetLang: "German", uiLang: "en", termList: notes },
    { llm: async (_s, u) => ((user = u), '{"glossary": [], "questions": []}') },
  );
  assert.ok(JSON.parse(user).authorNotes.length > 20_000);
});

test("her condensed instructions come back with the answer", async () => {
  const out = await runBriefQuestions(
    { text: DPA, manuscriptLang: "en", targetLang: "German", uiLang: "en", termList: "Long notes here." },
    {
      llm: async () =>
        JSON.stringify({ glossary: [], questions: [], instructions: "- Calm, supportive tone.\n- Never add clinical words." }),
    },
  );
  assert.equal(out.instructions, "- Calm, supportive tone.\n- Never add clinical words.");
  assert.equal(out.degraded, undefined);
});

test("two unusable answers are said to be so, not passed off as 'no questions'", async () => {
  const out = await runBriefQuestions(
    { text: DPA, manuscriptLang: "en", targetLang: "German", uiLang: "en" },
    { llm: async () => '{"glossary": [{"term": "GDPR", "rendering": "DS' }, // cut off mid-answer
  );
  assert.equal(out.degraded, true);
});

test("the prompt asks for condensed instructions when there are notes", async () => {
  let system = "";
  await runBriefQuestions(
    { text: DPA, manuscriptLang: "en", targetLang: "German", uiLang: "en", termList: "Some notes." },
    { llm: async (s) => ((system = s), '{"glossary": [], "questions": []}') },
  );
  assert.match(system, /"instructions"/);
});

// Seen on a real run: the brief listed "Belastende hændelser" (plural) and
// the text said "belastende hændelse" — the row was left out, and the
// translator chose "distressing event" over the author's "straining incidents".
test("a listed term counts as in the book when the book has it in the other number", async () => {
  const book = "Efter en belastende hændelse taler vi sammen. En god beredskabsplan hjælper.";
  const out = await runBriefQuestions(
    {
      text: book,
      manuscriptLang: "da",
      targetLang: "English",
      uiLang: "da",
      termList: "Belastende hændelser → straining incidents\nBeredskabsplaner → contingency plans\nKrisepsykolog → crisis psychologist",
    },
    { llm: async () => '{"glossary": [], "questions": []}' },
  );
  assert.deepEqual(out.glossary.map((r) => r.term), ["Belastende hændelser", "Beredskabsplaner"]);
});
