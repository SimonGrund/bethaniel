// ── The author's own term list ──
//
// Whatever the author pastes before a translation: rows the code can read
// are taken exactly as written — a client's 300-term list must not pass
// through a model that might reword it — and the rest is free text, which
// Betty formats and the brief carries verbatim.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTermList } from "../src/termList.ts";

test("tab, equals and arrow lines are rows; a header row is skipped", () => {
  const { rows, rest } = parseTermList(
    [
      "Term\tTranslation",
      "data controller\tVerantwortlicher",
      "GDPR = DSGVO",
      "sub-processor → Unterauftragsverarbeiter",
      "SCCs -> SCCs",
    ].join("\n"),
  );
  assert.deepEqual(rows, [
    { term: "data controller", rendering: "Verantwortlicher", keep: false },
    { term: "GDPR", rendering: "DSGVO", keep: false },
    { term: "sub-processor", rendering: "Unterauftragsverarbeiter", keep: false },
    { term: "SCCs", rendering: "SCCs", keep: true },
  ]);
  assert.equal(rest, "");
});

test("a Markdown table is rows, its rule line is not", () => {
  const { rows } = parseTermList("| Begreb | Oversættelse |\n|---|---|\n| Kragehøj | Kragehøj |\n| the Hollow | le Creux |");
  assert.deepEqual(rows, [
    { term: "Kragehøj", rendering: "Kragehøj", keep: true },
    { term: "the Hollow", rendering: "le Creux", keep: false },
  ]);
});

test("CSV and semicolon lists, with quoted cells", () => {
  const csv = parseTermList('source,target\n"data subject","betroffene Person"\nthird country,Drittland\n');
  assert.deepEqual(csv.rows, [
    { term: "data subject", rendering: "betroffene Person", keep: false },
    { term: "third country", rendering: "Drittland", keep: false },
  ]);
  const semi = parseTermList("Annex;Anhang\nAudit;Prüfung");
  assert.equal(semi.rows.length, 2);
});

test("a third column saying keep keeps the term", () => {
  const { rows } = parseTermList("Nordlys Analytics ApS\t\tkeep\nDPO\tDSB\t");
  assert.deepEqual(rows, [
    { term: "Nordlys Analytics ApS", rendering: "Nordlys Analytics ApS", keep: true },
    { term: "DPO", rendering: "DSB", keep: false },
  ]);
});

test("prose is free text, even with a comma or an equals sign in it", () => {
  const notes =
    "Keep all character names in English, they are part of the brand.\n" +
    "The tone should stay dry = never jokey, even in the dialogue scenes where the characters argue.";
  const { rows, rest } = parseTermList(notes + "\nMr = Herr");
  assert.deepEqual(rows, [{ term: "Mr", rendering: "Herr", keep: false }]);
  assert.equal(rest, notes);
});

test("a list mixed with notes keeps both, and a term listed twice once", () => {
  const { rows, rest } = parseTermList("GDPR = DSGVO\nPlease use formal Sie throughout.\nGDPR = GDPR");
  assert.deepEqual(rows, [{ term: "GDPR", rendering: "DSGVO", keep: false }]);
  assert.equal(rest, "Please use formal Sie throughout.");
});

test("an empty list is nothing", () => {
  assert.deepEqual(parseTermList("  \n\n "), { rows: [], rest: "" });
});

// Seen on a real run: a translator brief pasted from Word. Its bullets come
// through as "•<TAB>text" and its sub-bullets as "o<TAB>text", which read as
// two columns — every bullet became a "term", and "o → Self-help" survived
// into the table because the letter o is in any book.
test("Word bullets and numbered items are prose, not rows", () => {
  const brief = [
    "5. Terms that must remain consistent",
    "•\tWorkplace Support Pyramid",
    "•\tPsychological First Aid (PFA)",
    "o\tSelf-help",
    "o\tPeer support – one-to-one",
    "◦\tsub item",
    "1.\tFirst step",
    "a)\tthe first option",
    "-\tdash item",
    "PFA\tPsykologisk førstehjælp",
  ].join("\n");
  const { rows, rest } = parseTermList(brief);
  assert.deepEqual(rows, [{ term: "PFA", rendering: "Psykologisk førstehjælp", keep: false }]);
  assert.match(rest, /Workplace Support Pyramid/);
  assert.match(rest, /o\tSelf-help/);
});

test("a one-character term is no term", () => {
  assert.deepEqual(parseTermList("x = y\nGDPR = DSGVO").rows, [{ term: "GDPR", rendering: "DSGVO", keep: false }]);
});

test("a bulleted 'term → translation' is a row; the bullet is not part of it", () => {
  const { rows } = parseTermList(
    "•\tAkkumuleret belastning → accumulated strain\n•\tArbejdskultur → workplace culture\n- GDPR = DSGVO\n•\tthe psychological accuracy,",
  );
  assert.deepEqual(rows, [
    { term: "Akkumuleret belastning", rendering: "accumulated strain", keep: false },
    { term: "Arbejdskultur", rendering: "workplace culture", keep: false },
    { term: "GDPR", rendering: "DSGVO", keep: false },
  ]);
});

test("column headings are headings wherever they stand", () => {
  const { rows, rest } = parseTermList(
    [
      "Some notes first.",
      "Term\tDefinition for translators",
      "Psychological First Aid (PFA)\tShort-term practical, emotional, and structural support after a critical incident for everyone involved.",
      "Faglige begreber og faste oversættelser",
      "(Dansk → Engelsk)",
      "•\tArbejdsfællesskab → workplace community",
    ].join("\n"),
  );
  assert.deepEqual(rows, [{ term: "Arbejdsfællesskab", rendering: "workplace community", keep: false }]);
  assert.match(rest, /Psychological First Aid \(PFA\)/, "a definition is a note, not a translation");
});
