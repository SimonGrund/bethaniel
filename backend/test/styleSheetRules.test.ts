// ── The author's style sheet, read into rules ──
//
// The model's half is a single small question per statement; everything
// around it is code, and is tested here with replies the model actually gave
// (Local Betty, Qwen3.5-4B, October 2026) — and with the ways a reply goes
// wrong.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkReading,
  readByCode,
  readStyleSheet,
  ruleEvidence,
  sheetJob,
  splitStatements,
} from "../src/styleSheetRules.ts";
import { isSentenceInitial } from "../src/spellcheck.ts";

const BOOK = [
  "The Givers came at dawn. Her Giving was a gift, and she kept giving bread to the Takers.",
  "He wanted to Take her pain. She would take the road. The Taker smiled at Lu’Tau.",
  "They travelled north on Blackskull. He was no-longer young.",
  "“Ye be wrong,” Lulu said. Seraphina laughed.",
].join("\n\n");

test("statements: one per line, sentences split, headings and the names block left out", () => {
  const sheet = [
    "Pirates speak grammatically wrong on purpose. Take and Give are capitalized.",
    "",
    "## House style",
    "- Write “traveled”, not “travelled”.",
    "",
    "NAMES & TERMS — the manuscript's own vocabulary",
    "Bria, Eldrik",
  ].join("\n");
  assert.deepEqual(splitStatements(sheet), [
    "Pirates speak grammatically wrong on purpose.",
    "Take and Give are capitalized.",
    "Write “traveled”, not “travelled”.",
  ]);
});

test("code reads a short 'X, not Y' and the app's own house-style lines without a model", () => {
  assert.deepEqual(readByCode("Write “traveled”, not “travelled”."), {
    kind: "replace",
    source: "Write “traveled”, not “travelled”.",
    prefer: "traveled",
    avoid: ["travelled"],
    settled: true,
  });
  assert.deepEqual(readByCode("Always use okay, not OK.")?.avoid, ["OK"]);
  // The sentence's capital is not the word's.
  assert.equal(readByCode("Dwarves, not dwarfs.")?.prefer, "dwarves");
  assert.equal(readByCode("Pirates speak grammatically wrong on purpose."), null);
});

test("the model's readings, checked against the statement and the book", () => {
  const casing = checkReading(
    "Take and Give (in all tenses) are capitalized when reffering to the magical powers.",
    '{"kind":"casing","terms":["Take","takes","Taking","Took","Taker","Give","Giving","Gave","Giver","Givers","Teleport"],"when":"when referring to the magical powers"}',
    BOOK,
  );
  assert.equal(casing.kind, "casing");
  // Forms the book never uses are dropped (Took, Gave, Give, Teleport); the
  // rest capitalised.
  assert.deepEqual(casing.terms, ["Take", "Taker", "Giving", "Givers"]);

  const keep = checkReading(
    "Keep Lu'Tau exactly as written.",
    '{"kind":"keep","terms":["Lu\'Tau"]}',
    BOOK,
  );
  assert.deepEqual(keep.terms, ["Lu’Tau"], "the book's own apostrophe");

  // "Always" capitalised has no condition: keep, not casing.
  assert.equal(
    checkReading("Givers are always capitalized.", '{"kind":"casing","terms":["Givers"],"when":"always"}', BOOK).kind,
    "keep",
  );
  // Nothing to replace in this book, but the preferred form is the book's: keep it.
  assert.deepEqual(
    checkReading("Blackskull is one word.", '{"kind":"replace","prefer":"Blackskull","avoid":["Black skull"]}', BOOK)
      .terms,
    ["Blackskull"],
  );
  assert.deepEqual(
    checkReading("Pirates speak grammatically wrong on purpose.", '```json\n{"kind":"dialogue","who":"Pirates"}\n```', BOOK),
    { kind: "dialogue", source: "Pirates speak grammatically wrong on purpose.", who: "Pirates" },
  );
});

