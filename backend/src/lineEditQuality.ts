// ── Line-edit quality: a reference-free score for rewriting ──
//
// Copy edit is scored by planted-error recall: the fixture plants a known set
// of discrete mistakes and we count how many came back. That measurement does
// not transfer to line edit, and the benchmark fixtures show why — diffing a
// line-edit fixture against its clean twin recovers 30-35 spans that are all
// one undifferentiated "other" bucket, because a line edit rewrites continuous
// prose rather than fixing separable errors. There is no error list to recall.
//
// So line edit is scored the way the GEC literature scores fluency-oriented
// rewriting: reference-free, on whether the text got more fluent WITHOUT
// drifting away from what the author wrote. This implements the Scribendi
// Score (Islam & Magnani, 2021), which combines three signals:
//
//   1. did the language model's perplexity go DOWN?  (fluency improved)
//   2. Levenshtein distance ratio                     (still the same text?)
//   3. token sort ratio                               (same words, reordered?)
//
// A rewrite only scores +1 if perplexity improved AND at least one similarity
// ratio stays above the threshold. That guard is the whole point: without it a
// system maximises the score by replacing the manuscript with bland, high-
// probability sentences, which is exactly the failure mode a novelist cares
// about. Perplexity alone rewards blandness; the ratios forbid it.
//
// Two deliberate deviations from the paper, both forced by this codebase:
//
//   - Scoring is per PASSAGE, not per sentence. The bundled llama.cpp server
//     returns logprobs only for tokens it generated, never for tokens you hand
//     it, so the only offline scorer available is llama-perplexity, which needs
//     at least 2x its context in tokens (1024 at -c 512). A sentence is ~30
//     tokens; a chapter is ~3000. The passage is also the honest unit for line
//     editing, where quality is a property of the paragraph, not the clause.
//
//   - The perplexity scorer is injected. It is the slow, stateful part (it
//     spawns a process and loads a model), so tests drive the decision rule
//     directly with scripted numbers, the same pattern textEvaluator.ts uses
//     for its LLM caller.
//
// Reference-free metrics are gameable BY DESIGN-AWARE systems — Kaneko et al.
// (2025) show adversarial systems can inflate all of Scribendi, SOME and
// IMPARA. That attack does not apply to a model that has never seen the metric,
// which is our case, but it does mean this score belongs beside the false-
// positive-on-clean-text number rather than replacing it.

/** Levenshtein edit distance between two strings, iterative two-row form. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Levenshtein distance ratio: 1 when identical, 0 when wholly different.
 * Two empty strings are identical, so 1.
 */
export function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Lowercased word tokens, punctuation dropped — the unit both ratios compare. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

/**
 * Token sort ratio: similarity after sorting the words.
 *
 * Blind to reordering on purpose. A line edit that moves a clause but keeps
 * the author's vocabulary has preserved meaning in the sense that matters
 * here; a rewrite that swaps the words for blander ones has not, and only this
 * ratio catches it — Levenshtein alone would score the reordering as a large
 * change and the vocabulary swap as a small one, which is backwards.
 */
export function tokenSortRatio(a: string, b: string): number {
  const sa = tokenize(a).sort().join(" ");
  const sb = tokenize(b).sort().join(" ");
  return levenshteinRatio(sa, sb);
}

/** Perplexity of a passage under some language model. Lower is more fluent. */
export type PerplexityScorer = (text: string) => Promise<number>;

export interface ScribendiInput {
  /** Perplexity of the author's original passage. */
  perplexityBefore: number;
  /** Perplexity of the model's rewrite. */
  perplexityAfter: number;
  levenshteinRatio: number;
  tokenSortRatio: number;
  /** Similarity floor; the paper uses 0.8. */
  threshold?: number;
}

/**
 * The Scribendi decision for one rewrite: +1 better, 0 no useful change,
 * -1 worse.
 *
 * An unchanged passage scores 0 rather than +1. A line editor that returns the
 * manuscript untouched has done nothing, and a metric that rewarded it would
 * rank "does nothing" above "tries and sometimes misses" — which is precisely
 * the wrong incentive for a rewriting pass.
 */
export function scribendiVerdict(input: ScribendiInput): -1 | 0 | 1 {
  const threshold = input.threshold ?? 0.8;
  const unchanged =
    input.levenshteinRatio >= 1 && input.tokenSortRatio >= 1;
  if (unchanged) return 0;

  const preservesMeaning =
    input.levenshteinRatio >= threshold || input.tokenSortRatio >= threshold;

  // Rewrote it into something else. Whatever happened to perplexity, this is
  // not an edit of the author's passage any more.
  if (!preservesMeaning) return -1;

  if (input.perplexityAfter < input.perplexityBefore) return 1;
  if (input.perplexityAfter > input.perplexityBefore) return -1;
  return 0;
}

export interface PassageScore {
  verdict: -1 | 0 | 1;
  perplexityBefore: number;
  perplexityAfter: number;
  levenshteinRatio: number;
  tokenSortRatio: number;
}

export interface LineEditQuality {
  /** Mean verdict across passages, -1..1. Above 0 means it helped on balance. */
  score: number;
  improved: number;
  unchanged: number;
  degraded: number;
  passages: PassageScore[];
}

/**
 * Score a line-edit run: every (original, rewrite) passage pair, averaged.
 *
 * `perplexity` is called at most once per distinct passage — the scorer is
 * expensive enough that the caller should not pay for the same text twice.
 */
export async function scoreLineEdit(
  pairs: { before: string; after: string }[],
  perplexity: PerplexityScorer,
  opts?: { threshold?: number },
): Promise<LineEditQuality> {
  const cache = new Map<string, Promise<number>>();
  const ppl = (text: string): Promise<number> => {
    const hit = cache.get(text);
    if (hit) return hit;
    const p = perplexity(text);
    cache.set(text, p);
    return p;
  };

  const passages: PassageScore[] = [];
  for (const { before, after } of pairs) {
    const [perplexityBefore, perplexityAfter] = await Promise.all([
      ppl(before),
      ppl(after),
    ]);
    const lev = levenshteinRatio(before, after);
    const sort = tokenSortRatio(before, after);
    passages.push({
      verdict: scribendiVerdict({
        perplexityBefore,
        perplexityAfter,
        levenshteinRatio: lev,
        tokenSortRatio: sort,
        threshold: opts?.threshold,
      }),
      perplexityBefore,
      perplexityAfter,
      levenshteinRatio: lev,
      tokenSortRatio: sort,
    });
  }

  const improved = passages.filter((p) => p.verdict === 1).length;
  const degraded = passages.filter((p) => p.verdict === -1).length;
  const unchanged = passages.length - improved - degraded;
  return {
    score: passages.length
      ? passages.reduce((s, p) => s + p.verdict, 0) / passages.length
      : 0,
    improved,
    unchanged,
    degraded,
    passages,
  };
}
