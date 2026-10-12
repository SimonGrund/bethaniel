// ── The author's own text, in place of Betty's ──
//
// A card has three answers: take Betty's change, leave the text as it was, or
// write something else. The third used to exist only on a finding that
// proposed nothing (a word the spell-checker did not know), and it amended
// the correction in the task's result — which is not persisted. After a
// restart the result came back from the backend with Betty's text in it and
// the acceptance still ticked, so the export would have applied the very
// change the author had rewritten.
//
// So the author's text is kept on its own, persisted beside the acceptances,
// and laid over every result as it arrives. Betty's proposal is kept on the
// correction as `suggested`, so the review table can show both and Back can
// put the card back as it was.
//
// Pure; tested from backend/test/authorFixes.test.ts.

import type { Correction, TaskResult } from "./types";

/** taskId → correctionId → the author's replacement for `original`. */
export type AuthorFixes = Record<string, Record<string, string>>;

export const AUTHOR_FIX_REASON = "author-correction";

/** One correction with the author's text over Betty's. */
export function withAuthorFix(c: Correction, fix: string): Correction {
  return {
    ...c,
    // Kept from the first amendment: a second edit of the same card is still
    // an edit of what Betty proposed, not of the author's own first try.
    suggested: c.suggested ?? c.corrected,
    suggestedReason: c.reason === AUTHOR_FIX_REASON ? c.suggestedReason : c.reason,
    corrected: fix,
    reason: AUTHOR_FIX_REASON,
    flagged: false,
    // "No replacement is proposed" — and any other note of the reviewer's —
    // was about Betty's text, which is no longer the one being applied.
    reviewReason: undefined,
  };
}

/** Betty's correction again, as it was before the author wrote over it. */
export function withoutAuthorFix(c: Correction): Correction {
  if (c.reason !== AUTHOR_FIX_REASON || c.suggested === undefined) return c;
  const { suggested, suggestedReason, ...rest } = c;
  return { ...rest, corrected: suggested, reason: suggestedReason };
}

/** A result with the author's text laid over the corrections it rewrote. */
export function applyAuthorFixes(
  result: TaskResult,
  fixes: Record<string, string> | undefined,
): TaskResult {
  if (!fixes || Object.keys(fixes).length === 0) return result;
  let touched = false;
  const corrections = result.corrections.map((c) => {
    const fix = c.id ? fixes[c.id] : undefined;
    if (fix === undefined || (c.reason === AUTHOR_FIX_REASON && c.corrected === fix)) return c;
    touched = true;
    return withAuthorFix(c, fix);
  });
  return touched ? { ...result, corrections } : result;
}
