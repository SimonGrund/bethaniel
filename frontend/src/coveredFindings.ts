// ── A finding with no fix, where a real fix already is ──
//
// The deck's copy of the backend's dropCoveredFindings (correctionHygiene.ts),
// for results saved before that pass existed. The spell layer reports a word
// it cannot place and proposes nothing (`sworddancers` -> `sworddancers`);
// LanguageTool fixes the same word in a longer span (`swift sworddancers of`
// -> `swift sword dancers of`). The author answered the fix and was then asked
// about the word they had just fixed, with "Add to dictionary" under it.
//
// A finding is covered only when EVERY occurrence of its word sits inside a
// fix that changes it, and a fix the reviewer rejected outright (held back
// from the deck) covers nothing, nor does one that only changes the word's
// case. Keep the two copies in step.
//
// Pure, and tested from backend/test/coveredFindings.test.ts because the
// frontend has no test runner.

import { REVIEWER_REJECTED_SCORE } from "./deckProgress";

interface Span {
  original: string;
  corrected: string;
  confidence?: number;
}

const WORD_CHAR = /[\p{L}\p{N}_'’-]/u;

/** Occurrences of `needle` in `text` not glued to a neighbouring word. */
function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = -1;
  while ((i = text.indexOf(needle, i + 1)) !== -1) {
    const before = i > 0 ? text[i - 1] : "";
    const after = text[i + needle.length] ?? "";
    const startsWord = WORD_CHAR.test(needle[0]);
    const endsWord = WORD_CHAR.test(needle[needle.length - 1]);
    if (startsWord && before && WORD_CHAR.test(before)) continue;
    if (endsWord && after && WORD_CHAR.test(after)) continue;
    out.push(i);
  }
  return out;
}

export function isNoFixFinding(c: Span): boolean {
  return c.original.trim() !== "" && c.original.trim() === c.corrected.trim();
}

/** The corrections without the no-fix findings another fix already answers. */
export function dropCoveredFindings<T extends Span>(text: string, corrections: T[]): T[] {
  if (!corrections.some(isNoFixFinding)) return corrections;
  const fixes = corrections.filter(
    (c) => !isNoFixFinding(c) && c.confidence !== REVIEWER_REJECTED_SCORE,
  );
  return corrections.filter((c) => {
    if (!isNoFixFinding(c)) return true;
    const word = c.original.trim();
    const at = occurrences(text, word);
    if (at.length === 0) return true;
    const spans: [number, number][] = [];
    for (const f of fixes) {
      // Case is not a fix: "you guys" -> "you Guys" leaves the question open.
      if (occurrences(f.corrected.toLowerCase(), word.toLowerCase()).length > 0) continue;
      for (const p of occurrences(text, f.original)) spans.push([p, p + f.original.length]);
    }
    return !at.every((p) => spans.some(([s, e]) => p >= s && p + word.length <= e));
  });
}
