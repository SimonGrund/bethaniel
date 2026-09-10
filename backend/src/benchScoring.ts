// ── Benchmark scoring — recall/precision/consistency/time for model comparison ──
//
// The benchmark fixtures (sample_texts/*_correct.md vs *_copy_edit.md /
// *_line_edit.md) are near-identical prose except for deliberately planted
// errors. Diffing a pair gives an exact, auditable ground truth — replacing
// a hardcoded "expected: 10" guess — so a model's surfaced corrections can be
// scored against real recall (did it catch the planted errors?) and
// precision (did it invent problems that aren't there?) instead of just a
// raw correction count.

import { diffWordsWithSpace } from "diff";
import { widenToWords } from "./retextChecks.js";

export interface PlantedError {
  /** The erroneous text, widened to word boundaries for readability/matching. */
  wrong: string;
  /** The correct text at the same position. */
  right: string;
}

/** Bare shape a benchmarked correction needs — matches Correction structurally. */
export interface ScoredCorrection {
  original: string;
  corrected: string;
}

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

interface RawSpan {
  wS: number;
  wE: number;
  rS: number;
  rE: number;
}

/**
 * Diff an errored fixture against its clean counterpart to recover the exact
 * set of deliberately planted errors. Consecutive removed/added runs (a
 * substitution) merge into one planted error; a lone removed run (extra
 * erroneous text with nothing to replace it) or lone added run (missing
 * text) still produces one, with the other side empty.
 *
 * Adjacent changes closer together than `mergeGapChars` are then merged into
 * one combined error — load-bearing for line-edit fixtures, which are dense,
 * near-universal paraphrasing rather than isolated typos: without merging,
 * a single reworded sentence fragments into dozens of tiny adjacent spans
 * that don't correspond to what a human reviewer would count as one
 * meaningful improvement. Copy-edit fixtures have sparse, isolated errors,
 * so merging rarely triggers there.
 */
export function buildGroundTruth(
  erroredText: string,
  correctText: string,
  mergeGapChars = 20,
): PlantedError[] {
  const changes = diffWordsWithSpace(erroredText, correctText);
  const spans: RawSpan[] = [];
  let erroredPos = 0;
  let correctPos = 0;
  let i = 0;

  while (i < changes.length) {
    const c = changes[i];
    if (c.removed || c.added) {
      const wrongStart = erroredPos;
      const rightStart = correctPos;
      let wrongLen = 0;
      let rightLen = 0;
      let j = i;
      while (j < changes.length && (changes[j].removed || changes[j].added)) {
        if (changes[j].removed) wrongLen += changes[j].value.length;
        else rightLen += changes[j].value.length;
        j++;
      }
      const [wS, wE] = widenToWords(erroredText, wrongStart, wrongStart + wrongLen);
      const [rS, rE] = widenToWords(correctText, rightStart, rightStart + rightLen);
      spans.push({ wS, wE, rS, rE });
      erroredPos += wrongLen;
      correctPos += rightLen;
      i = j;
    } else {
      erroredPos += c.value.length;
      correctPos += c.value.length;
      i++;
    }
  }

  const merged: RawSpan[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && span.wS - prev.wE <= mergeGapChars) {
      prev.wE = Math.max(prev.wE, span.wE);
      prev.rE = Math.max(prev.rE, span.rE);
    } else {
      merged.push({ ...span });
    }
  }

  return merged.map((s) => ({
    wrong: erroredText.slice(s.wS, s.wE),
    right: correctText.slice(s.rS, s.rE),
  }));
}

/**
 * Whether a model's correction actually catches a planted error: it must
 * touch the same span (its `original` and the error's `wrong` text overlap
 * by containment either way — a model may widen or narrow the context) AND
 * its fix must genuinely move toward the right answer, not just touch the
 * spot without truly fixing it.
 */
export function correctionCatchesError(
  correction: ScoredCorrection,
  err: PlantedError,
): boolean {
  const original = norm(correction.original);
  const corrected = norm(correction.corrected);
  const wrong = norm(err.wrong);
  const right = norm(err.right);
  if (!wrong && !right) return false;
  const spanOverlaps =
    wrong.length > 0 && (original.includes(wrong) || wrong.includes(original));
  if (!spanOverlaps) return false;
  if (!right) return true; // pure deletion: touching the erroneous span is the fix
  return corrected.includes(right) || right.includes(corrected);
}

