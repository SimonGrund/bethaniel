// ── Finding a correction in its chapter ──
//
// The review shows every correction in the sentence it came from, and lists
// corrections in the order they occur. Both need the correction's text found
// in the chapter, and a model does not quote verbatim: a heading and the line
// after it come back joined by one newline where the manuscript has a blank
// line, and curly quotes come back straight. A literal indexOf then fails,
// the context is empty, and the author is handed "Twenty-two EmberMother's"
// and nothing else — which is exactly what happened.

/**
 * Find a correction's text in the chapter, tolerating what a model does to
 * whitespace when it quotes: a heading and the line after it come back
 * joined by one newline where the manuscript has a blank line. Whitespace
 * runs match any whitespace, straight and curly quotes match each other.
 * Falls back to the last line of a multi-line quote, then to its longest
 * word, so a correction is placed somewhere near rather than nowhere.
 */
export function locateInText(
  original: string,
  fullText: string,
  startIndex = 0,
): { index: number; length: number } | null {
  const exact = fullText.indexOf(original, startIndex);
  if (exact >= 0) return { index: exact, length: original.length };
  const pattern = (text: string) =>
    text
      .trim()
      .split(/\s+/)
      .map((w) =>
        w
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/['’‘]/g, "['’‘]")
          .replace(/["“”]/g, "[\"“”]"),
      )
      .join("\\s+");
  const attempts = [original];
  const lines = original.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) attempts.push(lines[lines.length - 1]);
  const longest = original.match(/[\p{L}'’-]{6,}/gu)?.sort((a, b) => b.length - a.length)[0];
  if (longest) attempts.push(longest);
  for (const candidate of attempts) {
    if (!candidate.trim()) continue;
    try {
      const re = new RegExp(pattern(candidate), "gu");
      re.lastIndex = startIndex;
      const m = re.exec(fullText);
      if (m) return { index: m.index, length: m[0].length };
    } catch {
      // An unbuildable pattern: try the next, shorter candidate.
    }
  }
  return null;
}

/** Corrections in the order they occur in the chapter; unplaceable ones
 *  last, in the order they came. */
export function inTextOrder<T extends { original: string }>(corrections: T[], fullText: string): T[] {
  return corrections
    .map((c, i) => ({ c, i, at: locateInText(c.original, fullText)?.index ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.c);
}
