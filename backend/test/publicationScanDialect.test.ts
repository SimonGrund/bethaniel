// The publication scan's dialect check had two faults that pulled in opposite
// directions, both traced from a real reading of the code:
//
//  1. It counted the WHOLE conversion list as evidence, including -ise/-ize.
//     Oxford spelling ("realize", "organize") is correct British — OUP house
//     style — so a perfectly consistent Oxford-spelling manuscript came back
//     "mostly British but N words are American" and was told to pick one
//     dialect it had already picked.
//
//  2. It decided the expected dialect by majority vote, because the author's
//     declared englishDialect never reached it — routes.ts built the scan task
//     without editOptions at all. So a manuscript set to British but still
//     mostly American was advised to standardise on American, which is the
//     opposite of what the copy-edit pass would do to the same text.
//
// The docstring claimed detection and enforcement could never disagree. These
// tests are what makes that true.

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectDialect } from "../src/dialect.ts";
import { buildPublicationScan } from "../src/publicationScan.ts";

type Finding = { check: string; message: string; detail?: string };

function dialectFindings(
  body: string,
  options?: { englishDialect?: "american" | "british" },
): Finding[] {
  const report = buildPublicationScan(
    [{ name: "Chapter One", original: body }] as never,
    options,
  );
  return (report.findings as Finding[]).filter((f) => f.check === "dialect");
}

// Consistent British prose in Oxford spelling: -ize endings throughout, and
// British -our / -re / -ence throughout. Nothing here is inconsistent.
const OXFORD_BRITISH = `
The colour of the harbour had not changed. She began to realize that her
neighbour was right. They would organize the defence themselves and recognize
the grey light of the centre of town. He apologized to the theatre manager.
She emphasized the favour, criticized the labour, and summarized the rumours.
The travellers organized their jewellery before the neighbours arrived.
`.repeat(3);

test("Oxford spelling is not counted as American evidence", () => {
  const d = detectDialect(OXFORD_BRITISH);
  assert.equal(d.dialect, "british");
  assert.equal(
    d.americanHits,
    0,
    "every -ize here is correct British; none of it is American evidence",
  );
});

test("a consistent Oxford-spelling manuscript is not reported as mixed", () => {
  assert.deepEqual(
    dialectFindings(OXFORD_BRITISH),
    [],
    "telling this author to pick one dialect is telling them to do nothing",
  );
});

// Genuinely mixed: both spellings of the same words, in quantity.
const GENUINELY_MIXED = `
The colour of the harbour was grey. The color of the harbor was gray.
Her neighbour walked to the theatre; her neighbor walked to the theater.
It was his favourite defence, and also his favorite defense. The centre
of town and the center of town were the same place. Grey and gray both.
`.repeat(3);

test("genuinely mixed spelling is still caught", () => {
  const found = dialectFindings(GENUINELY_MIXED);
  assert.equal(found.length, 1, "this manuscript really is inconsistent");
});

test("an exact 50/50 split is reported rather than silently dropped", () => {
  // detectDialect returns dialect:null on a tie, and the old guard bailed on
  // null — so the MOST inconsistent manuscript possible produced no warning
  // at all. It must still be reported, just without naming a house style.
  const found = dialectFindings(GENUINELY_MIXED);
  assert.equal(found.length, 1);
  assert.doesNotMatch(
    found[0].message,
    /mostly/,
    "neither side is the majority, so neither is 'mostly' anything",
  );
});

test("the declared dialect is what the scan measures against", () => {
  // Majority American, but the author has asked for British. The scan must
  // point at the American words as the ones to change — not recommend that
  // the author abandon the dialect they chose.
  const mostlyAmerican = `
    The color of the harbor had not changed. She saw the gray light. He
    walked to the theater in the center of town. His neighbor apologized.
    The defense was ready. Her favorite color was gray. The armor was gray.
    But the colour of the harbour was grey, and her neighbour knew it.
  `.repeat(3);

  const found = dialectFindings(mostlyAmerican, { englishDialect: "british" });
  assert.equal(found.length, 1);
  assert.match(
    found[0].message,
    /American/,
    "the American words are the deviation from the declared British",
  );
  assert.match(
    found[0].message + (found[0].detail ?? ""),
    /British/,
    "the finding must name the dialect the author actually asked for",
  );
  assert.doesNotMatch(
    found[0].detail ?? "",
    /[Pp]ick one dialect/,
    "the author already picked one; the scan must not ask them to choose again",
  );
});

test("without a declared dialect the scan still falls back to the majority", () => {
  // Running the scan on its own, with no copy-edit panel configured, must keep
  // working exactly as before. Needs a fixture with a real majority — the
  // 50/50 fixture above has none by construction.
  const mostlyBritish = `
    The colour of the harbour was grey, and her neighbour crossed the centre
    of town towards the theatre. His favourite defence was the grey armour.
    The travellers gathered by the harbour, and the colour of the rumours
    had not changed. The neighbours watched the theatre troupe travelling.
    Someone mentioned the color once, the gray harbor twice, and the theater
    and its neighbor a third time — enough to be inconsistency, not an outlier.
  `.repeat(3);
  const found = dialectFindings(mostlyBritish);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /mostly British/);
});
