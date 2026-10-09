// ── The brief the author's answers become ──
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  answeredTermsToSave,
  briefNotes,
  overlayListRows,
  questionsOpenAfterList,
  defaultAnswers,
  glossaryToSave,
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

// ── The glossary table ──

test("the table goes into the brief as binding lines, kept terms as themselves", () => {
  const brief = renderTranslationBrief("match", [], {}, [
    { term: "data controller", rendering: "responsable du traitement", keep: false },
    { term: "Kragehøj", rendering: "Kragehøj", keep: true },
    { term: "empty", rendering: "  ", keep: false },
  ]);
  assert.match(brief, /GLOSSARY/);
  assert.match(brief, /- "data controller" → "responsable du traitement"/);
  assert.match(brief, /- "Kragehøj": keep exactly as written/);
  assert.doesNotMatch(brief, /"empty"/);
});

test("a table alone is a brief; an empty table adds nothing", () => {
  assert.notEqual(renderTranslationBrief("match", [], {}, [{ term: "GDPR", rendering: "RGPD", keep: false }]), "");
  assert.equal(renderTranslationBrief("match", [], {}, []), "");
});

test("the rows worth saving are the filled-in ones", () => {
  assert.deepEqual(
    glossaryToSave([
      { term: " GDPR ", rendering: " RGPD ", keep: false, saved: true },
      { term: "", rendering: "x", keep: false },
      { term: "half", rendering: "", keep: false },
      { term: "Kragehøj", rendering: "", keep: true },
    ]),
    [
      { term: "GDPR", rendering: "RGPD", keep: false },
      { term: "Kragehøj", rendering: "Kragehøj", keep: true },
    ],
  );
});

// ── Answers to term questions are part of the glossary ──

test("a term question's chosen rendering is said in the brief and saved", () => {
  const tq: BriefQuestion[] = [
    {
      id: "q1",
      term: "data controller",
      question: "Verantwortlicher eller für die Verarbeitung Verantwortlicher?",
      options: [
        { id: "a", label: "Verantwortlicher (tysk standard)", rendering: "Verantwortlicher" },
        { id: "b", label: "Den lange form", rendering: "für die Verarbeitung Verantwortlicher" },
      ],
      suggested: "a",
      why: "",
    },
    { id: "q2", question: "Units?", options: [{ id: "a", label: "Keep" }, { id: "b", label: "Convert" }], suggested: "a", why: "" },
    {
      id: "q3",
      term: "DPO",
      question: "DSB?",
      options: [{ id: "a", label: "DSB", rendering: "DSB" }, { id: "b", label: "DPO", rendering: "DPO" }],
      suggested: "a",
      why: "",
    },
  ];
  const answers = { q1: { optionId: "b" }, q2: { optionId: "b" }, q3: { other: "Datenschutzbeauftragter" } };
  const brief = renderTranslationBrief("match", tq, answers);
  assert.match(brief, /→ Den lange form \(render as "für die Verarbeitung Verantwortlicher"\)/);
  assert.deepEqual(answeredTermsToSave(tq, answers), [
    { term: "data controller", rendering: "für die Verarbeitung Verantwortlicher", keep: false },
    { term: "DPO", rendering: "Datenschutzbeauftragter", keep: false },
  ]);
});

test("a term added twice is saved once, the first row winning", () => {
  assert.deepEqual(
    glossaryToSave([
      { term: "Nordlys Analytics ApS", rendering: "Nordlys Analytics ApS", keep: true },
      { term: " Nordlys Analytics ApS ", rendering: "Nordlys", keep: false, added: true },
    ]),
    [{ term: "Nordlys Analytics ApS", rendering: "Nordlys Analytics ApS", keep: true }],
  );
});

// ── The author's own notes ──

test("the author's notes go into the brief verbatim", () => {
  const brief = renderTranslationBrief("match", [], {}, [], "Use formal Sie throughout.\nNever translate song titles.");
  assert.match(brief, /AUTHOR'S NOTES/);
  assert.match(brief, /Use formal Sie throughout\.\nNever translate song titles\./);
  assert.equal(renderTranslationBrief("match", [], {}, [], "   "), "");
});

// ── Going back to the list after Betty has read it ──

test("an edited list re-lays its rows over the table, keeping Betty's and the author's own edits", () => {
  const glossary = [
    { term: "GDPR", rendering: "DSGVO", keep: false, author: true }, // from the old list
    { term: "data subject", rendering: "betroffene Person", keep: false }, // Betty's
    { term: "Annex 2", rendering: "Anlage 2", keep: false, edited: true }, // Betty's, changed by the author
    { term: "DPO", rendering: "DSB", keep: false, author: true }, // from the old list, now removed from it
  ];
  const oldRows = [
    { term: "GDPR", rendering: "DSGVO", keep: false },
    { term: "DPO", rendering: "DSB", keep: false },
  ];
  const newRows = [
    { term: "GDPR", rendering: "GDPR", keep: true },
    { term: "data subject", rendering: "Betroffener", keep: false },
    { term: "SCCs", rendering: "SCC", keep: false },
    { term: "not in this book", rendering: "x", keep: false },
  ];
  const book = "Under GDPR the data subject has rights. See Annex 2. The DPO and the SCCs.";
  assert.deepEqual(overlayListRows(glossary, oldRows, newRows, book), [
    { term: "GDPR", rendering: "GDPR", keep: true, author: true },
    { term: "data subject", rendering: "Betroffener", keep: false, author: true },
    { term: "SCCs", rendering: "SCC", keep: false, author: true },
    { term: "Annex 2", rendering: "Anlage 2", keep: false, edited: true },
  ]);
});

test("a question the edited list now answers is dropped", () => {
  const qs: BriefQuestion[] = [
    { id: "a", term: "SCCs", question: "?", options: [{ id: "x", label: "x" }, { id: "y", label: "y" }], suggested: "x", why: "" },
    { id: "b", term: "DPO", question: "?", options: [{ id: "x", label: "x" }, { id: "y", label: "y" }], suggested: "x", why: "" },
    { id: "c", question: "Units?", options: [{ id: "x", label: "x" }, { id: "y", label: "y" }], suggested: "x", why: "" },
  ];
  assert.deepEqual(
    questionsOpenAfterList(qs, [{ term: "scCs", rendering: "SCC", keep: false }]).map((q) => q.id),
    ["b", "c"],
  );
});

test("short notes ride verbatim; a long brief rides as Betty's condensed instructions", () => {
  assert.equal(briefNotes("Use Sie.", ""), "Use Sie.");
  const long = "Rule. ".repeat(2000);
  assert.equal(briefNotes(long, "- Rule."), "- Rule.");
  // Without her instructions, the start of the brief rather than all of it.
  assert.equal(briefNotes(long, "").length, 8000);
});

test("an edited list's term counts as in the book in its other number too", () => {
  const out = overlayListRows([], [], [{ term: "Belastende hændelser", rendering: "straining incidents", keep: false }], "efter en belastende hændelse");
  assert.equal(out.length, 1);
});
