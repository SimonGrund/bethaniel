// ── House-style questions before an edit ──
//
// Where the manuscript disagrees with itself, the copy editor has to guess
// which form is the author's, and a wrong guess is a whole class of wrong
// suggestions the author then dismisses one by one. So before an edit Betty
// asks: grey or gray, e-mail or email, ten or 10, which dash. The answers go
// into the style guide (frontend houseStyleAnswers.ts), and the edit follows
// them from then on.
//
// Counted from the text, no model: instant, free, local or cloud. Settings
// detection could not decide (dialect, commas, quotes) are asked by the
// frontend from the document's own detection; this file is the
// consistency questions.

export type HouseStyleKind = "spelling" | "compound" | "numbers" | "dashes";

export interface HouseStyleQuestion {
  /** Stable across runs: the same conflict has the same id. */
  id: string;
  kind: HouseStyleKind;
  /** Every form the text uses, most used first. For numbers the forms are
   *  "words" and "digits"; for dashes "spaced-en", "closed-em", "spaced-em". */
  forms: { form: string; count: number }[];
}

/** British / American. Curated from consistency.ts's pairs: practise/practice
 *  and licence/license are left out — in British English they are verb and
 *  noun, both correct, and asking would invent a conflict. */
const SPELLING_PAIRS: [string, string][] = [
  ["grey", "gray"],
  ["colour", "color"],
  ["favour", "favor"],
  ["honour", "honor"],
  ["centre", "center"],
  ["theatre", "theater"],
  ["realise", "realize"],
  ["recognise", "recognize"],
  ["organisation", "organization"],
  ["travelled", "traveled"],
  ["travelling", "traveling"],
  ["cancelled", "canceled"],
  ["modelling", "modeling"],
  ["defence", "defense"],
  ["offence", "offense"],
  ["aluminium", "aluminum"],
  ["ok", "okay"],
];

/** Number words under a hundred. Articles that double as "one" (en, et, ein,
 *  uno, un) and English "one" (as in "one of them") are left out. */
const NUMBER_WORDS: Record<string, string[]> = {
  en: "two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety".split(" "),
  da: "to tre fire fem seks syv otte ni ti elleve tolv tretten fjorten femten seksten sytten atten nitten tyve tredive fyrre halvtreds tres halvfjerds firs halvfems".split(" "),
  de: "zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn zwanzig dreißig vierzig fünfzig sechzig siebzig achtzig neunzig".split(" "),
  es: "dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve veinte treinta cuarenta cincuenta sesenta setenta ochenta noventa".split(" "),
  fr: "deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize vingt trente quarante cinquante soixante".split(" "),
};

/** A digit after one of these is a reference, not a quantity: "chapter 3". */
const REFERENCE_WORDS = /(?:chapter|page|part|kapitel|side|del|seite|teil|capítulo|página|parte|chapitre|partie|nr|no)\.?\s*$/i;

/** A style guide that already speaks to the topic settles it. */
const NUMBERS_TOPIC = /\b(?:numbers?|numerals?|digits?|tal|talord|zahlen?|ziffern?|n[uú]meros?|cifras?|nombres?|chiffres?)\b/i;
const DASHES_TOPIC = /\b(?:dash(?:es)?|tankestreg\w*|gedankenstrich\w*|raya\w*|tiret\w*)\b|[–—]/i;

const MIN_TOTAL = 3;
const MAX_QUESTIONS = 5;

