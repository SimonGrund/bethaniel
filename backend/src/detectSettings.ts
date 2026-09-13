// ── Deterministic detection of the settings the author is asked to declare ──
//
// Betty's wizard asks for the manuscript language, the English dialect and two
// comma conventions before she has read a word of the book. The book answers
// all four itself, and no model is needed to read those answers: function-word
// frequency identifies the language, a curated spelling-pair list identifies
// the dialect, and the comma conventions are simply counted.
//
// The governing rule is that a wrong confident answer is much worse than an
// honest shrug. Every detector can return "unsure", the UI renders that as its
// own badge asking the author to decide, and the thresholds below are tuned so
// that a mixed or thin manuscript lands there rather than being guessed at.

import { DIALECT_EVIDENCE } from "./dialect.js";

// Re-exported so the settings detectors present one surface to callers and
// tests, while the word list stays next to the conversion table it filters.
export { DIALECT_EVIDENCE };

/**
 * A detector's answer. "unsure" is a real answer, not an absence — it means
 * Betty looked and could not tell, and the UI says so. A detector that does
 * not apply at all (Danish commas in an English novel) is omitted entirely.
 *
 * `support` / `against` / `sample` exist to fill the badge tooltip with real
 * evidence ("47 British spellings, 3 American"), so they are populated for
 * unsure answers too — "31 vs 24" is exactly why Betty could not decide.
 */
export type Detection<T> =
  | {
      status: "detected";
      value: T;
      support: number;
      against: number;
      sample: number;
    }
  | { status: "unsure"; support: number; against: number; sample: number };

export type ManuscriptLangCode = "en" | "da" | "de" | "es";

const detected = <T>(
  value: T,
  support: number,
  against: number,
  sample: number,
): Detection<T> => ({ status: "detected", value, support, against, sample });

const unsure = <T>(
  support: number,
  against: number,
  sample: number,
): Detection<T> => ({ status: "unsure", support, against, sample });

// ── Sampling ──
// Manuscripts run to hundreds of thousands of characters, and their front
// matter is the least representative part of them (title pages, epigraphs and
// acknowledgements are routinely in another language than the novel). Reading
// three slices spread through the book costs the same as reading the opening
// and is far harder to fool.

const SLICE_CHARS = 120_000;

function sampleText(md: string): string {
  if (md.length <= SLICE_CHARS * 3) return md;
  const slice = Math.floor(SLICE_CHARS);
  const mid = Math.floor(md.length / 2 - slice / 2);
  const end = md.length - slice;
  return `${md.slice(0, slice)}\n${md.slice(mid, mid + slice)}\n${md.slice(end)}`;
}

