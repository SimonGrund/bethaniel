// ── Where a correction lands in a chapter, and how ──
//
// Pure: no network, no store. Shared by the export (exportVerify.ts), which
// applies the accepted corrections, and by Review in Word (reviewInWord.ts),
// which applies every open suggestion — so both land a correction in exactly
// the same place.

// Word-boundary helpers mirroring the backend's applyCorrections semantics:
// a letter/digit at a match edge must not butt against a word character in
// the surrounding text. This covers bare words ("hadn" → "hadj" must never
// splice into "hadn’t") AND multi-word originals ("the student" must not
// match the prefix of "the students" — that splice produced "studentss").
// Apostrophes — straight and typographic — count as word characters so
// contractions are single words; edges that are themselves punctuation
// (quotes, dashes) carry no boundary requirement.
const WORD_CHAR_RE = /[\p{L}\p{N}'’ʼ-]/u;
const EDGE_ALNUM_RE = /[\p{L}\p{N}]/u;

function hasCleanEdgesAt(text: string, pos: number, search: string): boolean {
  if (search.length === 0) return false;
  if (EDGE_ALNUM_RE.test(search[0])) {
    const before = pos > 0 ? text[pos - 1] : "";
    if (before && WORD_CHAR_RE.test(before)) return false;
  }
  if (EDGE_ALNUM_RE.test(search[search.length - 1])) {
    const after = pos + search.length < text.length ? text[pos + search.length] : "";
    if (after && WORD_CHAR_RE.test(after)) return false;
  }
  return true;
}

/**
 * Find all occurrences of `search` in `text`, returning their start indices.
 * Matches with dirty word edges (mid-word splices) are neither listed in the
 * review UI nor replaced on export.
 */
export function findAllOccurrences(text: string, search: string): number[] {
  const indices: number[] = [];
  let idx = -1;
  while ((idx = text.indexOf(search, idx + 1)) !== -1) {
    if (hasCleanEdgesAt(text, idx, search)) {
      indices.push(idx);
    }
  }
  return indices;
}

// Seam-punctuation rules mirroring the backend's applyCorrections:
//  - a correction whose `corrected` ends with a mark the text already has
//    right after the match must not splice a duplicate ("shoulder..");
//  - a correction that strips a paragraph-final terminal mark gets it back
//    ("…a forced smile." → "…a forced smile" would end the paragraph on a
//    bare word). Rewrites ending in other punctuation ("and—.") pass.
const SEAM_PUNCT_RE = /[.,;:!?]/;
const TERMINAL_END_RE = /[.!?…]$/;
const BARE_WORD_END_RE = /[\p{L}\p{N}]$/u;

export function adjustSeamPunctuation(
  text: string,
  index: number,
  original: string,
  corrected: string,
): string {
  const last = corrected[corrected.length - 1] ?? "";
  if (
    SEAM_PUNCT_RE.test(last) &&
    !original.endsWith(last) &&
    text[index + original.length] === last
  ) {
    corrected = corrected.slice(0, -1);
  }
  const first = corrected[0] ?? "";
  if (
    SEAM_PUNCT_RE.test(first) &&
    !original.startsWith(first) &&
    index > 0 &&
    text[index - 1] === first
  ) {
    corrected = corrected.slice(1);
  }
  if (TERMINAL_END_RE.test(original) && BARE_WORD_END_RE.test(corrected)) {
    const after = text[index + original.length];
    if (after === undefined || after === "\n" || after === "\r") {
      corrected += original[original.length - 1];
    }
  }
  return corrected;
}
