// ── Manuscript lexicon ──
//
// The harvest must find what a book spells consistently — a character, a
// scripture, a spell, a title — and nothing that merely opens sentences; and
// the gate must stop the exact corrections that prompted this ("Petran" →
// "Petra", "Gata" → "Data") while letting a typo of a name be fixed to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLexiconSheetBlock,
  gateProtectedTerms,
  harvestLexicon,
  parseLexicon,
  protectedTermsOf,
} from "../src/lexicon.ts";
import type { Correction } from "../src/types.ts";

// A tiny English dictionary predicate: anything in this list is a word.
const ENGLISH = new Set(
  (
    "the a an and of to in was is i she he it her his they them that this " +
    "what just happened trying help following plea now locked up like criminal " +
    "temptation shall test faithful each dawning dusk flame thief tome eternal " +
    "vigil then ran said data petra grace with cast spell twice again at dawn " +
    "silver hand order little house door lamp went out came back thirteen " +
    "ordinary word words never once who where when why how not do did not " +
    "would could should have had has been being are were be am oh yes no so " +
    "but or if for on by from as into over under after before while until " +
    "book page read reads reading wrote written write chapter part night day " +
    "morning evening sun moon star stars sky sea land road city town village " +
    "king queen prince princess lord lady sir mister miss doctor captain guard " +
    "gate gates data dates date"
  ).split(/\s+/),
);
const isWord = (w: string) => ENGLISH.has(w.toLowerCase());

const CHAPTER = `# Thirteen

## The Flame Thief

**_Tome of the Eternal Vigil, Petran 5:8_** _Temptation shall test the faithful in each dawning and each dusk._

Thirteen

_What just happened?_ I was trying to help. I was following Gata’s plea. And now I’m locked up like a criminal.

Gata had said the Tome of the Eternal Vigil was never wrong. Petran 5:8 was her favourite. She read Petran to me twice, and the Flame Thief was in it.

Then Gata ran. Then Gata ran again. Then Gata ran a third time, and Silverhand went with her. Silverhand was the guard. Silverhand, Silverhand, Silverhand — the name was on every door, and Silverhnad on one where the sign-painter had slipped.

She cast vaelfyre at the gate. The vaelfyre burned blue. When the vaelfyre went out, the Flame Thief was gone, and the Tome of the Eternal Vigil with him. Nobody had seen the Flame Thief take the Tome of the Eternal Vigil.

Then came Grace, and Grace was ordinary, so Grace went out. The little house was quiet, and Gata slept.
`;

test("harvest: names spelled consistently mid-sentence, not dictionary words", () => {
  const lex = harvestLexicon(CHAPTER, { lang: "en", isWord });
  const names = lex.terms.filter((t) => t.kind === "name").map((t) => t.term);
  assert.ok(names.includes("Gata"), `Gata in ${names}`);
  assert.ok(names.includes("Petran"), `Petran in ${names}`);
  assert.ok(names.includes("Silverhand"), `Silverhand in ${names}`);
  // A dictionary word used as a name is not what the list is for.
  assert.ok(!names.includes("Grace"), "Grace is a dictionary word");
  // Sentence openers are not evidence: "Then" opens three sentences.
  assert.ok(!names.includes("Then"), "Then only opens sentences");
  assert.ok(!names.includes("Thirteen"), "the chapter heading is structure");
  for (const t of lex.terms) assert.equal(t.enabled, true, "harvested terms start protected");
});

test("harvest: a lowercase coinage is a word; a run of capitals is a phrase", () => {
  const lex = harvestLexicon(CHAPTER, { lang: "en", isWord });
  const words = lex.terms.filter((t) => t.kind === "word").map((t) => t.term);
  assert.deepEqual(words, ["vaelfyre"]);
  const phrases = lex.terms.filter((t) => t.kind === "phrase").map((t) => t.term);
  assert.ok(phrases.includes("Flame Thief"), `Flame Thief in ${phrases}`);
  assert.ok(phrases.includes("Tome of the Eternal Vigil"), `Tome… in ${phrases}`);
  assert.ok(!phrases.includes("Then Gata"), "a sentence opener never starts a phrase");
  assert.ok(!phrases.some((p) => p.startsWith("The ")), "the article is not part of a title");
});

test("harvest: a rare token one edit from a frequent name is a near miss, not a term", () => {
  const lex = harvestLexicon(CHAPTER, { lang: "en", isWord });
  assert.deepEqual(
    lex.nearMisses.map((n) => [n.term, n.of]),
    [["Silverhnad", "Silverhand"]],
  );
  assert.ok(!lex.terms.some((t) => t.term === "Silverhnad"));
});

test("harvest: counts and order", () => {
  const lex = harvestLexicon(CHAPTER, { lang: "en", isWord });
  const gata = lex.terms.find((t) => t.term === "Gata")!;
  // Five bare "Gata"s; the possessive "Gata's" is its own token and is
  // covered by the gate's stemming, not by the count.
  assert.equal(gata.count, 5);
  assert.equal(lex.terms[0].term, "Gata", "most frequent first");
});