/** Lowercased word tokens. Unicode-aware, so Danish and German keep their letters. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\p{L}+/gu) ?? [];
}

// ── Language ──
//
// Function-word frequency, not dictionary lookup. Dictionaries would mean
// loading four Hunspell instances just to answer one question, and the
// function words of these four languages are near-disjoint anyway.
//
// The lists are curated for DISCRIMINATION, not for completeness. Words a
// neighbouring language shares are actively harmful here and are left out:
// Spanish loses "era" and "si" because Italian uses both heavily, which is the
// difference between correctly shrugging at an Italian manuscript and
// confidently mislabelling it Spanish.

const STOPWORDS: Record<ManuscriptLangCode, readonly string[]> = {
  en: [
    "the", "and", "of", "to", "in", "that", "it", "was", "he", "she",
    "for", "with", "his", "her", "as", "on", "but", "not", "they", "from",
    "this", "had", "were", "have", "been", "would", "could", "there", "their",
    "what", "when", "which", "who", "you", "him", "them", "then", "than",
    "into", "over", "after", "before", "about", "did", "does", "down", "out",
    "just", "only", "very", "some", "more", "any", "all", "one", "like",
  ],
  da: [
    "og", "det", "til", "som", "på", "ikke", "der", "var", "med", "han",
    "hun", "havde", "sig", "men", "har", "om", "vi", "min", "mig", "ham",
    "hende", "hans", "hendes", "være", "blev", "kunne", "ville", "skulle",
    "efter", "over", "under", "ind", "ud", "op", "ned", "igen", "nu", "da",
    "når", "hvor", "hvad", "hvem", "jeg", "du", "de", "denne", "dette",
    "noget", "nogen", "meget", "mere", "alle", "selv", "kun", "også", "eller",
  ],
  de: [
    "und", "der", "die", "das", "ist", "nicht", "ein", "eine", "zu", "den",
    "mit", "sich", "auf", "für", "von", "dem", "war", "als", "auch", "es",
    "an", "aber", "sie", "ich", "dass", "sein", "seine", "ihre", "ihr",
    "hatte", "haben", "wurde", "werden", "kann", "konnte", "wollte", "sollte",
    "nach", "über", "unter", "durch", "wieder", "noch", "nur", "schon",
    "immer", "dann", "wenn", "wie", "was", "wer", "wo", "diese", "dieser",
  ],
  es: [
    // "era" and "si" are deliberately absent: both are common Italian, and
    // including them turns an Italian manuscript into a confident "Spanish".
    "que", "de", "la", "el", "y", "en", "los", "las", "se", "no",
    "un", "una", "por", "con", "para", "es", "al", "lo", "como", "más",
    "pero", "su", "sus", "le", "les", "ya", "del", "me", "mi", "te",
    "ha", "han", "había", "muy", "todo", "toda", "cuando", "porque", "sin",
    "sobre", "hasta", "desde", "entre", "también", "donde", "quien", "ella",
    "ellos", "este", "esta", "eso", "esa", "ese", "aquí", "allí", "nada",
  ],
};

const LANG_CODES = Object.keys(STOPWORDS) as ManuscriptLangCode[];

const STOPWORD_SETS = new Map<ManuscriptLangCode, Set<string>>(
  LANG_CODES.map((code) => [code, new Set(STOPWORDS[code])]),
);

/** Below this, the text is front matter or a fragment — never enough to call. */
const LANG_MIN_TOKENS = 60;
/** Function words are 30-45% of real prose; well under that means no match. */
const LANG_MIN_SHARE = 0.18;
/** The winner must clear the runner-up by this factor to be trusted. */
const LANG_MIN_RATIO = 1.25;

/**
 * Identify the manuscript's language among the four Betty ships dictionaries
 * for. Returns "unsure" for anything else, which correctly leaves an author's
 * own "other" selection alone rather than forcing it into the nearest match.
 */
export function detectManuscriptLanguage(
  md: string,
): Detection<ManuscriptLangCode> {
  const tokens = tokenize(sampleText(md));
  const sample = tokens.length;
  if (sample < LANG_MIN_TOKENS) return unsure(0, 0, sample);

  const hits = new Map<ManuscriptLangCode, number>(
    LANG_CODES.map((code) => [code, 0]),
  );
  for (const token of tokens) {
    for (const code of LANG_CODES) {
      if (STOPWORD_SETS.get(code)!.has(token)) {
        hits.set(code, hits.get(code)! + 1);
      }
    }
  }

  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  const [winner, winnerHits] = ranked[0];
  const runnerUpHits = ranked[1]?.[1] ?? 0;

  const share = winnerHits / sample;
  // A runner-up of zero is a clean win, not a division by zero.
  const ratio = runnerUpHits === 0 ? Infinity : winnerHits / runnerUpHits;

  if (share < LANG_MIN_SHARE || ratio < LANG_MIN_RATIO) {
    return unsure(winnerHits, runnerUpHits, sample);
  }
  return detected(winner, winnerHits, runnerUpHits, sample);
}

// ── English dialect ──
//
// Counts the curated evidence subset (see DIALECT_EVIDENCE in dialect.ts for
// why it is a subset and not the whole conversion list). Whole-word and
// case-insensitive, so "Grey" counts exactly like "grey".

/** Total markers below this is one stray word, not a house style. */
const DIALECT_MIN_HITS = 6;
/** A manuscript this consistent has a dialect; anything flatter is mixed. */
const DIALECT_MIN_SHARE = 0.75;

