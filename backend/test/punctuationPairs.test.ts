// ── Two punctuation marks side by side ──
//
// ".,", ",,", "?.", ".?" — a mark typed over another, or one left behind by an
// edit. An author found one in a finished book by chance; no reader would
// take it for anything but a typo. The work here is the exceptions: an
// ellipsis is three dots, "?!" is a convention, "etc.," and "a.m.?" are an
// abbreviation's full stop meeting the sentence's own mark, "den 3., 4. og
// 5." is an ordinal, and Spanish writes "¿Vienes?, preguntó".

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findPunctuationPairs,
  getPunctuationPairCorrections,
} from "../src/punctuationPairs.ts";
import { buildPublicationScan } from "../src/publicationScan.ts";
import { classifyPublicationBlocking, isDeterministicCorrection } from "../src/correctionSeverity.ts";

const marks = (text: string, lang?: string) => findPunctuationPairs(text, lang).map((h) => h.marks);

test("the pairs that are never right are found", () => {
  for (const [text, found] of [
    ["She left., and the door closed.", ".,"],
    ["He waited,, and then he went.", ",,"],
    ["Why did she go?. Nobody knew.", "?."],
    ["Was it him.? Nobody knew.", ".?"],
    ["Stop!. He did not stop.", "!."],
    ["She said so,. Then she left.", ",."],
    ["There were three;, perhaps four.", ";,"],
    ["It ended.. Then it began again.", ".."],
    ["“Why?,” he asked.", "?,"],
    ["“Stop!,” she shouted.", "!,"],
    ["One thing:. the end.", ":."],
  ])
    assert.deepEqual(marks(text), [found], text);
});

test("marks that are not attached to a word are symbols, not punctuation", () => {
  // A songbook's repeat signs, measured on a Danish Gutenberg text.
  assert.deepEqual(marks("Og du vil spørge mig endnu? :,: Du veed det!", "da"), []);
  assert.deepEqual(marks("Hæv din Kande, ,: tøm den redebon!", "da"), []);
});

test("marks between two letters are an import's noise, not a typo", () => {
  // A badly OCR'd book on this machine: "sle..s ov vood" — 246 hits, none
  // of them anything an author typed.
  assert.deepEqual(marks("with the sle..s ov vood agd"), []);
});

test("a Markdown image after a full stop is not a pair", () => {
  assert.deepEqual(marks("Here are some sunglasses.![3d Glasses](img.png)"), []);
});

test("a run of more than two is one finding", () => {
  assert.deepEqual(marks("No,,, never."), [",,,"]);
});

test("an ellipsis and what may follow it is left alone", () => {
  for (const text of [
    // Spaced, as older books and some house styles set it.
    "Hvordan . . .? Hun er gift i Salling.",
    "She waited... and waited.",
    "And then.... nothing at all.",
    "Why...? Nobody knew.",
    "Wait...! Come back.",
    "So,... what now?",
    "She paused… and went on.",
    "Why…? Nobody knew.",
  ])
    assert.deepEqual(marks(text), [], text);
});

test("?! and its relatives are a convention, not a typo", () => {
  for (const text of ["You did what?!", "Really!?", "No!!", "What??", "What?!?"])
    assert.deepEqual(marks(text), [], text);
});

test("an abbreviation's full stop may meet the sentence's mark", () => {
  for (const [text, lang] of [
    ["Bring pens, paper, etc., and a lamp.", "en"],
    ["Did you see Mr. Smith at 5 p.m.? He was late.", "en"],
    ["The U.S., for its part, said nothing.", "en"],
    ["It was J. R. R., not J. R.", "en"],
    ["Hun købte æbler, pærer osv., og gik hjem.", "da"],
    ["Mange ting, f.eks., æbler.", "da"],
    ["Wir brauchen Stifte, Papier usw., und eine Lampe.", "de"],
    // Measured on the manuscripts on this machine: citations, notes, tunes,
    // measures.
    ["Behavior_ (Tatum et al., 2023) examined it.", "en"],
    ["[Anm.: _Hie_, Hede]", "da"],
    ["Mel.: Tyrolervise.", "da"],
    ["fortæller en sen Forfatter flg.: Der var engang", "da"],
    ["udtaler r'er (eks.: never)", "da"],
    ["opgjort til ca. 20.000 tdr., som ved", "da"],
    ["den 5 November 1673 200 Rdr., og", "da"],
    ["Gud beware Hs. Mt.! hand er en goed Herre", "da"],
    ["solgt til Frederik IV., tilligemed et Par", "da"],
    ["Mortensdag omkr. 1. Novbr.; Bagstykke", "da"],
  ])
    assert.deepEqual(marks(text, lang), [], text);
});

