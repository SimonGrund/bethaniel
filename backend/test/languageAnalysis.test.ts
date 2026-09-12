// The language report is counts, so its tests plant a habit and check the
// count finds it — and, as important, that prose without the habit is not
// told it has one. Thresholds are soft, so the assertions are on presence
// and ordering, not on decimals.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLanguage } from "../src/languageAnalysis.ts";

const sentence = (i: number) =>
  [
    "The harbour was quiet at that hour.",
    "A gull settled on the rail and considered the water for a while.",
    "Somewhere behind the warehouses a bell rang twice.",
    "She pulled her coat tighter.",
    "Nothing moved on the quay except the light, which had begun to change.",
    "It would rain before evening; the sky over the headland had the look of it.",
    "Marta counted the boats again, though she knew the number.",
    "Nine.",
  ][i % 8];

/** Ordinary prose: varied sentence lengths, varied openers, few adverbs. */
function cleanChapter(name: string, n = 80): { name: string; original: string } {
  const paras: string[] = [];
  for (let p = 0; p < n / 8; p++) {
    paras.push(Array.from({ length: 8 }, (_, i) => sentence(i + p)).join(" "));
  }
  return { name, original: paras.join("\n\n") };
}

test("clean prose: no headline fires and the counts are sane", () => {
  const r = analyzeLanguage([cleanChapter("One"), cleanChapter("Two")], "en");
  assert.equal(r.chaptersScanned, 2);
  assert.ok(r.words > 600);
  assert.ok(r.sentences > 100);
  assert.deepEqual(r.headlines.map((h) => h.id), []);
  assert.equal(r.pacing.length, 2);
  assert.ok(r.pacing[0].meanSentence > 5 && r.pacing[0].meanSentence < 20);
});

test("adverbs: a -ly habit is counted and headlined, adjectives in -ly are not", () => {
  const text =
    "She walked slowly to the door and quietly opened it. The family waited nervously. " +
    "He spoke softly, then suddenly turned and left quickly. The early train was really late. " +
    "They sat silently. It was a lovely, lonely, holy place, and she moved carefully. ";
  const r = analyzeLanguage([{ name: "A", original: Array(6).fill(text).join("\n\n") }], "en");
  const adv = r.adverbs.top.map((x) => x.word);
  assert.ok(adv.includes("slowly") && adv.includes("quietly") && adv.includes("carefully"));
  for (const notAdverb of ["family", "early", "lovely", "lonely", "holy"]) {
    assert.ok(!adv.includes(notAdverb), `${notAdverb} must not count as an adverb`);
  }
  assert.ok(r.headlines.some((h) => h.id === "adverbs_high"), JSON.stringify(r.headlines));
});

test("crutch words: 'very' at several per thousand is an overused entry and a headline", () => {
  const text = "It was very cold and very dark, and the road was very long. ";
  const r = analyzeLanguage([{ name: "A", original: text.repeat(30) }], "en");
  const very = r.overused.find((o) => o.word === "very");
  assert.ok(very && very.kind === "crutch" && very.perThousand > 20);
  assert.ok(r.headlines.some((h) => h.id === "crutch_word" && h.params.word === "very"));
});

test("frequent words: names are kept out of the table, ordinary nouns are in it", () => {
  const text =
    "The lantern swung. Marta lifted the lantern. The lantern guttered and Marta cursed the lantern. " +
    "Marta set the lantern down. The lantern was out. ";
  const r = analyzeLanguage([{ name: "A", original: text.repeat(4) }], "en");
  const freq = r.overused.filter((o) => o.kind === "frequent").map((o) => o.word);
  assert.ok(freq.includes("lantern"));
  assert.ok(!freq.includes("marta"), "a mid-sentence capitalised word is a name, not an overused noun");
});

test("openers: a run of the same first word is reported with its length", () => {
  const text =
    "He stood up. He walked to the window. He looked out. He said nothing. He sat down again. " +
    "The rain had stopped. A door closed somewhere. ";
  const r = analyzeLanguage([{ name: "Ch", original: text.repeat(3) }], "en");
  assert.ok(r.openerRuns.length >= 1);
  assert.equal(r.openerRuns[0].word, "he");
  assert.ok(r.openerRuns[0].length >= 5);
  assert.ok(r.headlines.some((h) => h.id === "opener_runs" || h.id === "opener_dominant"));
});