// Built once. A word that is the British form of one pair and the American
// form of another proves nothing, so collisions are dropped from both sides.
const { britishForms, americanForms } = (() => {
  const british = new Set<string>();
  const american = new Set<string>();
  for (const pair of DIALECT_EVIDENCE) {
    british.add(pair.br.toLowerCase());
    american.add(pair.us.toLowerCase());
  }
  for (const word of [...british]) {
    if (american.has(word)) {
      british.delete(word);
      american.delete(word);
    }
  }
  return { britishForms: british, americanForms: american };
})();

/**
 * Read the manuscript's English dialect off its spelling. Returns "unsure"
 * for prose with too few markers to judge and for genuinely mixed
 * manuscripts — the case dialect.ts exists to clean up, where the honest
 * answer is to ask the author which way the book should go.
 */
export function detectEnglishDialect(
  md: string,
): Detection<"american" | "british"> {
  let british = 0;
  let american = 0;
  for (const token of tokenize(sampleText(md))) {
    if (britishForms.has(token)) british++;
    else if (americanForms.has(token)) american++;
  }

  const total = british + american;
  const support = Math.max(british, american);
  const against = Math.min(british, american);
  if (total < DIALECT_MIN_HITS) return unsure(support, against, total);
  if (support / total < DIALECT_MIN_SHARE) return unsure(support, against, total);

  return detected(british > american ? "british" : "american", support, against, total);
}

// ── Oxford comma ──
//
// Finding commas is trivial; deciding what is a LIST is the whole problem.
// The confounder is the compound clause — "He ate, and then he left" places a
// comma before "and" while listing nothing — and it is dangerous because it
// biases toward Oxford style in manuscripts that have none.
//
// The guard falls out of the structure rather than being bolted on. Split the
// clause before the conjunction on commas: a genuine three-item list leaves at
// least two items behind ("bread" / "cheese"), while a compound clause leaves
// exactly one ("He ate"). Requiring two items discards every such clause.
//
// Residual noise is honest and bounded: "She went to the store, bought milk
// and came home" still reads as a non-Oxford list. It is diluted by requiring
// eight candidates and an 80% majority, and when it does bite, the answer
// degrades to "unsure" rather than to a confident wrong one.

const OXFORD_MIN_LISTS = 8;
const OXFORD_MIN_SHARE = 0.8;
/** The first segment carries the sentence stem ("The room held a bed"), so it
 *  gets a looser budget than the items that follow it. */
const OXFORD_FIRST_ITEM_MAX_WORDS = 10;
const OXFORD_ITEM_MAX_WORDS = 4;

const CLAUSE_BREAKS = new Set([".", "!", "?", ";", ":", "\n"]);

/**
 * Collapse soft wrapping so a clause is not cut in half by it. Manuscripts
 * arrive hard-wrapped as often as not, and a newline inside a paragraph is
 * typography, not punctuation — left alone it severs "There was dust,\n
 * silence, and the smell of tar" into two fragments, and the list vanishes.
 * Paragraph breaks survive as a single newline, which IS a real boundary.
 */
function flattenParagraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Start of the clause containing `index` — just past the previous break. */
function clauseStart(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    if (CLAUSE_BREAKS.has(text[i])) return i + 1;
  }
  return 0;
}

/** The list item following the conjunction, up to the next break or comma. */
function itemAfter(text: string, from: number): string {
  let i = from;
  while (i < text.length && !CLAUSE_BREAKS.has(text[i]) && text[i] !== ",") i++;
  return text.slice(from, i);
}

/**
 * Read the manuscript's serial-comma convention off its lists. True means the
 * author writes "bread, cheese, and apples".
 */
