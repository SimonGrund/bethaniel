// Text repeated back-to-back inside one paragraph — a dialogue tag duplicated
// by a botched edit or a bad import, not prose anyone wrote.
//
// The case that prompted the check, from a live 80,000-word book: the scan
// found the paragraph but reported it as "Unbalanced quotation marks", at
// `info`, because the stray “ is all the quote-balance check can see. The
// author read six punctuation notes and skipped past the one that mattered.
//
// The line between this and rhetoric is a quotation mark. Prose repeats
// words for effect — "This isn't real, it isn't real" — but it never repeats
// the mark that closes a line of speech: that belongs to one line and one
// only, so seeing it twice in a row means the text was assembled wrong. Every
// rhetorical case below is verbatim from the same four manuscripts the two
// real defects came from.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPublicationScan } from "../src/publicationScan.ts";

const PROSE = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i} of ordinary prose that carries the chapter along.`,
).join("\n\n");

function scan(paragraph: string) {
  return buildPublicationScan([
    { name: "Chapter six", original: `${PROSE}\n\n${paragraph}` },
  ] as never).findings;
}

const repetitions = (p: string) => scan(p).filter((f) => f.check === "repetition");

test("a duplicated dialogue tag is reported, and named", async () => {
  const f = repetitions("“And us? We just escape?” Bria asked.” Bria asked.");
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].message, /Bria asked\./);
  assert.equal(f[0].severity, "error");
  assert.equal(f[0].location, "Chapter six");
});

test("the finding carries the passage, so the author can check it", async () => {
  const f = repetitions("“I don’t care about the Rule!” Bria spat out.” Bria spat out. “Or King Eldrik!”");
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].detail ?? "", /I don’t care about the Rule/);
});

test("the same paragraph is not ALSO reported as an unbalanced quote", async () => {
  // The stray ” is the symptom; the duplication is the defect. Reporting both
  // is what buried the real finding under punctuation notes in the first place.
  const all = scan("“And us? We just escape?” Bria asked.” Bria asked.");
  assert.equal(all.filter((f) => /quotation marks/i.test(f.message)).length, 0,
    JSON.stringify(all));
});

// ── Rhetoric, all verbatim from real manuscripts ──

test("repetition for emphasis inside speech is not a finding", async () => {
  assert.deepEqual(repetitions("“This isn’t real, it isn’t real, it isn’t real.” She scanned the room."), []);
});

test("a repeated refrain in narration is not a finding", async () => {
  assert.deepEqual(repetitions("Break. Hammering. Break. Hammering. Break."), []);
});

test("“I know, I know” is not a finding", async () => {
  assert.deepEqual(repetitions("“I know, I know, we shouldn’t have come back when you told us—”"), []);
});

test("a thought repeating in a character's mind is not a finding", async () => {
  assert.deepEqual(
    repetitions("Flint barely heard the words, the thoughts repeating over and over. I can’t Take. I can’t Take."),
    [],
  );
});

test("a doubled single word is left to the copy edit", async () => {
  // retext's repeated-words rule owns "the the"; the scan is for assembly
  // flaws, and a two-character span is not one.
  assert.deepEqual(repetitions("She opened the the door and stepped through."), []);
});

test("ordinary dialogue is not a finding", async () => {
  assert.deepEqual(
    repetitions("“And us? We just escape?” Bria asked.\n\n“Yes,” Kindra replied."),
    [],
  );
});