export interface RecallPrecisionResult {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** 0-100. Undefined ground truth (clean-text runs) has no recall — use precision only. */
  recall: number | null;
  /**
   * 0-100. Errors that ANY correction landed on, whether or not the fix was
   * right.
   *
   * `recall` is strict: right span AND right replacement. That is the correct
   * measure of the product doing the work for the author. But the three ways
   * to fail are not equally bad for them, and only this pair separates them:
   *
   *   caught      right span, right fix   — nothing to do
   *   wrong fix   right span, wrong fix   — flagged; the author sees it and
   *                                         fixes it themselves
   *   missed      no correction at all    — INVISIBLE, and the only failure
   *                                         a human-in-the-loop cannot catch
   *
   * So attentionRecall - recall is the share of errors Betty surfaced but
   * could not fix, and 100 - attentionRecall is the share it hid.
   */
  attentionRecall: number | null;
  /** 0-100 */
  precision: number;
  /** 0-100, harmonic mean of recall/precision when both exist; falls back to precision alone. */
  f1: number;
  missedErrors: PlantedError[];
  falsePositiveCorrections: ScoredCorrection[];
  /**
   * Every false positive split into two kinds that call for different fixes:
   * "wrongFix" landed on a real planted error's span but proposed the wrong
   * replacement (e.g. "ceder"→"ceded" instead of "cedar") — the model's
   * DETECTION was right, only its guess was wrong, which is exactly the
   * class of mistake a skeptical reviewer re-reading the fix in context
   * should be able to catch. "hallucination" touches text with no planted
   * error at all — a different failure mode the reviewer can't fix by
   * checking spelling, since there was nothing wrong to begin with.
   */
  falsePositiveBreakdown: {
    wrongFix: ScoredCorrection[];
    /** Subset of wrongFix that leaves valid text — a different wording, not a
     *  broken one. Empty unless scoreCorrections was given a WordChecks. */
    wrongFixBenign: ScoredCorrection[];
    /** Subset of wrongFix that introduces a non-word: the model made the
     *  manuscript worse than it found it. */
    wrongFixDamaging: ScoredCorrection[];
    hallucination: ScoredCorrection[];
  };
}

function words(s: string): string[] {
  return norm(s).split(" ").filter(Boolean);
}

function bigrams(ws: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ws.length - 1; i++) out.add(`${ws[i]} ${ws[i + 1]}`);
  return out;
}

/**
 * Whether a correction's span touches ANY planted error's span, regardless
 * of whether its fix is right — used to separate "found the spot, wrong
 * guess" false positives from "invented a problem" ones.
 *
 * Full substring containment (either direction) is the fast, common case.
 * It under-counts, though: ground-truth spans get merged when errors sit
 * close together (`mergeGapChars`), and a model's correction span can be
 * wider or offset from the merged span (e.g. it fixes a duplicated word but
 * not a typo four words later that got merged into the same ground-truth
 * span) — neither side then contains the other even though the correction
 * plainly targets that error. A shared two-word run (bigram) between the
 * correction's original text and the error's wrong text catches these
 * without over-matching on lone common words like "the" or "and".
 */
export function touchesErrorSpan(
  correction: ScoredCorrection,
  err: PlantedError,
): boolean {
  const wrong = norm(err.wrong);
  if (!wrong) return false;
  const original = norm(correction.original);
  if (original.includes(wrong) || wrong.includes(original)) return true;
  const originalWords = words(correction.original);
  if (originalWords.length < 2) return false;
  const wrongWords = words(err.wrong);
  if (wrongWords.length < 2) return false;
  const originalBigrams = bigrams(originalWords);
  for (const bg of bigrams(wrongWords)) {
    if (originalBigrams.has(bg)) return true;
  }
  return false;
}

function touchesAnyErrorSpan(
  correction: ScoredCorrection,
  groundTruth: PlantedError[],
): boolean {
  return groundTruth.some((err) => touchesErrorSpan(correction, err));
}

/**
 * Score a model's corrections against ground truth. Each ground-truth error
 * is matched against the first not-yet-claimed correction that catches it
 * (greedy, one correction can't double-count two errors). Anything left
 * over on either side is a miss (false negative) or a false positive.
 */