function baseLang(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive uses of `form` (spaces in it match any run of whitespace). */
function countForm(text: string, form: string): number {
  const pattern = form.split(/\s+/).map(escapeRe).join("\\s+");
  return (text.match(new RegExp(`(?<![\\p{L}\\p{N}-])${pattern}(?![\\p{L}\\p{N}-])`, "giu")) ?? []).length;
}

function mentions(guide: string, form: string): boolean {
  return countForm(guide, form) > 0;
}

function byCount(forms: { form: string; count: number }[]) {
  return forms.filter((f) => f.count > 0).sort((a, b) => b.count - a.count);
}

function spelling(text: string, guide: string): HouseStyleQuestion[] {
  const out: HouseStyleQuestion[] = [];
  for (const [a, b] of SPELLING_PAIRS) {
    const forms = byCount([
      { form: a, count: countForm(text, a) },
      { form: b, count: countForm(text, b) },
    ]);
    if (forms.length < 2 || forms[0].count + forms[1].count < MIN_TOTAL) continue;
    if (mentions(guide, a) || mentions(guide, b)) continue;
    out.push({ id: `spelling:${a}|${b}`, kind: "spelling", forms });
  }
  return out;
}

function compounds(text: string, guide: string): HouseStyleQuestion[] {
  const out: HouseStyleQuestion[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?<![\p{L}-])(\p{L}+)-(\p{L}+)(?![\p{L}-])/gu)) {
    const [left, right] = [m[1].toLowerCase(), m[2].toLowerCase()];
    const key = left + right;
    if (seen.has(key)) continue;
    seen.add(key);
    const hyphen = `${left}-${right}`;
    const forms = byCount([
      { form: hyphen, count: countForm(text, hyphen) },
      { form: key, count: countForm(text, key) },
      { form: `${left} ${right}`, count: countForm(text, `${left} ${right}`) },
    ]);
    const total = forms.reduce((n, f) => n + f.count, 0);
    if (forms.length < 2 || total < MIN_TOTAL) continue;
    if (forms.some((f) => mentions(guide, f.form))) continue;
    out.push({ id: `compound:${key}`, kind: "compound", forms });
  }
  return out;
}

function numbers(text: string, lang: string, guide: string): HouseStyleQuestion[] {
  const list = NUMBER_WORDS[baseLang(lang)];
  if (!list || NUMBERS_TOPIC.test(guide)) return [];
  let words = 0;
  for (const w of list) words += countForm(text, w);
  let digits = 0;
  // One or two digits standing alone: not part of a decimal, a time, a
  // percentage, a range or a longer number, and not a reference.
  for (const m of text.matchAll(/(?<![\d.,:/–-])\b\d{1,2}\b(?![\d.,:/%–-]|\s?%|\s?(?:per\s?cent|procent|prozent|por\s?ciento|pour\s?cent))/giu)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 16), m.index);
    if (REFERENCE_WORDS.test(before)) continue;
    digits++;
  }
  if (words < MIN_TOTAL || digits < MIN_TOTAL) return [];
  return [{ id: "numbers", kind: "numbers", forms: byCount([{ form: "words", count: words }, { form: "digits", count: digits }]) }];
}

function dashes(text: string, guide: string): HouseStyleQuestion[] {
  if (DASHES_TOPIC.test(guide)) return [];
  const forms = byCount([
    { form: "spaced-en", count: (text.match(/ – /g) ?? []).length },
    { form: "closed-em", count: (text.match(/[^\s—]—[^\s—]/g) ?? []).length },
    { form: "spaced-em", count: (text.match(/ — /g) ?? []).length },
  ]).filter((f) => f.count >= 2);
  if (forms.length < 2) return [];
  return [{ id: "dashes", kind: "dashes", forms }];
}

/**
 * The questions for one edit: every conflict the text holds that the style
 * guide does not already settle, the most frequent first, at most five.
 */
/**
 * The author's prose only. Picture descriptions are not the author's words —
 * "in a simple cartoon style", eleven times over on a real book, became a
 * question — internal links are the contents page, and a number ending a
 * line is a page number ("Sætte rammen<TAB>72").
 */
function prose(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\(#[^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\t ]+\d{1,3}[\t ]*$/gm, "");
}

export function houseStyleQuestions(rawText: string, lang: string, styleGuide: string): HouseStyleQuestion[] {
  const text = prose(rawText);
  const guide = styleGuide ?? "";
  const all = [
    ...(baseLang(lang) === "en" ? spelling(text, guide) : []),
    ...compounds(text, guide),
    ...numbers(text, lang, guide),
    ...dashes(text, guide),
  ];
  const total = (q: HouseStyleQuestion) => q.forms.reduce((n, f) => n + f.count, 0);
  return all.sort((a, b) => total(b) - total(a)).slice(0, MAX_QUESTIONS);
}
