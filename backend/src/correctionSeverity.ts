// ── Publication-blocking severity classification ──
// Decides whether a correction is an objective/mechanical error that should
// block publication (spelling, duplicated words/phrases, missing words,
// spacing, wrong punctuation, dialogue-tag punctuation, missing
// articles/prepositions) vs. a subjective style/word-choice suggestion that
// can wait. Reuses tags every correction already carries — editType for
// LLM-authored corrections, reason prefixes for deterministic-checker ones —
// so no source needs to be re-tagged.

import type { Correction, TaskMode } from "./types.js";

// Modes whose LLM prompt is scoped to objective errors only (spelling,
// duplicated words, punctuation, capitalization, dialogue tags — see
// buildCopyEditScope/buildCopyEditCorrectionsPrompt and
// buildProofreadCorrectionsPrompt in prompts.ts). `editType` only
// distinguishes copy vs. line WITHIN a combined_edit task; a single-mode
// task never gets an editType tag at all, so its mode has to stand in.
const OBJECTIVE_SCOPE_MODES: TaskMode[] = ["copy_edit", "proofread", "combined_edit"];

// Reasons that are always a genuine WORD-content change (a misspelling, a
// wrong-dialect spelling, a removed duplicate) — never just punctuation, so
// they skip the punctuation-only downgrade below entirely.
const ALWAYS_BLOCKING_REASONS = new Set([
  "spell-check",
  "dialect",
  "retext:repeated-words",
  "retext:repeated-phrase",
  // A double space is a mechanical typo, not a comma/semicolon judgment
  // call — it doesn't get the punctuation-only reprieve either.
  "retext:sentence-spacing",
]);

/**
 * Whether `original`→`corrected` differs ONLY in punctuation (comma vs.
 * semicolon, period vs. question mark, hyphen vs. space, quote style, ...)
 * with no word added, removed, or changed — case-sensitive, so a real
 * capitalization fix ("took" → "Took") still counts as a content change.
 */
/**
 * Did a deterministic checker produce this correction, rather than a model?
 *
 * Hunspell, LanguageTool, the retext rules and the dialect check all tag their
 * output through `reason`; an LLM-authored correction carries no reason (or a
 * free-text one the model wrote). The distinction matters wherever a model is
 * asked to pass judgement on a correction: a dictionary saying a word does not
 * exist is not an opinion to be out-voted.
 */
export function isDeterministicCorrection(c: Correction): boolean {
  const reason = c.reason ?? "";
  return (
    reason === "spell-check" ||
    // A downgraded spell correction (spellcheck.ts tags an unrecognised
    // word whose suggestion it will not vouch for) is still the dictionary
    // talking, not a model. Leaving it out here handed it straight back to
    // the precision pass to delete — the very thing this guard exists to
    // stop. The tag records lower confidence in the FIX, not doubt about
    // who produced it.
    reason === "spell-check-uncommon" ||
    reason === "dialect" ||
    reason.startsWith("grammar:") ||
    reason.startsWith("retext:")
  );
}

export function isPunctuationOnlyChange(original: string, corrected: string): boolean {
  const stripped = (s: string) =>
    s.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  return stripped(original) === stripped(corrected);
}

const SENTENCE_PUNCT_RE = /[,.!?;:]/g;

/**
 * Whether the fix converts a COMMA into sentence-ending punctuation
 * (period/question/exclamation mark) anywhere in the passage — a comma
 * splice, joining two independent clauses with only a comma. Unlike a
 * period-vs-question-mark swap (a tone/character-voice judgment call), a
 * comma can never correctly join two independent clauses on its own — this
 * is always an objective run-on-sentence error, not a style choice, so it
 * must not get the punctuation-only downgrade.
 *
 * Compares the two punctuation-mark sequences position-by-position rather
 * than requiring exact string alignment, so it still works when other
 * punctuation earlier or later in the same correction differs too. Bails
 * out (assumes no comma splice) if the two sequences have different
 * lengths — that means marks were added/removed, not swapped, which this
 * check isn't trying to reason about.
 */
export function fixesCommaSplice(original: string, corrected: string): boolean {
  const origMarks = original.match(SENTENCE_PUNCT_RE) ?? [];
  const corrMarks = corrected.match(SENTENCE_PUNCT_RE) ?? [];
  if (origMarks.length !== corrMarks.length) return false;
  return origMarks.some(
    (mark, i) => mark === "," && (corrMarks[i] === "." || corrMarks[i] === "!" || corrMarks[i] === "?"),
  );
}

