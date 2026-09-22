// ── Matching a translation's emphasis to the runs already in the paragraph ──
//
// The safety argument lives here. Distributing text across runs by a loose
// match would italicise the WRONG phrase, which is worse than losing the
// emphasis — and losing it is exactly what happens today, so refusing costs
// nothing. Every test below that ends in `null` is that rule.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allocateEmphasis,
  foldSegments,
  splitEmphasis,
} from "../src/emphasisSpans.ts";

const run = (text: string, rPrXml = "") => ({ text, rPrXml, kind: "t" });

test("consecutive runs sharing formatting fold into one segment", () => {
  const segs = foldSegments([run("Hello "), run("world"), run("!", "<i/>")]);
  assert.deepEqual(segs, [
    { rPrXml: "", text: "Hello world" },
    { rPrXml: "<i/>", text: "!" },
  ]);
});

test("virtual nodes are ignored — they carry no replaceable text", () => {
  const segs = foldSegments([
    run("a"),
    { text: "\n", rPrXml: "", kind: "virtual" },
    run("b"),
  ]);
  assert.deepEqual(segs, [{ rPrXml: "", text: "ab" }]);
});

test("the real shape from the manuscript: base / emphasised / base", () => {
  const segs = foldSegments([
    run("I will be honest with you: "),
    run("love multiplies", "<i/>"),
    run("."),
  ]);
  assert.equal(segs.length, 3);
  assert.deepEqual(
    segs.map((s) => s.rPrXml !== segs[0].rPrXml),
    [false, true, false],
  );
});

test("a matching shape allocates each piece to its segment", () => {
  const segs = foldSegments([run("before "), run("middle", "<i/>"), run(" after")]);
  const pieces = splitEmphasis("avant _milieu_ après");
  assert.deepEqual(allocateEmphasis(segs, pieces), ["avant ", "milieu", " après"]);
});

test("a differing COUNT refuses rather than guessing", () => {
  // The model merged two emphasised phrases into one. Which run loses out is
  // not knowable, so nothing is placed.
  const segs = foldSegments([
    run("a "),
    run("one", "<i/>"),
    run(" b "),
    run("two", "<i/>"),
    run(" c"),
  ]);
  assert.equal(allocateEmphasis(segs, splitEmphasis("a _un_ b deux c")), null);
});

test("a differing ORDER refuses even when the count matches", () => {
  // Three segments each way, but the docx emphasises the middle and the
  // translation emphasises the first. Placing them in order would italicise
  // the wrong words.
  const segs = foldSegments([run("a "), run("b", "<i/>"), run(" c")]);
  const pieces = [
    { text: "a", emphasised: true },
    { text: "b", emphasised: false },
    { text: "c", emphasised: false },
  ];
  assert.equal(allocateEmphasis(segs, pieces), null);
});

test("an empty piece refuses — a run would be blanked", () => {
  const segs = foldSegments([run("a "), run("b", "<i/>"), run(" c")]);
  const pieces = [
    { text: "a ", emphasised: false },
    { text: "", emphasised: true },
    { text: " c", emphasised: false },
  ];
  assert.equal(allocateEmphasis(segs, pieces), null);
});

test("a paragraph with no emphasis on either side needs no allocation", () => {
  // One segment, one piece: nothing to distribute, and the ordinary path
  // already handles it.
  const segs = foldSegments([run("plain")]);
  assert.deepEqual(allocateEmphasis(segs, splitEmphasis("simple")), ["simple"]);
});

test("no segments, or no pieces, refuses", () => {
  assert.equal(allocateEmphasis([], splitEmphasis("x")), null);
  assert.equal(allocateEmphasis(foldSegments([run("x")]), []), null);
});

test("emphasis leading the paragraph matches a docx that leads with it too", () => {
  const segs = foldSegments([run("Ilse", "<i/>"), run(" crossed the ice.")]);
  const got = allocateEmphasis(segs, splitEmphasis("_Ilse_ a traversé la glace."));
  assert.deepEqual(got, ["Ilse", " a traversé la glace."]);
});

test("a paragraph entirely in emphasis refuses — there is no base to compare", () => {
  // Found while writing this: the base cannot be "the first segment", because
  // a paragraph OPENING with emphasis would read its italic run as the base
  // and invert every comparison. It is taken from the first segment the
  // markdown calls unemphasised instead — and when there is no such piece,
  // there is nothing to tell apart.
  const segs = foldSegments([run("tout en italique", "<i/>")]);
  const pieces = [{ text: "all italic", emphasised: true }];
  assert.equal(allocateEmphasis(segs, pieces), null);
});

test("emphasis at both ends still matches, with the base taken from the middle", () => {
  const segs = foldSegments([
    run("Ilse", "<i/>"),
    run(" crossed the "),
    run("ice", "<i/>"),
  ]);
  const got = allocateEmphasis(segs, splitEmphasis("_Ilse_ a traversé la _glace_"));
  assert.deepEqual(got, ["Ilse", " a traversé la ", "glace"]);
});