export function scoreCorrections(
  corrections: ScoredCorrection[],
  groundTruth: PlantedError[],
  /** Supply to split wrong fixes into benign and damaging. Without it both
   *  land in `wrongFix` and the two sub-counts are zero. */
  checks?: WordChecks,
): RecallPrecisionResult {
  const claimed = new Set<number>();
  const missedErrors: PlantedError[] = [];
  let truePositives = 0;

  for (const err of groundTruth) {
    const idx = corrections.findIndex(
      (c, i) => !claimed.has(i) && correctionCatchesError(c, err),
    );
    if (idx === -1) {
      missedErrors.push(err);
    } else {
      claimed.add(idx);
      truePositives++;
    }
  }

  const falsePositiveCorrections = corrections.filter((_, i) => !claimed.has(i));
  const falsePositives = falsePositiveCorrections.length;
  const falseNegatives = missedErrors.length;

  const wrongFixCorrections = falsePositiveCorrections.filter((c) =>
    touchesAnyErrorSpan(c, groundTruth),
  );

  // A wrong fix is not automatically a bad one.
  //
  // The ground truth records ONE correct answer, recovered by diffing the
  // planted fixture against its clean twin. Prose usually admits several. A
  // model that turns "stepping of the ramp" into "stepping onto the ramp"
  // scores as a wrong fix against a ground truth that says "off", and has
  // nonetheless left the author with correct English. That is a completely
  // different event from turning it into "stepping off the ramp".
  //
  // The test is deliberately narrow, because a wide one would be a judgement
  // about meaning that nothing here can make: does the replacement introduce
  // a word the dictionary does not know? If it does not, the sentence is at
  // worst differently-worded and at best equally correct. If it does, the
  // model has actively damaged text it was asked to repair, which is the
  // only failure mode in this family that is worse than doing nothing.
  const introducesNonWord = (c: ScoredCorrection): boolean => {
    if (!checks) return false;
    const before = new Set(words(c.original));
    return words(c.corrected).some((w) => !before.has(w) && !checks.isKnownWord(w));
  };
  const damaging = checks ? wrongFixCorrections.filter(introducesNonWord) : [];
  const benign = checks
    ? wrongFixCorrections.filter((c) => !introducesNonWord(c))
    : [];

  const falsePositiveBreakdown = {
    wrongFix: wrongFixCorrections,
    /** Wrong against the ground truth, but leaves valid text — a different
     *  wording, not a broken one. Empty unless `checks` was supplied. */
    wrongFixBenign: benign,
    /** Wrong AND introduces a word no dictionary knows: the model has made
     *  the manuscript worse than it found it. */
    wrongFixDamaging: damaging,
    hallucination: falsePositiveCorrections.filter(
      (c) => !touchesAnyErrorSpan(c, groundTruth),
    ),
  };

  const recall =
    groundTruth.length > 0 ? (truePositives / groundTruth.length) * 100 : null;
  // Counted over ground-truth errors rather than over corrections, so two
  // corrections landing on one error cannot inflate it past 100%.
  const touched = groundTruth.filter((err) =>
    corrections.some((c) => touchesErrorSpan(c, err)),
  ).length;
  const attentionRecall =
    groundTruth.length > 0 ? (touched / groundTruth.length) * 100 : null;
  const precision =
    corrections.length > 0 ? (truePositives / corrections.length) * 100 : 100;
  const f1 =
    recall !== null
      ? recall + precision > 0
        ? (2 * recall * precision) / (recall + precision)
        : 0
      : precision;

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    recall,
    attentionRecall,
    precision,
    f1,
    missedErrors,
    falsePositiveCorrections,
    falsePositiveBreakdown,
  };
}

/**
 * How similar two runs of the SAME task were — the seeding work should push
 * this toward 100 for local models; a low score means a model's quality
 * number here was a lucky/unlucky roll, not something to trust at face value.
 * Jaccard similarity (0-100) over (original→corrected) pairs.
 */
export function consistencyScore(
  runA: ScoredCorrection[],
  runB: ScoredCorrection[],
): number {
  const keyOf = (c: ScoredCorrection) => `${norm(c.original)}→${norm(c.corrected)}`;
  const a = new Set(runA.map(keyOf));
  const b = new Set(runB.map(keyOf));
  if (a.size === 0 && b.size === 0) return 100;
  let intersection = 0;
  for (const k of a) if (b.has(k)) intersection++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 100 : Math.round((intersection / union) * 100);
}

/** 100 for the fastest model in the run; scaled down for slower ones. */
export function timeScore(thisMs: number, fastestMs: number): number {
  if (thisMs <= 0) return 100;
  return Math.min(100, Math.round((100 * fastestMs) / thisMs));
}

