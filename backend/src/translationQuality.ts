// ── Translation quality: deterministic scoring against a reference ──
//
// scripts/test-translation.ts already scores translations, by asking a judge
// model to rate each paragraph 1-5 on the production rubric. That number has
// two problems this module exists to fix:
//
//   1. It saturates. On the last run every model scored between 4.2 and 5.0,
//      with three of nine rows at a flat 5.0. A metric that cannot separate a
//      4B from a 24B is not measuring the thing it is named after.
//   2. The judge is one of the candidates. The largest installed model judges
//      its own translation, and the report has to carry a "self-judging caveat
//      applies" footnote because there is nothing better available offline.
//
// So this scores against a human reference instead, with metrics that are pure
// functions of two strings — no model, no judge, no network, and the same
// answer every run.
//
// chrF is the primary number. It is the WMT standard for exactly this case:
// character n-gram F-score, no tokeniser, and it degrades gracefully on
// morphologically rich languages where word-level metrics like BLEU punish a
// correct translation for choosing a different inflection. German compounds
// and Danish definite suffixes are precisely that case — "bogbinderen" versus
// "bogbinder" is a near miss in characters and a total miss in words.
//
// A reference translation is one valid rendering, not the only one, so chrF is
// a similarity score and not a grade. It is meaningful for ranking models
// against each other on the same source, which is what a benchmark does; it is
// not meaningful as an absolute "this translation is 62% correct".

/** Character n-grams of order `n`, whitespace collapsed. */
function charNgrams(text: string, n: number): Map<string, number> {
  const s = text.replace(/\s+/g, " ").trim();
  const out = new Map<string, number>();
  for (let i = 0; i + n <= s.length; i++) {
    const g = s.slice(i, i + n);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Word n-grams of order `n`, lowercased. */
function wordNgrams(text: string, n: number): Map<string, number> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Map<string, number>();
  for (let i = 0; i + n <= words.length; i++) {
    const g = words.slice(i, i + n).join(" ");
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Clipped overlap: how many of `a`'s n-grams appear in `b`, counting repeats. */
function overlap(a: Map<string, number>, b: Map<string, number>): number {
  let hits = 0;
  for (const [g, count] of a) hits += Math.min(count, b.get(g) ?? 0);
  return hits;
}

function total(m: Map<string, number>): number {
  let n = 0;
  for (const c of m.values()) n += c;
  return n;
}

export interface ChrfOptions {
  /** Highest character n-gram order. WMT uses 6. */
  charOrder?: number;
  /** Highest word n-gram order. 0 = chrF, 2 = chrF++. */
  wordOrder?: number;
  /** Recall weight. 2 is the standard chrF2 — recall matters more than
   *  precision because an omission is worse than a wordy rendering. */
  beta?: number;
}

/**
 * chrF / chrF++ between a hypothesis and a reference, 0-100.
 *
 * Averaged over n-gram orders rather than the geometric mean BLEU uses, so a
 * single order scoring zero does not zero the whole sentence — which is what
 * makes it usable on short passages.
 */
export function chrf(
  hypothesis: string,
  reference: string,
  opts?: ChrfOptions,
): number {
  const charOrder = opts?.charOrder ?? 6;
  const wordOrder = opts?.wordOrder ?? 0;
  const beta = opts?.beta ?? 2;

  if (!hypothesis.trim() || !reference.trim()) return 0;

  const precisions: number[] = [];
  const recalls: number[] = [];

  for (let n = 1; n <= charOrder; n++) {
    const h = charNgrams(hypothesis, n);
    const r = charNgrams(reference, n);
    const th = total(h);
    const tr = total(r);
    if (th === 0 || tr === 0) continue;
    const hits = overlap(h, r);
    precisions.push(hits / th);
    recalls.push(hits / tr);
  }
  for (let n = 1; n <= wordOrder; n++) {
    const h = wordNgrams(hypothesis, n);
    const r = wordNgrams(reference, n);
    const th = total(h);
    const tr = total(r);
    if (th === 0 || tr === 0) continue;
    const hits = overlap(h, r);
    precisions.push(hits / th);
    recalls.push(hits / tr);
  }
  if (precisions.length === 0) return 0;

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const p = avg(precisions);
  const r = avg(recalls);
  if (p === 0 && r === 0) return 0;

  const b2 = beta * beta;
  return (100 * ((1 + b2) * p * r)) / (b2 * p + r);
}

/**
 * Ratio of hypothesis length to reference length, in characters.
 *
 * The cheapest detector for the two failure modes a similarity score hides: a
 * model that stops early (ratio well under 1) and one that pads with
 * commentary or repeats itself (ratio well over 1). Both have been seen from
 * small models on long passages, and both can still score respectably on chrF
 * because what they DID produce matched.
 */
export function lengthRatio(hypothesis: string, reference: string): number {
  const r = reference.replace(/\s+/g, " ").trim().length;
  if (r === 0) return 0;
  return hypothesis.replace(/\s+/g, " ").trim().length / r;
}

/**
 * Share of hypothesis words that look untranslated, 0-1.
 *
 * A small model asked for Danish sometimes returns whole English clauses, or
 * leaves a word it did not know. chrF barely notices — the sentence around it
 * still matches — but a reader notices immediately, so it is scored on its
 * own. `sourceWords` is the source text; a word is suspicious when it appears
 * in the source, does not appear in the reference translation, and is not a
 * proper noun (which SHOULD carry across untranslated).
 */
export function sourceLeakage(
  hypothesis: string,
  source: string,
  reference: string,
): number {
  const words = (s: string) =>
    s.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  const srcSet = new Set(words(source));
  const refSet = new Set(words(reference));

  const hyp = hypothesis.match(/\p{L}{3,}/gu) ?? [];
  if (hyp.length === 0) return 0;

  let leaked = 0;
  for (const raw of hyp) {
    // A capitalised token mid-sentence is a name; names are meant to survive.
    if (raw[0] === raw[0].toUpperCase() && raw[0] !== raw[0].toLowerCase()) continue;
    const w = raw.toLowerCase();
    if (srcSet.has(w) && !refSet.has(w)) leaked++;
  }
  return leaked / hyp.length;
}

export interface TranslationScore {
  /** chrF2, 0-100. The headline similarity number. */
  chrf: number;
  /** chrF++ (adds word 1- and 2-grams), 0-100. */
  chrfPlusPlus: number;
  lengthRatio: number;
  sourceLeakage: number;
}

/** Score one translation against its source and reference. */
export function scoreTranslation(
  hypothesis: string,
  source: string,
  reference: string,
): TranslationScore {
  return {
    chrf: chrf(hypothesis, reference),
    chrfPlusPlus: chrf(hypothesis, reference, { wordOrder: 2 }),
    lengthRatio: lengthRatio(hypothesis, reference),
    sourceLeakage: sourceLeakage(hypothesis, source, reference),
  };
}