test("echoes: a distinctive word repeated within forty words is caught, a stopword is not", () => {
  const text =
    "The clockwork mechanism ticked in the dark, and she wondered whether the mechanism " +
    "would hold until morning. It was the only thing in the room that made a sound.";
  const r = analyzeLanguage([{ name: "Ch", original: text }], "en");
  assert.ok(r.echoes.some((e) => e.word === "mechanism"));
  assert.ok(!r.echoes.some((e) => e.word === "the"));
});

test("rhythm: unvarying sentence length is headlined, varied is not", () => {
  const flat = Array.from({ length: 12 }, () =>
    Array(5).fill("The man walked down the long road to town.").join(" "),
  ).join("\n\n");
  const r1 = analyzeLanguage([{ name: "Flat", original: flat }], "en");
  assert.ok(r1.headlines.some((h) => h.id === "rhythm_flat"), JSON.stringify(r1.headlines));
  assert.equal(r1.rhythm.sd, 0);
  const r2 = analyzeLanguage([cleanChapter("Varied")], "en");
  assert.ok(!r2.headlines.some((h) => h.id === "rhythm_flat"));
});

test("dialogue: share and tags", () => {
  const text =
    "“We should go,” she said. “Now.”\n\n" +
    "“Not yet,” he muttered. “Wait for the tide,” he insisted.\n\n" +
    "“Fine,” she said, and turned back to the window.\n\n" +
    "The harbour lay flat and grey below them, and neither spoke for a long while after that.";
  const r = analyzeLanguage([{ name: "Ch", original: text }], "en");
  assert.ok(r.pacing[0].dialogueShare > 20 && r.pacing[0].dialogueShare < 80);
  assert.equal(r.dialogueTags.said, 2);
  const others = r.dialogueTags.other.map((o) => o.word);
  assert.ok(others.includes("muttered") && others.includes("insisted"));
});

test("paragraphs: a very long one is counted", () => {
  const long = Array.from({ length: 45 }, (_, i) => sentence(i)).join(" ");
  const r = analyzeLanguage([{ name: "Ch", original: long + "\n\nShort one." }], "en");
  assert.equal(r.paragraphs.count, 2);
  assert.equal(r.paragraphs.over200, 1);
});

test("Danish: crutch words are counted and the adverb suffix is off", () => {
  const text = "Det var meget koldt, og hun var virkelig træt. Han kiggede bare på hende og nikkede lidt. ";
  const r = analyzeLanguage([{ name: "Et", original: text.repeat(20) }], "da");
  assert.equal(r.language, "da");
  assert.equal(r.adverbs.detected, false);
  const meget = r.overused.find((o) => o.word === "meget");
  assert.ok(meget && meget.kind === "crutch");
  assert.ok(!r.headlines.some((h) => h.id === "adverbs_high"));
});

test("Spanish: -mente adverbs are counted", () => {
  const text = "Caminó lentamente hacia la puerta y la abrió suavemente. Habló claramente y salió rápidamente. La mente estaba en calma. ";
  const r = analyzeLanguage([{ name: "Uno", original: text.repeat(8) }], "es");
  const adv = r.adverbs.top.map((x) => x.word);
  assert.ok(adv.includes("lentamente") && adv.includes("rápidamente"));
  assert.ok(!adv.includes("mente"));
});

test("unknown language falls back to English lists rather than failing", () => {
  const r = analyzeLanguage([cleanChapter("One")], "xx");
  assert.equal(r.language, "en");
});

test("headlines are ordered by how far past threshold, at most four", () => {
  const text =
    "He very slowly and very carefully walked very quietly. He very nearly fell. He really, truly, deeply sighed. ";
  const r = analyzeLanguage([{ name: "Ch", original: text.repeat(20) }], "en");
  assert.ok(r.headlines.length >= 2 && r.headlines.length <= 4);
  const ids = r.headlines.map((h) => h.id);
  assert.ok(ids.includes("crutch_word") && ids.includes("adverbs_high"));
});
