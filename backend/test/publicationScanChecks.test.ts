// ── What was checked, passes included ──
//
// A verdict of "9 issues to check before publishing" says what is wrong and
// nothing about what is right, which leaves an author unable to tell a check
// that passed from a check that never ran. The tally reports every check with
// its count, and the zeros are the reason it exists.
//
// The distinction that has to hold: a check with nothing to judge by has not
// cleared anything. A French novel has no English dialect and a book with
// four quotation marks has no convention; reporting "none found" there would
// claim a clearance the scan never gave.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPublicationScan, type ScanUnit } from "../src/publicationScan.ts";
import { STRUCTURAL_CHECKS } from "../src/types.ts";

/** A clean English book: curly marks, curly apostrophes, real ellipses. */
function cleanBook(): ScanUnit[] {
  return Array.from({ length: 6 }, (_, i) => ({
    name: `Chapter ${i + 1}`,
    original: [
      `“She didn’t answer,” he said. “It wasn’t Tobias’s place to ask.”`,
      `The harbour was quiet… and the tide was going out. She waited…`,
      `“We should go,” Bria said. “Before the captain’s watch ends.”`,
      `Chapter ${i + 1} ended the way the others had, with nothing settled.`,
    ].join("\n\n"),
  }));
}

const tallyFor = (report: { checks?: { check: string; found: number; skipped?: boolean }[] }) =>
  new Map((report.checks ?? []).map((c) => [c.check, c]));

test("every check the scan knows appears in the tally", () => {
  // Including the ones that found nothing — a list of only the failures is
  // the report that already existed.
  const report = buildPublicationScan(cleanBook(), { manuscriptLang: "en" });
  const tally = tallyFor(report);
  for (const check of STRUCTURAL_CHECKS) {
    assert.ok(tally.has(check), `missing ${check}`);
  }
  assert.equal(tally.size, STRUCTURAL_CHECKS.length);
});

test("a clean book reports zero, not silence", () => {
  const report = buildPublicationScan(cleanBook(), { manuscriptLang: "en" });
  const tally = tallyFor(report);
  for (const check of ["duplicate", "repetition", "placeholder", "empty_chapter"]) {
    assert.equal(tally.get(check)?.found, 0, check);
    assert.notEqual(tally.get(check)?.skipped, true, `${check} was skipped`);
  }
});

test("a count matches the findings it came from", () => {
  const units = cleanBook();
  units.push({
    name: "Chapter 7",
    original: `“The room is here.” TODO: describe the room properly.\n\n${units[0].original}`,
  });
  const report = buildPublicationScan(units, { manuscriptLang: "en" });
  const tally = tallyFor(report);
  assert.equal(tally.get("placeholder")?.found, 1);
  for (const [check, row] of tally) {
    assert.equal(
      row.found,
      report.findings.filter((f) => f.check === check).length,
      check,
    );
  }
});

test("a check with nothing to judge by is skipped, not passed", () => {
  // The load-bearing case. This book holds no quotation marks, no
  // apostrophes and no ellipses, so three checks have no convention to
  // measure against — and saying "none found" would be a clearance.
  const bare: ScanUnit[] = Array.from({ length: 4 }, (_, i) => ({
    name: `Chapter ${i + 1}`,
    original: `The tide went out and the harbour emptied. Nobody spoke of it again.`,
  }));
  const tally = tallyFor(buildPublicationScan(bare, { manuscriptLang: "en" }));
  for (const check of ["quote_style", "apostrophe_style", "ellipsis_style"]) {
    assert.equal(tally.get(check)?.skipped, true, check);
    assert.equal(tally.get(check)?.found, 0, check);
  }
});

test("a French novel's English dialect check is skipped", () => {
  const french: ScanUnit[] = Array.from({ length: 4 }, (_, i) => ({
    name: `Chapitre ${i + 1}`,
    original: `« Elle n’a pas répondu », dit-il. « Ce n’était pas à lui de demander. »`,
  }));
  const tally = tallyFor(buildPublicationScan(french, { manuscriptLang: "fr" }));
  assert.equal(tally.get("dialect")?.skipped, true);
  // And the quotation-mark check still runs: the convention is read off the
  // page, so guillemets are a convention like any other.
  assert.notEqual(tally.get("quote_style")?.skipped, true);
});

test("a declared quote style gives the apostrophe check something to judge by", () => {
  // Same precedence as resolveConvention: the author's setting outranks a
  // book too short to have a majority of its own.
  const bare: ScanUnit[] = [
    { name: "Chapter 1", original: "The tide went out and the harbour emptied." },
  ];
  assert.equal(
    tallyFor(buildPublicationScan(bare)).get("apostrophe_style")?.skipped,
    true,
  );
  assert.notEqual(
    tallyFor(buildPublicationScan(bare, { quoteStyle: "curly" })).get(
      "apostrophe_style",
    )?.skipped,
    true,
  );
});