test("harvest: without a dictionary, capitalised evidence still works and coinages are skipped", () => {
  const lex = harvestLexicon(CHAPTER, { lang: "en", isWord: null });
  const names = lex.terms.filter((t) => t.kind === "name").map((t) => t.term);
  assert.ok(names.includes("Gata"));
  assert.ok(names.includes("Grace"), "nothing says Grace is a word now");
  assert.equal(lex.terms.filter((t) => t.kind === "word").length, 0);
});

test("harvest: German capitalises every noun, so without a dictionary there are no names", () => {
  const de = "Der Hund lief zum Haus. Almut sah den Hund. Almut rief den Hund. Konrad und Almut gingen zum Haus.";
  const noDict = harvestLexicon(de, { lang: "de", isWord: null, minCount: 2 });
  assert.equal(noDict.terms.filter((t) => t.kind === "name").length, 0);
  const german = new Set(["der", "hund", "lief", "zum", "haus", "sah", "den", "rief", "und", "gingen"]);
  const withDict = harvestLexicon(de, { lang: "de", isWord: (w) => german.has(w.toLowerCase()), minCount: 2 });
  assert.deepEqual(
    withDict.terms.filter((t) => t.kind === "name").map((t) => t.term).sort(),
    ["Almut"],
  );
});

test("harvest: casing variants ride along; the dominant one is canonical", () => {
  const text = "Zorak came. Then zorak left, and Zorak returned; Zorak, Zorak, ZORAK.";
  const lex = harvestLexicon(text, { lang: "en", isWord: () => false });
  const z = lex.terms.find((t) => t.term === "Zorak")!;
  assert.ok(z, "Zorak harvested");
  assert.deepEqual([...(z.variants ?? [])].sort(), ["ZORAK", "zorak"]);
});

// ── Gate ──

const P = { words: ["Gata", "Petran", "Silverhand", "vaelfyre"], phrases: ["Flame Thief"] };
const c = (original: string, corrected: string, reason?: string): Correction =>
  reason ? { original, corrected, reason } : { original, corrected };

test("gate: a name replaced by a dictionary word is dropped, with the term named", () => {
  const r = gateProtectedTerms([c("Petran 5:8", "Petra 5:8", "spell-check")], P);
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped[0].term, "Petran");
});

test("gate: a possessive counts as the name", () => {
  const r = gateProtectedTerms([c("following Gata’s plea", "following Data’s plea")], P);
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped[0].term, "Gata");
});

test("gate: a typo of a name fixed TO the name is kept", () => {
  const r = gateProtectedTerms([c("and Silverhnad on one", "and Silverhand on one")], P);
  assert.equal(r.kept.length, 1);
});

test("gate: casing toward the canonical form is kept, away from it is dropped", () => {
  const toward = gateProtectedTerms([c("then gata left", "then Gata left")], P);
  assert.equal(toward.kept.length, 1);
  const away = gateProtectedTerms([c("then Gata left", "then gata left")], P);
  assert.equal(away.dropped.length, 1);
});

test("gate: a change beside the term leaves it standing", () => {
  const r = gateProtectedTerms(
    [c("Gata had said the Tome", "Gata had said, the Tome"), c("She cast vaelfyre at the gate", "She cast vaelfyre at the gates")],
    P,
  );
  assert.equal(r.kept.length, 2);
});

test("gate: a hyphen compound of the term is the term", () => {
  const r = gateProtectedTerms([c("the Gata-born child", "the Data-born child")], P);
  assert.equal(r.dropped[0]?.term, "Gata");
});

test("gate: a phrase is protected as a whole", () => {
  const r = gateProtectedTerms(
    [c("the Flame Thief was gone", "the flame thief was gone"), c("the Flame Thief was gone", "the Flame Thief had gone")],
    P,
  );
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].term, "Flame Thief");
  assert.equal(r.kept.length, 1);
});

test("gate: an unrelated correction, and an empty lexicon, pass everything", () => {
  const cs = [c("teh gate", "the gate"), c("Petran 5:8", "Petra 5:8")];
  assert.equal(gateProtectedTerms(cs, null).kept.length, 2);
  assert.equal(gateProtectedTerms([cs[0]], P).kept.length, 1);
});

// ── Round trip ──

test("protectedTermsOf honours enabled and splits phrases; parseLexicon rejects junk", () => {
  const lex = harvestLexicon(CHAPTER, { lang: "en", isWord });
  lex.terms.find((t) => t.term === "Petran")!.enabled = false;
  const p = protectedTermsOf(lex)!;
  assert.ok(!p.words.includes("Petran"));
  assert.ok(p.words.includes("Gata"));
  assert.ok(p.phrases.includes("Flame Thief"));

  const parsed = parseLexicon(JSON.parse(JSON.stringify(lex)))!;
  assert.equal(parsed.terms.find((t) => t.term === "Petran")!.enabled, false);
  assert.equal(parseLexicon({ terms: "no" }), null);
  assert.equal(parseLexicon({ terms: [{ term: 42 }] }), null);
  const manual = parseLexicon({ terms: [{ term: "  Vardo  ", source: "manual" }] })!;
  assert.deepEqual(manual.terms[0], { term: "Vardo", count: 0, kind: "name", source: "manual", enabled: true });

  const block = buildLexiconSheetBlock(p);
  assert.match(block, /NAMES & TERMS/);
  assert.match(block, /Gata/);
  assert.doesNotMatch(block, /Petran/);
  assert.equal(buildLexiconSheetBlock(null), "");
});
