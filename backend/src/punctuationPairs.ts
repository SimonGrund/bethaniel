// ── Two punctuation marks side by side ──
//
// ".,", ",,", "?.", ".?" — a mark typed over another, or one an edit left
// behind. An author found one in a finished book by chance: nothing else
// looks for them. The model reads straight past a stray comma, the grammar
// checker's rules for it are patchy, and the dictionary sees only words.
//
// "Never right" has exceptions, and they are the whole of this file:
//   - an ellipsis is three dots, spaced or not, and "...?", ". . .?" or
//     "...." is ordinary company for it — a run of three or more dots is
//     not a pair;
//   - "?!", "!?", "!!" and "??" are conventions, loud but deliberate;
//   - an abbreviation's full stop may meet the sentence's own mark: "etc.,",
//     "5 p.m.?", "the U.S.;", "f.eks.,". Never a second full stop, though —
//     "etc.." is still a typo;
//   - an ordinal is a number with a full stop in Danish and German, so
//     "den 3., 4. og 5. maj" is correct;
//   - Spanish follows a closing ? or ! with a comma, semicolon or colon when
//     the sentence goes on: "¿Vienes?, preguntó";
//   - marks standing on their own between spaces are symbols — a songbook's
//     ":,:" repeat sign — and marks between two letters ("sle..s") are an
//     import's noise, not anything an author typed;
//   - "![" opens a Markdown image.
//
// Measured over the 41 distinct manuscripts and corpus texts on the
// author's machine (1.65 million words). With pairs alone: 487 hits, nearly
// all from a badly OCR'd book, a Danish songbook's repeat signs and old
// abbreviations. With the exceptions: 221, of which 194 sit in two texts no
// author will submit — the OCR'd book ("a.." for "all", 138) and a
// 17th-century diary abbreviating every title (56). Of the rest, every hit
// in a modern manuscript is real: ".,” she said" four times and ".!”" once
// in one novel, "f.Kr.." in Danish Wikipedia.
//
// Used twice: the publication scan reports each one, and the copy edit and
// readthrough offer the fix.

import type { Correction } from "./types.js";
import { widenToWords } from "./retextChecks.js";

const MARKS = new Set([".", ",", ";", ":", "!", "?"]);
const LOUD = new Set(["!", "?"]);

// Abbreviations that end in a full stop and can stand before a comma or a
// question mark. One list for every language: a Danish book quoting "etc."
// is no reason to report it, and no entry here is also a common word that
// ends sentences. Recognised without a list: anything with an internal full
// stop (e.g., a.m., bl.a., z.B.), a single letter (an initial), a word with
// no vowel at all (Rdr., Mt., vgl., bzw. — no word of prose lacks one), and a
// Roman numeral (Ludvig XIV., a king's number).
const ABBREVIATIONS = new Set([
  // English
  "mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "etc", "vs", "approx",
  "dept", "inc", "ltd", "co", "corp", "vol", "fig", "ft", "no", "nos",
  "al", "cf", "ed", "eds", "pp", "ibid", "viz", "resp",
  // Danish
  "hr", "fr", "osv", "mv", "ca", "nr", "kl", "jf", "evt", "inkl", "ekskl",
  "pga", "dvs", "mht", "vedr", "bl", "tlf", "anm", "mel", "flg", "eks",
  "tdr", "jvf", "kap", "sp",
  // German
  "usw", "bzw", "vgl", "ggf", "evtl", "zzgl", "str", "tel", "bspw", "hrsg",
  "bd", "ff",
  // Spanish
  "sra", "srta", "dra", "ud", "uds", "pág", "núm", "aprox",
  // Months, in every language above
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
  "okt", "nov", "dec", "dez", "dic", "ene", "novbr", "decbr", "septbr",
]);

export interface PunctuationPair {
  /** Where the marks start, in the text searched. */
  start: number;
  /** The marks themselves: ".,", ",,,". */
  marks: string;
  /** What they should be, and whether that is certain enough to apply
   *  without a reviewer's second look. */
  fix: string;
  certain: boolean;
}

/** The word a full stop at `dot` ends: "etc", "p.m", "3", "J". */
function wordBefore(text: string, dot: number): string {
  let s = dot;
  while (s > 0 && /[\p{L}\p{N}.]/u.test(text[s - 1])) s--;
  return text.slice(s, dot);
}

function endsAbbreviation(text: string, dot: number): boolean {
  const w = wordBefore(text, dot);
  if (!w) return false;
  if (/\p{N}$/u.test(w)) return true; // an ordinal: 3.
  if (w.includes(".")) return true; // e.g., a.m., U.S., f.eks.
  if (/^\p{L}$/u.test(w)) return true; // an initial: J.
  if (!/[aeiouyæøåäöüéèêáíóúàìòùâîôû]/i.test(w)) return true; // Rdr., vgl.
  if (/^[IVXLCDM]+$/.test(w)) return true; // XIV.
  return ABBREVIATIONS.has(w.toLowerCase());
}