/** Flat penalty per false positive on already-clean text — it should be zero. */
export function falsePositiveCleanScore(fpCount: number): number {
  return Math.max(0, 100 - fpCount * 15);
}

/**
 * Overall weighted score for one mode (copy_edit or line_edit): mostly
 * quality (F1 of recall & precision — a model can't win by over- or
 * under-flagging), a smaller slice for speed.
 */
export function overallScore(f1: number, timeScoreValue: number): number {
  return Math.round(0.8 * f1 + 0.2 * timeScoreValue);
}

// ── Error categories ──
//
// A single recall number hides which KIND of error a model misses, and those
// call for completely different fixes: missed spelling is a detection
// problem, missed commas are a prompt-comprehension problem, and a model can
// look identical on both while being unusable for one of them. The categories
// are derived from the fixture pair itself, so they stay honest if a fixture
// changes — nothing is hand-labelled.

export type PlantedErrorCategory =
  /** The wrong token is not a word in any dialect — "notebok", "mension".
   *  The deterministic Hunspell pass sees these, so recall should be ~100%
   *  and a miss is a real defect rather than a limitation. */
  | "misspelling"
  /** The wrong token IS a correctly spelled word, just the wrong one —
   *  "their"/"there", "past"/"passed", "quiet"/"quite". No dictionary can see
   *  these; only the model can, and it is far weaker at them. */
  | "wordChoice"
  /** A correct spelling in the OTHER English dialect — "colour", "realised",
   *  "grey". Not an error at all except relative to the chosen dialect, and
   *  the copy-edit prompt converts them under a separate rule, so counting
   *  them as misspellings flatters neither number. */
  | "dialect"
  /** The three above, unsplit — reported only when no dictionary was
   *  available for the fixture's language. */
  | "spelling"
  | "comma"
  | "capitalization"
  | "duplicateWord"
  | "punctuation"
  | "other";

const CATEGORY_ORDER: PlantedErrorCategory[] = [
  "misspelling",
  "wordChoice",
  "dialect",
  "spelling",
  "comma",
  "capitalization",
  "duplicateWord",
  "punctuation",
  "other",
];

/** Asks whether a token is a real word. `getWordValidator` in spellcheck.ts
 *  returns exactly this shape. Injected rather than imported so this module
 *  stays free of dictionary loading. */
export type KnownWordCheck = (word: string) => boolean;

export interface WordChecks {
  /** Real word in the manuscript's own language and dialect. */
  isKnownWord: KnownWordCheck;
  /**
   * Real word in the other English dialect. Omit for non-English fixtures,
   * which have no dialect axis — they then split into misspelling/wordChoice
   * only.
   *
   * Caveat: this is "the other dictionary accepts it", not "these two are a
   * known dialect pair", so a rare real word can land here. In the stress100
   * fixture "sailers" (a valid if archaic noun) is classed dialect rather
   * than a typo for "sailors". One in nine, and it errs toward the harder
   * bucket, so it understates rather than flatters.
   */
  isKnownInOtherDialect?: KnownWordCheck;
}