test("a reading that does not hold up is a note: the statement reaches the editor as written", () => {
  const s = "Use American spelling throughout.";
  for (const reply of [
    '{"kind":"replace","prefer":"American spelling","avoid":["British spelling"]}', // nothing in the book
    '{"kind":"keep","terms":["Gandalf"]}', // not in the statement
    "I think this is a note.", // no JSON
    '{"kind":"dialogue"}', // no who
    '{"kind":"teleport"}',
  ]) {
    assert.equal(checkReading(s, reply, BOOK).kind, "note", reply);
  }
});

test("reading the sheet: code first, one question per remaining statement, failures are notes", async () => {
  const asked: string[] = [];
  const rules = await readStyleSheet(
    "Write “traveled”, not “travelled”.\nPirates speak wrong.\nSpell out numbers.\nKnown already.",
    BOOK,
    {
      llm: async (_system, user) => {
        asked.push(user);
        if (user.includes("Pirates")) return '{"kind":"dialogue","who":"Pirates"}';
        throw new Error("engine gone");
      },
      skip: (s) => s === "Known already.",
    },
  );
  assert.deepEqual(asked, ["Instruction: Pirates speak wrong.", "Instruction: Spell out numbers."]);
  assert.deepEqual(
    rules.map((r) => r.kind),
    ["replace", "dialogue", "note"],
  );
});

test("evidence: the book's counts, and the minority spellings to tick", () => {
  const ev = ruleEvidence(
    { kind: "casing", source: "", terms: ["Take", "Giving"] },
    BOOK,
    isSentenceInitial,
  );
  assert.deepEqual(ev.casing, [
    { form: "Take", capitalised: 1, lowercase: 1 },
    { form: "Giving", capitalised: 1, lowercase: 1 },
  ]);
  // A tie keeps the capital as the habit: the lowercase ones are offered.
  assert.deepEqual(
    ev.minority?.map((m) => [m.original, m.corrected]),
    [
      ["pain. She would take the road. The", "pain. She would Take the road. The"],
      ["and she kept giving bread to the", "and she kept Giving bread to the"],
    ],
  );
  const names = ruleEvidence({ kind: "dialogue", source: "", who: "Pirates" }, BOOK, isSentenceInitial, [
    { term: "Lulu", count: 36 },
  ]);
  assert.deepEqual(names.candidates, [{ name: "Lulu", count: 36 }]);
});

test("the confirmed rules become the job, and leave the guide the editor reads", () => {
  const guide = [
    "Pirates speak grammatically wrong on purpose.",
    "Take and Give (in all tenses) are capitalized when reffering to the magical powers.",
    "Use American spelling.",
    "## House style",
    "- Write “traveled”, not “travelled”.",
  ].join("\n");
  const job = sheetJob(guide, [
    { kind: "dialogue", source: "Pirates speak grammatically wrong on purpose.", speakers: ["Lulu", "Seraphina"] },
    {
      kind: "casing",
      source: "Take and Give (in all tenses) are capitalized when reffering to the magical powers.",
      terms: ["Take", "Give"],
      fixes: [{ original: "would take the", corrected: "would Take the" }],
    },
    { kind: "replace", source: "Write “traveled”, not “travelled”.", prefer: "traveled", avoid: ["travelled"] },
    { kind: "keep", source: "nowhere", terms: [] }, // nothing to enforce
    "junk",
  ]);
  assert.deepEqual(job.replace, [{ prefer: "traveled", avoid: ["travelled"] }]);
  assert.deepEqual(job.casing, ["Take", "Give"]);
  assert.deepEqual(job.speakers, ["Lulu", "Seraphina"]);
  assert.deepEqual(job.fixes, [{ original: "would take the", corrected: "would Take the" }]);
  assert.equal(
    job.guide,
    [
      "Use American spelling.",
      "## House style",
      "The speech of Lulu, Seraphina is written the way they talk, on purpose: never correct its grammar or wording.",
    ].join("\n"),
  );
  // Nothing confirmed: the guide is the author's, untouched.
  assert.equal(sheetJob(guide, undefined).guide, guide);
});
