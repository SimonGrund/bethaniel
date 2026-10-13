// The review deck renders the manuscript's Markdown emphasis instead of
// showing `_hello_`. These pin what the author sees.

import { test } from "node:test";
import assert from "node:assert/strict";

import { emphasisRuns, type Segment } from "../../frontend/src/inlineEmphasis.ts";

/** Runs as compact strings: *x* italic, **x** bold, [-x-] deleted, [+x+] inserted. */
function show(segs: Segment[]): string {
  return emphasisRuns(segs)
    .map((r) => {
      let s = r.text;
      if (r.bold) s = `**${s}**`;
      if (r.italic) s = `*${s}*`;
      if (r.kind === "del") s = `[-${s}-]`;
      if (r.kind === "ins") s = `[+${s}+]`;
      return s;
    })
    .join("");
}
const ctx = (text: string): Segment => ({ text, kind: "context" });
const eq = (text: string): Segment => ({ text, kind: "equal" });
const del = (text: string): Segment => ({ text, kind: "del" });
const ins = (text: string): Segment => ({ text, kind: "ins" });

test("underscore and asterisk emphasis render, markers hidden", () => {
  assert.equal(show([ctx("She said _hello_ and *left*.")]), "She said *hello* and *left*.");
  assert.equal(show([ctx("A **bold** move and __another__.")]), "A ****bold**** move and ****another****.".replace(/\*\*\*\*/g, "**"));
});

test("an italic phrase containing the change stays italic on both sides of it", () => {
  assert.equal(show([ctx("_The "), del("quick"), ins("swift"), ctx(" fox_ ran.")]), "*The *[-*quick*-][+*swift*+]* fox* ran.");
});

test("a passage cut inside an italic span shows it as italic", () => {
  // Window starts after the opening marker…
  assert.equal(show([ctx("in the dark_ she waited.")]), "*in the dark* she waited.");
  // …and ends before the closing one.
  assert.equal(show([ctx("He whispered _do not")]), "He whispered *do not*");
});

test("adding or removing emphasis stays visible", () => {
  // Removing italics: the deleted piece shows its emphasis, the inserted one is plain.
  assert.equal(show([del("_hello_"), ins("hello"), eq(" world")]), "[-*hello*-][+hello+] world");
  // A lone marker inside a change is shown as written.
  assert.equal(show([del("*"), eq("hello"), del("*"), eq(" world")]), "[-*-]hello[-*-] world");
});

test("underscores inside words and spaced asterisks are not emphasis", () => {
  assert.equal(show([ctx("a snake_case_name and 5 * 3 = 15")]), "a snake_case_name and 5 * 3 = 15");
  assert.equal(show([ctx("---")]), "---");
});
