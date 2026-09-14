// ── English dialect evidence ──
//
// What a manuscript's English is, read off the manuscript. Shared by the
// upload-time detection (detectSettings.ts) and the consistency check the
// publication scan and the proofread pass run (dialect.ts), so the two cannot
// disagree about what counts.
//
// The first version counted the conversion pairs — colour/color, centre/
// center — as raw token totals. Measured on twelve public-domain novels it
// called every American one "unsure", and the reasons are the design of this
// file:
//
//  - The -ward(s) family is not evidence. "towards" and "afterwards" are
//    ordinary American prose (Twain: 54 "towards", not one "toward"; Melville:
//    115), and they were the most frequent words on the list, so they
//    outvoted every real spelling. Safe to CONVERT toward a chosen dialect;
//    useless for telling which one. Gone.
//  - A name is not evidence. "Gray" gave Dorian Gray 204 American votes. A
//    capitalised token mid-sentence is a name here and is skipped.
//  - One habit is not evidence. Raw totals let a single word decide a book.
//    Each distinct marker now counts at most MARKER_CAP times, weighted by
//    how much it proves, so the verdict rests on how many DIFFERENT
//    dialect-specific things the author does.
//  - The strongest markers were missing. No American writes "realise",
//    "whilst", "learnt", "mum", "programme" or "tyre"; no British author
//    writes "gotten", "mom", "math" or "airplane". And a modern British
//    house style writes "Mr Darcy" where an American one writes "Mr. Darcy",
//    on every page. The -ise/-ize family is asymmetric: -ise proves British,
//    -ize only leans American, because Oxford spelling is British and writes
//    "realize".

import { isSentenceInitial } from "./spellcheck.js";
import { DIALECT_PAIRS } from "./dialect.js";

export type Weight = 1 | 2 | 3;

/** One reading of the text: what pointed which way, and how firmly. */
export interface DialectEvidence {
  /** Capped, weighted — the basis of a verdict. */
  britishWeight: number;
  americanWeight: number;
  /** Raw hits of the spelling markers only — for "N words use British
   *  spelling" in a consistency report, where every occurrence matters. */
  britishHits: number;
  americanHits: number;
  /** marker → raw hits, for explaining a verdict. */
  britishMarkers: Map<string, number>;
  americanMarkers: Map<string, number>;
}

/** A marker's hits beyond this count for nothing more. */
export const MARKER_CAP = 4;

// ── One-sided vocabulary ──
// Words that exist in one dialect and not the other, with how much each
// proves: 3 for a word the other dialect never writes, 2 for one it writes
// rarely, 1 for a lean. Each side deliberately leaves out words the other
// dialect uses in another sense ("check", "practice", "story", "curb",
// "pants", "fall", "trunk") — a marker that can be innocent is worse than
// no marker.
const BRITISH_WORDS: Record<string, Weight> = {
  // Twain wrote "whilst", "amongst" and "keep mum"; a modern American does
  // not, but the older voice is common enough in fiction to keep these
  // below the words no American has ever written.
  whilst: 2, amongst: 1,
  learnt: 3, spelt: 3, spoilt: 3, leant: 3, dreamt: 2,
  mum: 2, mummy: 2, mums: 3,
  programme: 3, programmes: 3,
  tyre: 3, tyres: 3, kerb: 3, kerbs: 3,
  cheque: 3, cheques: 3, chequebook: 3,
  practise: 3, practised: 3, practising: 3,
  licence: 3, licences: 3,
  metre: 3, metres: 3, kilometre: 3, kilometres: 3, centimetre: 3, centimetres: 3,
  storey: 3, storeys: 3, gaol: 3,
  aeroplane: 3, aeroplanes: 3,
  lorry: 3, lorries: 3, petrol: 3,
  maths: 3, arse: 3,
  fortnight: 2, rubbish: 2, trousers: 2, pavement: 1, biscuit: 1, biscuits: 1,
  autumn: 1, queue: 1, queued: 1,
  catalogue: 2, catalogues: 2, draught: 2, draughts: 2,
  grey: 1, greys: 1, greyer: 1,
};