export function detectOxfordComma(md: string): Detection<boolean> {
  const text = flattenParagraphs(sampleText(md));
  let withComma = 0;
  let withoutComma = 0;

  for (const match of text.matchAll(/\b(?:and|or)\b/gi)) {
    const at = match.index!;
    const pre = text.slice(clauseStart(text, at), at);
    const segments = pre.split(",");
    // No comma in the clause at all — not a list under either convention.
    if (segments.length < 2) continue;

    const trailing = segments[segments.length - 1].trim();
    const oxford = trailing === "";
    const items = oxford ? segments.slice(0, -1) : segments;
    // One item means a compound clause ("He ate, and then he left"), not a list.
    if (items.length < 2) continue;

    const after = itemAfter(text, at + match[0].length);
    if (wordCount(after) < 1 || wordCount(after) > OXFORD_ITEM_MAX_WORDS) continue;

    const shapedLikeAList = items.every((item, i) => {
      const words = wordCount(item);
      const budget = i === 0 ? OXFORD_FIRST_ITEM_MAX_WORDS : OXFORD_ITEM_MAX_WORDS;
      return words >= 1 && words <= budget;
    });
    if (!shapedLikeAList) continue;

    if (oxford) withComma++;
    else withoutComma++;
  }

  const total = withComma + withoutComma;
  const support = Math.max(withComma, withoutComma);
  const against = Math.min(withComma, withoutComma);
  if (total < OXFORD_MIN_LISTS) return unsure(support, against, total);
  if (support / total < OXFORD_MIN_SHARE) return unsure(support, against, total);

  return detected(withComma > withoutComma, support, against, total);
}

// ── Introductory comma ──
//
// Measured only on openers where the comma is genuinely OPTIONAL, which is
// what the setting controls. Connectives that take a comma under every house
// style — however, nevertheless, therefore, moreover — are deliberately absent
// from this list: counting them would measure English rather than the author,
// and would swamp the handful of openers that do reflect a choice.
//
// Prepositional openers ("In the morning, she left") are a real part of the
// convention and are not counted, because recognising the end of the phrase
// needs more parsing than this module does. Adverb openers are plentiful in
// fiction, so the sample holds up without them.

const INTRO_ADVERBS = new Set([
  // manner
  "suddenly", "slowly", "quickly", "quietly", "carefully", "gently", "softly",
  "silently", "abruptly", "gradually", "reluctantly", "calmly", "sharply",
  // time
  "finally", "eventually", "presently", "immediately", "briefly", "later",
  "soon", "afterwards", "afterward", "meanwhile", "tonight", "today",
  "tomorrow", "yesterday",
  // place
  "outside", "inside", "upstairs", "downstairs", "nearby", "elsewhere",
  "overhead", "behind",
]);

const INTRO_MIN_OPENERS = 10;
const INTRO_MIN_SHARE = 0.75;

/**
 * Read the manuscript's habit with the optional comma after an introductory
 * adverb. True means the author writes "Finally, she looked up".
 */
