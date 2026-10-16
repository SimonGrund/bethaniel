// The word diff the review screens draw a change with: tokens, then a true
// minimal edit script between them. Shared by InlineDiff (ReviewExport.tsx)
// and DeckPassage, and free of the app's state so either can be rendered on
// its own.

/** The word tokens InlineDiff compares: runs of space, of word characters,
 *  and single punctuation marks. */
export function diffWords(text: string): string[] {
  return text.match(/\s+|\w+|[^\w\s]/g) ?? [];
}

/**
 * What a change that is only whitespace looks like on the page: "␣" for each
 * space, "↵" for each line break; null when the text is not all whitespace.
 * Struck through and padded, a deleted space drew a red pill with a dash in
 * it — read as a hyphen, and worst exactly where a space is swapped for a
 * hyphen ("line break" → "line-break"), where it looked like nothing changed.
 */
export function whitespaceMark(text: string): string | null {
  if (!text || /\S/.test(text)) return null;
  return text.replace(/\r?\n/g, "↵").replace(/[^\S\n]/g, "␣");
}

/**
 * True minimal word-level diff via LCS (dynamic programming), not a greedy
 * "look ahead" heuristic. The greedy version degenerates on a long passage
 * with several SCATTERED changes of the same token (e.g. two "?"→"." swaps
 * in one sentence): each mismatch searches for its own word anywhere ahead
 * and can end up deleting/inserting a whole run between them, making the
 * diff read as if most of the sentence changed. LCS finds the true minimal
 * edit script, so only the tokens that actually differ are marked.
 *
 * Capped at 200k table cells (~450 words per side) — a correction that long
 * is rare, and past that the O(n·m) table isn't worth the memory/time; it
 * falls back to one delete-block + one insert-block instead of hanging.
 */
export function diffTokens(
  aWords: string[],
  bWords: string[],
): { type: "equal" | "del" | "ins"; text: string }[] {
  const n = aWords.length;
  const m = bWords.length;
  const parts: { type: "equal" | "del" | "ins"; text: string }[] = [];

  if (n * m > 200_000) {
    for (const w of aWords) parts.push({ type: "del", text: w });
    for (const w of bWords) parts.push({ type: "ins", text: w });
    return parts;
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        aWords[i] === bWords[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aWords[i] === bWords[j]) {
      parts.push({ type: "equal", text: aWords[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      parts.push({ type: "del", text: aWords[i] });
      i++;
    } else {
      parts.push({ type: "ins", text: bWords[j] });
      j++;
    }
  }
  while (i < n) parts.push({ type: "del", text: aWords[i++] });
  while (j < m) parts.push({ type: "ins", text: bWords[j++] });
  return parts;
}