// ── What "blocks publication" means ──
//
// A blocker is a fault any reader would take for a typo: a non-word, a
// doubled word, a double space, a missing apostrophe, a wrong inflection.
// Measured on a real 32-chapter scan, the old rule — every word-changing
// correction from the objective-scope passes — marked 972 of 1,139
// corrections as blocking, 164 of them with a reviewer's backing. Reading
// them, almost none were: LanguageTool's spell rule splitting invented names
// ("Silverhand" → "Silver hand", 40 times), the model lower-casing a term
// the author capitalises on purpose ("Taking" → "taking"), chapter headings
// re-cased, compounds split ("woodchips" → "wood chips"), dialect in speech
// "fixed", and rewrites that are opinions ("room" → "door"). The same rule
// applied here leaves five. Everything demoted is still listed, per chapter,
// as minor — a reader's judgement, not a gate.

export interface SeverityContext {
  /** The chapter the correction came from, to tell speech from narration. */
  text?: string;
  /** Capitalised words spelled the same way at least three times across the
   *  manuscript: names and invented terms, which no dictionary knows. */
  consistentTerms?: ReadonlySet<string>;
}

/** Capitalised words that recur, spelled identically, across the given
 *  texts — the manuscript's own vocabulary. Collected once per job in
 *  routes.ts and carried on every chapter task. */