const AMERICAN_WORDS: Record<string, Weight> = {
  gotten: 3,
  mom: 3, mommy: 2, moms: 3,
  math: 3,
  airplane: 3, airplanes: 3,
  railroad: 3, railroads: 3,
  sidewalk: 3, sidewalks: 3,
  flashlight: 3, flashlights: 3,
  faucet: 3, faucets: 3,
  diaper: 3, diapers: 3, pacifier: 3,
  afterward: 2,
  license: 2, licenses: 2,
  elevator: 2, elevators: 2,
  vacation: 2, vacations: 2,
  trash: 2, garbage: 2,
  candy: 2, cookie: 1, cookies: 1,
  soccer: 2, freshman: 2, sophomore: 3,
  apartment: 1, apartments: 1, closet: 1, sweater: 1, truck: 1, trucks: 1, movie: 1, movies: 1,
  catalog: 2, catalogs: 2,
  gray: 1, grays: 1, grayer: 1,
};

// ── Spelling pairs ──
// Built once, lazily, from the conversion list. Lazy because dialect.ts
// imports this file for its own detector while this file imports dialect.ts's
// table: with the cycle, whichever loads second sees the other's bindings
// uninitialised until both have finished, so nothing may read DIALECT_PAIRS
// at module level.
interface SpellingTables {
  british: Map<string, Weight>;
  american: Map<string, Weight>;
  /** Forms that lean a way without being a spelling on the wrong side:
   *  the -ize half of the family. A consistency report must not tell an
   *  Oxford-spelling author to fix "realize", so these never count as hits. */
  leanOnly: Set<string>;
}
let spelling: SpellingTables | null = null;

/** Not evidence, whatever the conversion list says. */
const NOT_EVIDENCE = /^(?:towards?|afterwards?|forwards?|backwards?|upwards?|downwards?|onwards?|inwards?|outwards?|homewards?|eastwards?|westwards?|northwards?|southwards?)$/;

function spellingTables(): SpellingTables {
  if (spelling) return spelling;
  const british = new Map<string, Weight>();
  const american = new Map<string, Weight>();
  const leanOnly = new Set<string>();
  for (const pair of DIALECT_PAIRS) {
    const br = pair.br.toLowerCase();
    const us = pair.us.toLowerCase();
    if (br.includes(" ") || us.includes(" ") || br.includes("-") || us.includes("-")) continue;
    if (NOT_EVIDENCE.test(br) || NOT_EVIDENCE.test(us)) continue;
    // The -ise/-ize family: Oxford spelling means -ize is only a lean, but
    // -ise is never American.
    const izeForm = br
      .replace(/isation(s?)$/, "ization$1")
      .replace(/is(e|es|ed|er|ers|ing)$/, "iz$1");
    if (izeForm === us) {
      british.set(br, 3);
      american.set(us, 1);
      leanOnly.add(us);
      continue;
    }
    // Flagged ambiguous in a direction: the ambiguous side is not evidence,
    // the other side still is ("tyre" proves British; "tire" proves nothing).
    if (pair.toUs !== false) british.set(br, 2);
    if (pair.toBr !== false) american.set(us, 2);
  }
  // A word that is the British form of one pair and the American form of
  // another proves nothing.
  for (const w of [...british.keys()]) {
    if (american.has(w)) {
      british.delete(w);
      american.delete(w);
    }
  }
  // Colour words are weak on their own: "grey" was common American spelling
  // into the twentieth century.
  for (const w of ["grey", "greys", "greyed", "greyish"]) if (british.has(w)) british.set(w, 1);
  for (const w of ["gray", "grays", "grayed", "grayish"]) if (american.has(w)) american.set(w, 1);
  spelling = { british, american, leanOnly };
  return spelling;
}