/** Whether marks a and b, side by side, are one of the correct pairings. */
function allowedPair(
  text: string,
  a: string,
  b: string,
  aAt: number,
  aStartsRun: boolean,
  lang: string,
): boolean {
  if (LOUD.has(a) && LOUD.has(b)) return true;
  // The last full stop of a spaced ellipsis: ". . .?"
  if (a === "." && aStartsRun && text[aAt - 1] === " " && text[aAt - 2] === ".") return true;
  if (b === "!" && text[aAt + 2] === "[") return true;
  if (a === "." && b !== "." && aStartsRun && endsAbbreviation(text, aAt)) return true;
  if (lang === "es" && LOUD.has(a) && (b === "," || b === ";" || b === ":")) return true;
  return false;
}

/** Whether nothing but closing quotes and brackets follow before the
 *  paragraph ends. */
function endsParagraph(text: string, from: number): boolean {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\n") return true;
    if (!/[ \t”’"'»)\]]/.test(text[i])) return false;
  }
  return true;
}

function fixFor(marks: string, atParagraphEnd: boolean): { fix: string; certain: boolean } {
  const loud = [...marks].filter((m) => LOUD.has(m)).join("");
  // A question or an exclamation is the stronger mark and says the most:
  // "?." and ".?" both meant "?".
  if (loud) return { fix: loud, certain: true };
  if (new Set(marks).size === 1) {
    // ",," is a comma. ".." is as often a short ellipsis as a doubled stop,
    // so it is offered rather than applied.
    return { fix: marks[0], certain: marks[0] !== "." };
  }
  // Mixed: the mark typed last is kept. It is the correction the author
  // meant and did not finish — measured on a real novel, every ".,”" was
  // dialogue running on into its tag, "to us.,” Akamu barked" included,
  // where reading the capital after it would have ended the sentence. At
  // the end of a paragraph the sentence has ended whatever was typed.
  if (atParagraphEnd) return { fix: ".", certain: false };
  return { fix: marks[marks.length - 1], certain: false };
}

export function findPunctuationPairs(text: string, lang?: string): PunctuationPair[] {
  const language = (lang ?? "en").toLowerCase().slice(0, 2);
  const out: PunctuationPair[] = [];
  let i = 0;
  while (i < text.length) {
    if (!MARKS.has(text[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && MARKS.has(text[j])) j++;
    // On its own between spaces: a symbol ("Kande, ,: tøm", a repeat sign).
    // Between two letters or digits: part of a token, not punctuation.
    const before = text[i - 1];
    const after = text[j];
    const space = (c: string | undefined) => c === undefined || /\s/.test(c);
    const alnum = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
    if ((space(before) && space(after)) || (alnum(before) && alnum(after))) {
      i = j;
      continue;
    }
    // The run [i, j), split at any ellipsis inside it.
    let k = i;
    while (k < j) {
      let dots = k;
      while (dots < j && text[dots] === ".") dots++;
      if (dots - k >= 3) {
        k = dots;
        continue;
      }
      let end = k;
      while (end < j) {
        let d = end;
        while (d < j && text[d] === ".") d++;
        if (d - end >= 3) break;
        end = d > end ? d : end + 1;
      }
      // [k, end) is a stretch of marks with no ellipsis in it.
      let wrong = false;
      for (let p = k; p + 1 < end; p++) {
        if (!allowedPair(text, text[p], text[p + 1], p, p === k, language)) {
          wrong = true;
          break;
        }
      }
      if (wrong) {
        const marks = text.slice(k, end);
        out.push({ start: k, marks, ...fixFor(marks, endsParagraph(text, end)) });
      }
      k = end;
    }
    i = j;
  }
  return out;
}

/** The copy edit's fix: one correction per pair, anchored to the words
 *  either side so it can be found again (the reason retext widens too). */
export function getPunctuationPairCorrections(text: string, lang?: string): Correction[] {
  const out: Correction[] = [];
  const seen = new Set<string>();
  for (const pair of findPunctuationPairs(text, lang)) {
    const end = pair.start + pair.marks.length;
    const [s, e] = widenToWords(text, pair.start, end);
    const original = text.slice(s, e);
    const corrected = text.slice(s, pair.start) + pair.fix + text.slice(end, e);
    const key = `${original}\u0000${corrected}`;
    if (original === corrected || seen.has(key)) continue;
    seen.add(key);
    out.push({
      original,
      corrected,
      reason: "punctuation-pair",
      kind: "copy",
      ...(pair.certain ? { confidence: 1, preApproved: true } : {}),
    } as Correction);
  }
  return out;
}

/** A readable stretch around a pair, for the scan's report. */
export function pairExcerpt(text: string, pair: PunctuationPair, radius = 50): string {
  let s = Math.max(0, pair.start - radius);
  let e = Math.min(text.length, pair.start + pair.marks.length + radius);
  if (s > 0) s = text.indexOf(" ", s) + 1 || s;
  if (e < text.length) e = text.lastIndexOf(" ", e) > pair.start ? text.lastIndexOf(" ", e) : e;
  const body = text.slice(s, e).replace(/\s+/g, " ").trim();
  return `${s > 0 ? "…" : ""}${body}${e < text.length ? "…" : ""}`;
}