export function collectConsistentTerms(texts: readonly string[], min = 3): string[] {
  const freq = new Map<string, number>();
  for (const text of texts) {
    for (const w of text.match(/[\p{L}\p{N}'\u2019-]+/gu) ?? []) {
      if (!/^\p{Lu}/u.test(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()].filter(([, n]) => n >= min).map(([w]) => w);
}

const tokensOf = (s: string): string[] =>
  s.replace(/\u2019/g, "'").match(/[\p{L}\p{N}'-]+/gu) ?? [];

/** The words a correction removes and the words it puts in, with the
 *  unchanged run either side stripped — so a fix quoted with a sentence of
 *  context is judged on the word it actually changes. */
export function changedWords(c: { original: string; corrected: string }): {
  del: string[];
  ins: string[];
} {
  const a = tokensOf(c.original);
  const b = tokensOf(c.corrected);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { del: a.slice(i, a.length - j), ins: b.slice(i, b.length - j) };
}

/** Whether the snippet's first occurrence sits inside quoted speech: an odd
 *  number of double-quote marks between the start of its paragraph and it.
 *  Speech is voice — dialect, elision, a character's grammar — and a scan
 *  has no business calling it an error. */
export function inDialogue(text: string | undefined, snippet: string): boolean {
  if (!text) return false;
  const pos = text.indexOf(snippet);
  if (pos < 0) return false;
  const paraStart = text.lastIndexOf("\n", pos) + 1;
  const marks = text.slice(paraStart, pos).match(/[\u201C\u201D"]/g) ?? [];
  return marks.length % 2 === 1;
}

const onlySpacingOrHyphen = (c: Correction) =>
  c.original.replace(/[\s\u00AD-]+/g, "") === c.corrected.replace(/[\s\u00AD-]+/g, "");
const onlyDiacritics = (c: Correction) =>
  c.original.normalize("NFD").replace(/[\u0300-\u036f]/g, "") ===
  c.corrected.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const casingOnly = (c: Correction) => c.original.toLowerCase() === c.corrected.toLowerCase();

/** Edit distance with an adjacent swap counting as one: "teh" → "the" is a
 *  slip of one keystroke, not two. */
function editDistance(x: string, y: string): number {
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[x.length][y.length];
}

/** The reviewer's score and the second check's, multiplied, on 0–100 —
 *  the same figure the review screen shows. */
function certainty(c: Correction): number | null {
  if (c.confidence == null) return null;
  return Math.round((c.confidence / 5) * ((c.precisionConfidence ?? 5) / 5) * 100);
}

const FUNCTION_WORDS = new Set([
  "a", "an", "the", "to", "of", "in", "is", "was", "it", "and", "at", "on", "he", "she", "i", "be", "had", "has",
]);

/** LanguageTool categories whose hits can be real errors rather than
 *  advice — but only when the fix is a mechanical one (below). Style,
 *  collocations, redundancy, casing and the rest are suggestions always. */
const MECHANICAL_LT_CATEGORIES = new Set([
  "grammar:grammar",
  "grammar:agreement",
  "grammar:confused_words",
  "grammar:comma-splice",
]);

/**
 * A small mechanical edit — the shape of a typo being fixed, as opposed to a
 * sentence being rewritten: one word respelled with mostly the same letters
 * ("recieved" → "received", "rung" → "rang"; not "room" → "door"), an
 * apostrophe added or dropped, a doubled word removed, or one short
 * function word added or dropped ("there has be" → "there has to be").
 */
function isMechanicalEdit(del: string[], ins: string[]): boolean {
  if (del.length === 2 && ins.length === 1 && del[0].toLowerCase() === del[1].toLowerCase()) {
    return true;
  }
  if (del.length > 1 || ins.length > 1) return false;
  if (del.length === 1 && ins.length === 1) {
    const a = del[0];
    const b = ins[0];
    if (a.startsWith("'") || b.startsWith("'")) return false; // 'er, 'ave: dialect
    if (a.replace(/'/g, "") === b.replace(/'/g, "")) return true;
    const budget = Math.max(1, Math.floor(Math.max(a.length, b.length) / 4));
    return editDistance(a.toLowerCase(), b.toLowerCase()) <= budget;
  }
  const w = (del[0] ?? ins[0] ?? "").toLowerCase();
  return FUNCTION_WORDS.has(w);
}

/**
 * Whether a correction is a publication blocker — see the note above.
 *
 * Deterministic non-word hits (the dictionary, LanguageTool's spell rule)
 * block unless they touch the manuscript's own vocabulary, only re-space,
 * re-hyphenate, re-accent or re-case a word, sit inside speech, or were
 * scored down by the second check. Doubled words and double spaces always
 * block. LanguageTool's grammar, agreement and confused-word hits block when
 * the fix is a mechanical one; its other categories — style, collocations,
 * redundancy, casing — are suggestions, never blockers.
 *
 * A model-authored correction blocks only when both scores back it (80% or
 * more) AND it is a mechanical edit. A rewrite, a swap of one word for
 * another, a re-casing, anything in speech: minor.
 */
export function classifyPublicationBlocking(
  c: Correction,
  mode: TaskMode,
  ctx: SeverityContext = {},
): boolean {
  const reason = c.reason ?? "";
  const { del, ins } = changedWords(c);
  const terms = ctx.consistentTerms;
  // The word being replaced is one the manuscript vouches for. (A fix that
  // lands ON a known term — "Silverhnad" → "Silverhand" — is the opposite
  // case, a typo of a name, and stays a blocker.)
  const touchesTerm = !!terms && del.some((w) => terms.has(w));
  const speech = inDialogue(ctx.text, c.original);
  // The second check, where it ran, saying the fix is wrong.
  const secondCheckDoubts = c.precisionConfidence != null && c.precisionConfidence < 3;
  const apostropheOnly =
    del.length === 1 && ins.length === 1 && del[0].replace(/'/g, "") === ins[0].replace(/'/g, "");

  if (reason === "retext:repeated-words" || reason === "retext:sentence-spacing") return true;
  if (reason === "retext:repeated-phrase") return !secondCheckDoubts;
  if (reason === "dialect") return true;

  if (reason === "spell-check" || reason === "grammar:typos") {
    if (touchesTerm && !apostropheOnly) return false;
    if (onlySpacingOrHyphen(c) || onlyDiacritics(c) || casingOnly(c)) return false;
    if (speech || secondCheckDoubts) return false;
    return true;
  }
  if (reason.startsWith("grammar:") || reason.startsWith("retext:")) {
    if (speech || secondCheckDoubts) return false;
    if (isPunctuationOnlyChange(c.original, c.corrected)) {
      return fixesCommaSplice(c.original, c.corrected);
    }
    if (!MECHANICAL_LT_CATEGORIES.has(reason)) return false;
    if (touchesTerm && !apostropheOnly) return false;
    return isMechanicalEdit(del, ins);
  }
  // "spell-check-uncommon" and any other tagged source: a suggestion.
  if (reason) return false;

  // Model-authored. editType (set only by combined_edit's "kind" field)
  // wins when present; otherwise the task's own mode says whether its
  // prompt was scoped to objective errors.
  if (c.editType === "line") return false;
  if (c.editType !== "copy" && !OBJECTIVE_SCOPE_MODES.includes(mode)) return false;

  // A model's claim gates publication only once a reviewer has backed it:
  // unscored, it is a suggestion like any other.
  const sure = certainty(c);
  if (sure === null || sure < 80) return false;
  if (speech) return false;
  // A comma splice is the one punctuation-only change that is an error.
  if (isPunctuationOnlyChange(c.original, c.corrected)) {
    return fixesCommaSplice(c.original, c.corrected);
  }
  if (casingOnly(c)) return false;
  if (touchesTerm && !apostropheOnly) return false;
  return isMechanicalEdit(del, ins);
}
