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

/**
 * A hunspell/retext/languagetool hit is a much weaker "this is definitely
 * wrong" signal than an outright non-word — the dictionary doesn't enumerate
 * every valid compound or uncommon-but-real inflection, so those are tagged
 * "spell-check-uncommon" (see spellcheck.ts) rather than the plain
 * "spell-check" reason, and treated as non-blocking here.
 *
 * A comma/semicolon/period/quote-style judgment call — one that doesn't add,
 * remove, or change any actual word — is a copy-edit-level polish decision,
 * not an unambiguous publication blocker: these are common enough in bulk
 * that treating every one as a hard "must fix" buries the real issues (a
 * missing word, a duplicated phrase, a genuine misspelling). Downgraded to
 * non-blocking regardless of source, except the reasons in
 * ALWAYS_BLOCKING_REASONS (never "just punctuation" by construction) and a
 * comma-splice fix (comma → sentence-ending mark): unlike swapping one
 * terminal mark for another, a bare comma can never correctly join two
 * independent clauses, so that specific fix is always an objective
 * run-on-sentence error, not a style call, and stays blocking.
 */
export function classifyPublicationBlocking(c: Correction, mode: TaskMode): boolean {
  const reason = c.reason ?? "";
  if (ALWAYS_BLOCKING_REASONS.has(reason)) return true;

  // A punctuation-only fix is downgraded to non-blocking UNLESS it's a comma
  // splice (comma → sentence-ending mark) — that's never just a style call.
  const punctuationOnly =
    isPunctuationOnlyChange(c.original, c.corrected) &&
    !fixesCommaSplice(c.original, c.corrected);

  // Deterministic checkers (spell-check, retext, LanguageTool) never carry an
  // editType — that's an LLM-only "kind" tag — so their own reason decides
  // their severity, regardless of the task's mode. Checking this first
  // matters: falling through to the mode-based rule below would treat every
  // deterministic hit in an objective-scope task as blocking.
  if (reason.startsWith("retext:") || reason.startsWith("grammar:")) {
    return !punctuationOnly;
  }
  if (reason) return false;

  // No deterministic-checker reason — this is LLM-authored. editType (set
  // only by combined_edit's "kind" field) wins when present; otherwise the
  // task's own mode tells us whether its prompt was objective-scoped, since
  // a single-mode task never gets an editType tag at all.
  if (c.editType === "line") return false;
  if (c.editType === "copy" || OBJECTIVE_SCOPE_MODES.includes(mode)) {
    return !punctuationOnly;
  }
  return false;
}