export function detectIntroductoryComma(md: string): Detection<boolean> {
  const text = flattenParagraphs(sampleText(md));
  let withComma = 0;
  let withoutComma = 0;

  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    // Dialogue and quoted openings start behind punctuation; step past it.
    const body = sentence.replace(/^[\s"'“”‘’\-—–*_>]+/, "");
    const opener = /^([A-Za-z]+)(,?)\s+\S/.exec(body);
    if (!opener) continue;
    if (!INTRO_ADVERBS.has(opener[1].toLowerCase())) continue;
    if (opener[2] === ",") withComma++;
    else withoutComma++;
  }

  const total = withComma + withoutComma;
  const support = Math.max(withComma, withoutComma);
  const against = Math.min(withComma, withoutComma);
  if (total < INTRO_MIN_OPENERS) return unsure(support, against, total);
  if (support / total < INTRO_MIN_SHARE) return unsure(support, against, total);

  return detected(withComma > withoutComma, support, against, total);
}

// ── Danish comma ──
//
// Grammatisk komma sets a comma before a subordinate clause; nyt komma does
// not. Both are correct, Retskrivningsordbogen sanctions each, and which one a
// manuscript follows is the author's decision — so this detector exists to
// read that decision, never to impose one.
//
// Two restrictions carry the precision:
//
//  1. **"at" only when a pronoun follows it.** Danish "at" is both the
//     conjunction ("hun vidste, at han kom") and the infinitive marker ("hun
//     begyndte at løbe"). The infinitive is much the commoner of the two and
//     never takes a comma, so counting it would report nyt komma for every
//     Danish manuscript. A following pronoun is a cheap, sharp separator: the
//     infinitive marker is followed by a verb, never by "han" or "det".
//
//  2. **Sentence-initial subordinators are skipped.** A clause that opens the
//     sentence takes its comma at the END under both systems, so it carries no
//     information either way.
//
// "som" and "der" are left out entirely. Both are frequent subordinators and
// both are frequent as something else ("som" comparative, "der" expletive),
// and no cheap test separates the readings.

const DANISH_SUBORDINATORS = new Set([
  "fordi", "hvis", "mens", "når", "selvom", "eftersom", "medmindre",
  "indtil", "inden", "hvorfor", "hvornår", "hvordan", "hvorvidt", "skønt",
]);

/** After "at", these mark the conjunction reading rather than the infinitive. */
const DANISH_PRONOUNS = new Set([
  "han", "hun", "det", "den", "de", "jeg", "du", "vi", "man", "der",
  "dette", "denne", "hans", "hendes", "deres", "vores", "min", "mit",
]);

const DANISH_MIN_CLAUSES = 12;
const DANISH_MIN_SHARE = 0.7;

/**
 * Read which Danish comma system the manuscript follows. Returns "unsure" for
 * a manuscript that mixes them, which is common and which the author should
 * settle rather than Betty.
 */
export function detectDanishComma(md: string): Detection<"grammatisk" | "nyt"> {
  // "selv om" is the same conjunction spelled open; fold it so one lookup does.
  const text = flattenParagraphs(sampleText(md)).replace(/\bselv om\b/gi, "selvom");

  let withComma = 0;
  let withoutComma = 0;

  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    for (const match of sentence.matchAll(/\b(\p{L}+)\b/gu)) {
      const word = match[1].toLowerCase();
      const at = match.index!;
      // Sentence-initial clauses take their comma at the far end under both
      // systems — no information here.
      if (at === 0) continue;

      let isSubordinator = DANISH_SUBORDINATORS.has(word);
      if (word === "at") {
        const rest = sentence.slice(at + match[1].length);
        const next = /^\s+(\p{L}+)/u.exec(rest);
        isSubordinator = !!next && DANISH_PRONOUNS.has(next[1].toLowerCase());
      }
      if (!isSubordinator) continue;

      const before = sentence.slice(0, at).trimEnd();
      if (before.endsWith(",")) withComma++;
      else withoutComma++;
    }
  }

  const total = withComma + withoutComma;
  const support = Math.max(withComma, withoutComma);
  const against = Math.min(withComma, withoutComma);
  if (total < DANISH_MIN_CLAUSES) return unsure(support, against, total);
  if (support / total < DANISH_MIN_SHARE) return unsure(support, against, total);

  return detected(withComma > withoutComma ? "grammatisk" : "nyt", support, against, total);
}

// ── The whole pass ──

/**
 * What Betty could read off the manuscript. A key is present when the question
 * applies to this manuscript and Betty looked at it — its Detection then says
 * whether she could answer. A key is ABSENT when the question does not apply
 * at all, which is how the UI knows to render no badge rather than an unsure
 * one: Danish comma systems are not a question an English novel can answer.
 */
export interface DetectedSettings {
  manuscriptLang?: Detection<ManuscriptLangCode>;
  englishDialect?: Detection<"american" | "british">;
  oxfordComma?: Detection<boolean>;
  introductoryComma?: Detection<boolean>;
  danishComma?: Detection<"grammatisk" | "nyt">;
}

/**
 * Read every setting the manuscript can answer for itself. Cheap enough to run
 * inline in the upload request — a few linear scans over at most three slices
 * of the text, no dictionaries loaded and no model consulted.
 *
 * Language is resolved first and gates the rest: the dialect and English comma
 * conventions are only meaningful once the book is known to be English, and
 * running them over a manuscript whose language could not be placed would be
 * inventing evidence rather than reading it.
 */
export function detectSettings(md: string): DetectedSettings {
  const manuscriptLang = detectManuscriptLanguage(md);
  const found: DetectedSettings = { manuscriptLang };
  if (manuscriptLang.status !== "detected") return found;

  if (manuscriptLang.value === "en") {
    found.englishDialect = detectEnglishDialect(md);
    found.oxfordComma = detectOxfordComma(md);
    found.introductoryComma = detectIntroductoryComma(md);
  }
  if (manuscriptLang.value === "da") {
    found.danishComma = detectDanishComma(md);
  }
  return found;
}