test("an abbreviation still cannot take two full stops", () => {
  assert.deepEqual(marks("Bring pens, paper, etc.. Then go."), [".."]);
});

test("an ordinal's full stop may meet a comma", () => {
  assert.deepEqual(marks("Det skete den 3., 4. og 5. maj.", "da"), []);
  assert.deepEqual(marks("Am 3., 4. und 5. Mai.", "de"), []);
});

test("Spanish may follow ? and ! with a comma", () => {
  assert.deepEqual(marks("¿Vienes mañana?, te lo pregunto porque sí.", "es"), []);
  assert.deepEqual(marks("¡Qué alegría!, exclamó.", "es"), []);
  // …but not with a full stop, in any language.
  assert.deepEqual(marks("¿Vienes?. No lo sé.", "es"), ["?."]);
  // And the comma is still wrong in English.
  assert.deepEqual(marks("Are you coming?, she asked.", "en"), ["?,"]);
});

// ── The correction ──

const fix = (text: string, lang?: string) =>
  getPunctuationPairCorrections(text, lang).map((c) => [c.original, c.corrected, !!c.preApproved]);

test("a doubled mark collapses to one", () => {
  assert.deepEqual(fix("He waited,, and then he went."), [["waited,, and", "waited, and", true]]);
});

test("a question or exclamation mark wins over what it collided with", () => {
  assert.deepEqual(fix("Why did she go?. Nobody knew."), [["go?. Nobody", "go? Nobody", true]]);
  assert.deepEqual(fix("Was it him.? Nobody knew."), [["him.? Nobody", "him? Nobody", true]]);
  // The closing quotation mark counts as part of the word it closes, so the
  // anchor ends there — it holds the mistake itself, which is what makes it
  // findable.
  assert.deepEqual(fix("“Why?,” he asked."), [["“Why?,”", "“Why?”", true]]);
});

test("a full stop and a comma: the one typed last is kept, and a reviewer checks", () => {
  // The second mark is the correction the author meant and did not finish:
  // measured on a real manuscript, every ".,” " was dialogue running into its
  // tag — including before a name, where a rule reading the capital after it
  // proposed a full stop.
  assert.deepEqual(fix("She left., and the door closed."), [["left., and", "left, and", false]]);
  assert.deepEqual(fix("“Just show it to us.,” Akamu barked."), [["us.,”", "us,”", false]]);
  assert.deepEqual(fix("She said so,. Then she left."), [["so,. Then", "so. Then", false]]);
});

test("two full stops are not assumed to be a full stop", () => {
  // ".." is as often a short ellipsis as a doubled stop — offered, not
  // pre-approved.
  assert.deepEqual(fix("It ended.. Then it began."), [["ended.. Then", "ended. Then", false]]);
});

test("a mark at the end of a paragraph is still anchored to its word", () => {
  assert.deepEqual(fix("It was over.,"), [["over.,", "over.", false]]);
});

test("each correction is tagged as the punctuation check's", () => {
  const [c] = getPunctuationPairCorrections("He waited,, and then he went.");
  assert.equal(c.reason, "punctuation-pair");
});

// ── In the publication scan ──

test("the scan reports each pair with its chapter and sentence, and it blocks", () => {
  const report = buildPublicationScan([
    { name: "Chapter 1", original: "“It’s my world, so I decide.,” she said. Aaron gaped." },
    { name: "Chapter 2", original: "Nothing wrong here at all, and nothing to report." },
  ]);
  const found = report.findings.filter((f) => f.check === "punctuation_pair");
  assert.equal(found.length, 1);
  assert.equal(found[0].location, "Chapter 1");
  assert.equal(found[0].blocking, true);
  assert.match(found[0].message, /\("\.,"\): ".*decide\.,” she said/);
  assert.equal(report.checks?.find((c) => c.check === "punctuation_pair")?.found, 1);
});

test("a book with more than 25 is reported once, as a damaged import", () => {
  const broken = Array.from({ length: 30 }, (_, i) => `Line ${i} ended.,  and went on.`).join("\n\n");
  const found = buildPublicationScan([{ name: "Chapter 1", original: broken }]).findings.filter(
    (f) => f.check === "punctuation_pair",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].messageKey, "scan_msg_punctuation_pair_many");
  assert.equal(found[0].params?.n, 30);
  assert.equal(found[0].wholeManuscript, true);
});

// ── In the copy edit ──

test("the copy edit's correction counts as deterministic, so the second check cannot delete it", () => {
  const [c] = getPunctuationPairCorrections("She left., and the door closed.");
  assert.equal(isDeterministicCorrection(c), true);
  // The scan's finding is what blocks publication; the correction beside it
  // is the fix, listed among the suggestions rather than counted twice — as
  // the typography repairs are.
  assert.equal(classifyPublicationBlocking(c, "proofread"), false);
});