function bareToken(w: string): string {
  return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function withoutCommas(s: string): string {
  return collapseWhitespace(s.replace(/,/g, ""));
}

function withoutPunctuation(s: string): string {
  return collapseWhitespace(s.replace(/[^\p{L}\p{N}\s]/gu, ""));
}

/** Collapse runs of the same word ("the the last" → "the last"). */
function collapseRepeats(ws: string[]): string[] {
  return ws.filter((w, i) => i === 0 || w !== ws[i - 1]);
}

/**
 * What kind of error a planted (wrong → right) pair represents.
 *
 * Order matters. Case is tested before punctuation because a pure
 * capitalization fix ("tuesday" → "Tuesday") is punctuation-identical and
 * would otherwise be filed as a punctuation error.
 */
export function classifyPlantedError(
  err: PlantedError,
  checks?: WordChecks | null,
): PlantedErrorCategory {
  const wrong = collapseWhitespace(err.wrong);
  const right = collapseWhitespace(err.right);
  if (!wrong || !right || wrong === right) return "other";

  if (wrong.toLowerCase() === right.toLowerCase()) return "capitalization";
  if (withoutCommas(wrong) === withoutCommas(right)) return "comma";
  if (withoutPunctuation(wrong) === withoutPunctuation(right)) return "punctuation";

  const wrongWords = wrong.toLowerCase().split(" ").filter(Boolean);
  const rightWords = right.toLowerCase().split(" ").filter(Boolean);
  if (
    wrongWords.length > rightWords.length &&
    collapseRepeats(wrongWords).join(" ") === collapseRepeats(rightWords).join(" ")
  ) {
    return "duplicateWord";
  }

  // One word swapped for another, everything else identical. Anything touching
  // more than one word is a rewrite, not a spelling fix.
  if (wrongWords.length === rightWords.length) {
    const differingAt = wrongWords
      .map((w, i) => (w !== rightWords[i] ? i : -1))
      .filter((i) => i >= 0);
    if (differingAt.length === 1) {
      if (!checks) return "spelling";
      const token = bareToken(wrongWords[differingAt[0]]);
      if (!token) return "misspelling";
      // Three different capabilities, and the models score very differently
      // on each: a real word in the wrong place ("their" for "there"), a
      // correct spelling in the other dialect ("colour"), or something that
      // is not a word at all ("notebok"). Only the last is visible to a
      // spell checker.
      if (checks.isKnownWord(token)) return "wordChoice";
      if (checks.isKnownInOtherDialect?.(token)) return "dialect";
      return "misspelling";
    }
  }
  return "other";
}

export interface CategoryRecall {
  category: PlantedErrorCategory;
  planted: number;
  caught: number;
  /** 0-100, or null when the fixture planted none of this category. */
  recall: number | null;
  /** Errors any correction landed on, right fix or wrong. */
  surfaced: number;
  attentionRecall: number | null;
}

/**
 * Per-category recall, derived from a `scoreCorrections` result rather than
 * re-matching. Reusing its `missedErrors` (the same object references it was
 * handed) guarantees the category rows always add up to the headline recall —
 * a second, independently-greedy matching pass would not.
 */
export function recallByCategory(
  groundTruth: PlantedError[],
  missedErrors: PlantedError[],
  checks?: WordChecks | null,
  /** Supply to also report how many of each category were SURFACED — landed on
   *  by any correction, right fix or wrong. Without it `surfaced` mirrors
   *  `caught`, which is the stricter of the two and so the safe default. */
  corrections?: ScoredCorrection[],
): CategoryRecall[] {
  const missed = new Set<PlantedError>(missedErrors);
  const planted = new Map<PlantedErrorCategory, number>();
  const caught = new Map<PlantedErrorCategory, number>();
  const surfaced = new Map<PlantedErrorCategory, number>();

  for (const err of groundTruth) {
    const cat = classifyPlantedError(err, checks);
    planted.set(cat, (planted.get(cat) ?? 0) + 1);
    const wasCaught = !missed.has(err);
    if (wasCaught) caught.set(cat, (caught.get(cat) ?? 0) + 1);
    // An error a correction landed on but mis-fixed is still in front of the
    // author. Counted per category because the two diverge very differently by
    // kind: a misspelling is almost always fixed once found, a comma often is
    // not.
    const wasSurfaced =
      wasCaught ||
      (corrections?.some((c) => touchesErrorSpan(c, err)) ?? false);
    if (wasSurfaced) surfaced.set(cat, (surfaced.get(cat) ?? 0) + 1);
  }

  return CATEGORY_ORDER.map((category) => {
    const p = planted.get(category) ?? 0;
    const c = caught.get(category) ?? 0;
    const s = surfaced.get(category) ?? c;
    return {
      category,
      planted: p,
      caught: c,
      surfaced: s,
      recall: p > 0 ? (c / p) * 100 : null,
      attentionRecall: p > 0 ? (s / p) * 100 : null,
    };
  });
}

// ── Comma sub-classification ──────────────────────────────────────────────
//
// The `comma` bucket lumps together two things that are not alike, and
// scoring them as one number measures the wrong thing for half of them.
//
// Ground truth here is recovered by diffing an errored fixture against its
// clean twin, so every planted error is scored as "did the model restore what
// the author originally wrote". For a rule-governed comma that is the same
// question as "is the text now correct". For a discretionary one it is not:
// two careful editors would punctuate differently, and a model that declines
// to reproduce THIS author's choice has not made an error. Pooling them gives
// a number that is neither a correctness measure nor a style measure.
//
// Measured across three engines and four languages, the split is worth about
// 3x — rule-governed commas score 31-48%, discretionary ones 13-14% — so the
// pooled figure is dragged down by errors that arguably aren't errors. It does
// not, however, rescue commas: 39% on the rule-governed half is still far
// below the ~80% these engines manage on everything else, and the spurious row
// is worse than the pooled number rather than better. See
// docs/comma-scoring.md.
//
// The rules come from a reference grammar for each language, and were fixed
// before any score was computed rather than tuned against results.

export type CommaKind =
  /** A comma the author did not write. Wrong in every language, with no
   *  discretion available. */
  | "spurious"
  /** A non-final comma in a list of three or more; omitting it runs two items
   *  together ("polite brief, and entirely reasonable"). */
  | "seriesInner"
  /** Opens a non-restrictive relative clause in English. CMOS 6.27. */
  | "relativeEn"
  /** German comma before a subordinate clause or relative pronoun. Duden
   *  D126/D127 — required, and LanguageTool's German rule set knows it, which
   *  is why this row scores far above the English equivalent. */
  | "subordDe"
  /** Danish comma before som/der/at/fordi/hvis. Danish sanctions TWO systems
   *  (grammatisk komma sets it, nyt komma does not), so neither presence nor
   *  absence is an error on its own — only inconsistency within one text is.
   *  Reported separately for that reason. */
  | "subordDa"
  /** The comma before the final "and" of a list. Optional by every major style
   *  guide; the guides disagree with each other, not with the writer. */
  | "seriesOxford"
  /** Before and/but/og/men/y/pero joining two main clauses. Standard advice,
   *  legitimately dropped when the clauses are short. */
  | "coordClause"
  /** Fronted adverbials, trailing adjuncts, appositives, rhythm commas. The
   *  writer's ear governs. */
  | "freeAdjunct";

export const COMMA_RULE_GOVERNED: readonly CommaKind[] = [
  "spurious",
  "seriesInner",
  "relativeEn",
  "subordDe",
];
export const COMMA_CONTESTED: readonly CommaKind[] = ["subordDa"];
export const COMMA_DISCRETIONARY: readonly CommaKind[] = [
  "seriesOxford",
  "coordClause",
  "freeAdjunct",
];

export type CommaBucket = "rule-governed" | "contested" | "discretionary";

export function commaBucket(kind: CommaKind): CommaBucket {
  if (COMMA_RULE_GOVERNED.includes(kind)) return "rule-governed";
  if (COMMA_CONTESTED.includes(kind)) return "contested";
  return "discretionary";
}

const REL_EN = /^(which|who|whom|whose)$/i;
const REL_DE =
  /^(der|die|das|dass|welche[rmns]?|weil|wenn|ob|damit|obwohl|während|nachdem|bevor|als)$/i;
const REL_DA = /^(som|der|at|fordi|hvis|når|selvom|mens|inden|efter)$/i;
const COORD =
  /^(and|but|so|yet|or|nor|og|men|eller|und|aber|oder|sondern|denn|y|e|o|pero|sino)$/i;

const commaCount = (s: string): number => (s.match(/,/g) ?? []).length;

/** The sentence containing a planted span, and where in it the comma sits. */
function sentenceAround(
  context: string,
  right: string,
): { text: string; commaAt: number } {
  const at = context.indexOf(right.trim().slice(0, 24));
  if (at < 0) return { text: context, commaAt: context.indexOf(",") };
  const start = context.lastIndexOf(".", at) + 1;
  let end = context.indexOf(".", at + right.length);
  if (end < 0) end = context.length;
  const localComma = right.indexOf(",");
  return {
    text: context.slice(start, end),
    commaAt: at - start + (localComma >= 0 ? localComma : 0),
  };
}

/**
 * Which kind of comma one planted error is. `context` is the surrounding clean
 * text (roughly a sentence either side) — a list comma can only be recognised
 * from more of the sentence than the span itself carries.
 */
export function classifyComma(
  err: PlantedError,
  lang: string,
  context = "",
): CommaKind {
  const { wrong, right } = err;
  if (commaCount(wrong) > commaCount(right)) return "spurious";

  // Find the comma `right` has that `wrong` does not, and read the word after
  // it. Walking both strings together survives the leading and trailing
  // context the diff widened the span with.
  let i = 0;
  let j = 0;
  let after = "";
  while (i < right.length && j < wrong.length) {
    if (right[i] === wrong[j]) {
      i++;
      j++;
      continue;
    }
    if (right[i] === ",") {
      after = right.slice(i + 1).trim().split(/\s+/)[0] ?? "";
      break;
    }
    i++;
    j++;
  }
  if (!after) {
    const m = right.match(/,\s*(\S+)/);
    after = m ? m[1] : "";
  }
  const word = after.replace(/[^\p{L}]/gu, "");

  // A word introducing a subordinate or relative clause is never a list item,
  // so these are settled before the series test rather than after it: the
  // other order filed Danish "..., at" and German "..., bevor" as list commas.
  // The author's own text settles restrictive vs non-restrictive — they wrote
  // the comma, so the clause is non-restrictive and a reference grammar then
  // requires it.
  if (lang === "en" && REL_EN.test(word)) return "relativeEn";
  if (lang === "de" && REL_DE.test(word)) return "subordDe";
  if (lang === "da" && REL_DA.test(word)) return "subordDa";

  // A coordinate series, recognised strictly: two or more commas separating
  // short clause-free items, the last pair joined by a conjunction. A looser
  // test that merely looked for another comma nearby swallowed every relative
  // clause in ordinary prose, because well-punctuated prose has commas
  // everywhere. The comma being classified must fall INSIDE the match, not
  // merely in the same sentence.
  const sent = sentenceAround(context || right, right);
  const series =
    /[^,;:.!?]{1,40},\s*[^,;:.!?]{1,40},\s*(?:and|og|und|y|e|o|eller|oder)\b|[^,;:.!?]{1,40},\s*[^,;:.!?]{1,40}\s+(?:and|og|und|y|e|o|eller|oder)\b/i.exec(
      sent.text,
    );
  if (
    series &&
    sent.commaAt >= series.index &&
    sent.commaAt <= series.index + series[0].length
  ) {
    return COORD.test(word) ? "seriesOxford" : "seriesInner";
  }

  // "she left, and he stayed" — two main clauses, not a list.
  if (COORD.test(word)) return "coordClause";
  return "freeAdjunct";
}

export interface CommaKindRecall {
  kind: CommaKind;
  bucket: CommaBucket;
  planted: number;
  caught: number;
  surfaced: number;
  recall: number | null;
  attentionRecall: number | null;
}

const COMMA_KIND_ORDER: CommaKind[] = [
  "spurious",
  "seriesInner",
  "relativeEn",
  "subordDe",
  "subordDa",
  "seriesOxford",
  "coordClause",
  "freeAdjunct",
];

/**
 * The comma bucket, split by kind. Built from a `scoreCorrections` result the
 * same way `recallByCategory` is — reusing its `missedErrors` object
 * references — so these rows always add up to that function's `comma` row.
 */
export function commaRecallByKind(
  groundTruth: PlantedError[],
  missedErrors: PlantedError[],
  lang: string,
  correctText: string,
  corrections?: ScoredCorrection[],
): CommaKindRecall[] {
  const missed = new Set<PlantedError>(missedErrors);
  const planted = new Map<CommaKind, number>();
  const caught = new Map<CommaKind, number>();
  const surfaced = new Map<CommaKind, number>();

  for (const err of groundTruth) {
    if (classifyPlantedError(err, null) !== "comma") continue;
    const at = correctText.indexOf(err.right);
    const context =
      at >= 0
        ? correctText
            .slice(Math.max(0, at - 70), at + err.right.length + 70)
            .replace(/\s+/g, " ")
        : "";
    const kind = classifyComma(err, lang, context);
    planted.set(kind, (planted.get(kind) ?? 0) + 1);
    const wasCaught = !missed.has(err);
    if (wasCaught) caught.set(kind, (caught.get(kind) ?? 0) + 1);
    const wasSurfaced =
      wasCaught || (corrections?.some((c) => touchesErrorSpan(c, err)) ?? false);
    if (wasSurfaced) surfaced.set(kind, (surfaced.get(kind) ?? 0) + 1);
  }

  return COMMA_KIND_ORDER.filter((k) => (planted.get(k) ?? 0) > 0).map((kind) => {
    const p = planted.get(kind) ?? 0;
    const c = caught.get(kind) ?? 0;
    const s = surfaced.get(kind) ?? c;
    return {
      kind,
      bucket: commaBucket(kind),
      planted: p,
      caught: c,
      surfaced: s,
      recall: (c / p) * 100,
      attentionRecall: (s / p) * 100,
    };
  });
}