// ── Punctuation ──
// Modern British house style writes "Mr Darcy"; American style "Mr. Darcy".
// Nineteenth-century British texts used the period too, so this is a
// medium signal, not a strong one. Dialogue in single quotes leans British.
const TITLE_PERIOD_RE = /\b(?:Mr|Mrs|Ms|Dr)\.\s+\p{Lu}/gu;
const TITLE_BARE_RE = /\b(?:Mr|Mrs|Ms|Dr)\s+\p{Lu}/gu;
const SINGLE_QUOTE_PARA_RE = /(?:^|\n)[ \t]*[‘']\p{L}/gu;
const DOUBLE_QUOTE_PARA_RE = /(?:^|\n)[ \t]*[“"]\p{L}/gu;

const WORD_RE = /\p{L}+/gu;

function count(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

function isCapitalised(w: string): boolean {
  const c = w[0];
  return c !== c.toLowerCase();
}

/**
 * Read the dialect evidence off a text. Pure and dictionary-free; the
 * caller decides the thresholds.
 */
export function scoreDialectEvidence(text: string): DialectEvidence {
  const { british, american, leanOnly } = spellingTables();
  const britishMarkers = new Map<string, number>();
  const americanMarkers = new Map<string, number>();
  let britishHits = 0;
  let americanHits = 0;
  // marker → weight, so the capped total can be summed at the end.
  const weightOf = new Map<string, Weight>();

  const hit = (side: Map<string, number>, marker: string, w: Weight, spellingMarker: boolean) => {
    side.set(marker, (side.get(marker) ?? 0) + 1);
    weightOf.set(marker, w);
    if (spellingMarker) {
      if (side === britishMarkers) britishHits++;
      else americanHits++;
    }
  };

  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) {
    const raw = m[0];
    // A capitalised word that does not open a sentence is a name.
    if (isCapitalised(raw) && !isSentenceInitial(text, m.index)) continue;
    const w = raw.toLowerCase();
    let weight = british.get(w);
    if (weight !== undefined) {
      hit(britishMarkers, w, weight, true);
      continue;
    }
    weight = american.get(w);
    if (weight !== undefined) {
      hit(americanMarkers, w, weight, !leanOnly.has(w));
      continue;
    }
    const bw = BRITISH_WORDS[w];
    if (bw) {
      hit(britishMarkers, w, bw, false);
      continue;
    }
    const aw = AMERICAN_WORDS[w];
    if (aw) hit(americanMarkers, w, aw, false);
  }

  const titlePeriod = count(TITLE_PERIOD_RE, text);
  const titleBare = count(TITLE_BARE_RE, text);
  // Only when the manuscript is consistent about it: a text with both is
  // telling us nothing about house style.
  if (titlePeriod >= 3 && titleBare === 0) {
    americanMarkers.set("Mr. with a period", titlePeriod);
    weightOf.set("Mr. with a period", 2);
  } else if (titleBare >= 3 && titlePeriod === 0) {
    britishMarkers.set("Mr without a period", titleBare);
    weightOf.set("Mr without a period", 2);
  }
  const single = count(SINGLE_QUOTE_PARA_RE, text);
  const double = count(DOUBLE_QUOTE_PARA_RE, text);
  if (single >= 5 && single > double * 3) {
    britishMarkers.set("single-quote dialogue", single);
    weightOf.set("single-quote dialogue", 1);
  }

  const total = (side: Map<string, number>) => {
    let sum = 0;
    for (const [marker, n] of side) sum += Math.min(n, MARKER_CAP) * (weightOf.get(marker) ?? 1);
    return sum;
  };

  return {
    britishWeight: total(britishMarkers),
    americanWeight: total(americanMarkers),
    britishHits,
    americanHits,
    britishMarkers,
    americanMarkers,
  };
}

/** The markers that decided it, strongest first — for a log line. */
export function describeEvidence(side: Map<string, number>, max = 6): string {
  return [...side.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w, n]) => `${w}×${n}`)
    .join(", ");
}
