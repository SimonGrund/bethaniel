// The two things an author can do with a finding that proposes nothing.
//
// Accepting it would change the text not at all; dismissing it would throw
// away a real finding. So instead: say the word is yours, or supply the
// correction. This pins the logic both buttons rely on, apart from React.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Correction } from "../src/types.ts";

/** The store's dismissFindingsForWord, as a pure function over one task's
 *  corrections — "add to dictionary" withdraws every fix-less finding for the
 *  same word, so saying it once does not have to be said again per chapter. */
function withdrawForWord(cs: Correction[], word: string): Correction[] {
  const target = word.trim().toLowerCase();
  return cs.filter(
    (c) =>
      !(
        c.corrected === c.original &&
        c.original.trim().toLowerCase() === target
      ),
  );
}

/** The store's amendCorrection, likewise. */
function amend(cs: Correction[], id: string, corrected: string): Correction[] {
  return cs.map((c) =>
    c.id === id
      ? { ...c, corrected, reason: "author-correction", flagged: false }
      : c,
  );
}

const findings: Correction[] = [
  { id: "1", original: "vaelfyre", corrected: "vaelfyre", reason: "spell-check-unknown" },
  { id: "2", original: "vaelfyre", corrected: "vaelfyre", reason: "spell-check-unknown" },
  { id: "3", original: "Vaelfyre", corrected: "Vaelfyre", reason: "spell-check-unknown" },
  { id: "4", original: "barque", corrected: "barque", reason: "spell-check-unknown" },
  { id: "5", original: "thruogh", corrected: "through", reason: "spell-check" },
];

test("add to dictionary withdraws every fix-less finding for that word", () => {
  const left = withdrawForWord(findings, "vaelfyre");
  assert.deepEqual(
    left.map((c) => c.id),
    ["4", "5"],
    "all three vaelfyre findings go, whatever their casing",
  );
});

test("it leaves other words alone", () => {
  const left = withdrawForWord(findings, "vaelfyre");
  assert.ok(left.some((c) => c.original === "barque"));
});

test("it never touches a finding that HAS a fix", () => {
  // "thruogh" -> "through" is an ordinary correction with its own accept and
  // dismiss. Adding an unrelated word to the dictionary must not remove it.
  const left = withdrawForWord(findings, "thruogh");
  assert.ok(
    left.some((c) => c.id === "5"),
    "a real correction is not a fix-less finding",
  );
});

test("correcting one supplies the fix and stops it being fix-less", () => {
  const after = amend(findings, "4", "bark");
  const c = after.find((x) => x.id === "4")!;
  assert.equal(c.corrected, "bark");
  assert.notEqual(c.corrected, c.original, "it is now an ordinary correction");
  assert.equal(c.reason, "author-correction");
  assert.equal(c.flagged, false, "the author's own fix needs no flag");
});

test("correcting one leaves its neighbours untouched", () => {
  const after = amend(findings, "4", "bark");
  assert.equal(after.find((x) => x.id === "1")!.corrected, "vaelfyre");
  assert.equal(after.length, findings.length);
});
