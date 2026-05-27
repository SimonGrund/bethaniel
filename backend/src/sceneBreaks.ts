// ── Scene-break detection and normalization ──
//
// Authors use many different conventions for scene/section breaks in their
// manuscripts. Common patterns include:
//   ***            (markdown horizontal rule)
//   * * *
//   ---
//   ___
//   \*             (escaped asterisk — common when DOCX→markdown converts a
//                  centered "*" character that the converter then escapes)
//   \* \* \*
//   #              (single hash on its own line — sometimes used as a divider,
//                  but careful: # is also a markdown heading marker)
//   ◇  ❖  ✦  •     (special unicode glyphs)
//
// Strategy on upload:
//   1. Find all short standalone lines that look like dividers.
//   2. If any specific divider line appears 2+ times, treat it as a scene break.
//   3. Replace every occurrence with a canonical marker.
//   4. The DOCX exporter then renders the canonical marker according to user choice.

export const SCENE_BREAK_MARKER = "<!-- SCENE_BREAK -->";

/**
 * A line is a "candidate" scene-break if it's short, standalone, and contains
 * only typographic separator characters (no letters/digits).
 */
const DIVIDER_CHAR_RE = /^[\s*_\-#~=•◇◆❖✦✧✺❉⁂※·\\]+$/;

function isDividerCandidate(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 30) return false;
  // Must contain at least one separator char (not just whitespace)
  if (!/[*_\-#~=•◇◆❖✦✧✺❉⁂※·\\]/.test(t)) return false;
  return DIVIDER_CHAR_RE.test(t);
}

/**
 * Detect repeated divider lines and replace them with SCENE_BREAK_MARKER.
 * Returns the normalized text plus the detected pattern (for diagnostics).
 *
 * A divider qualifies only if:
 *   - The exact line (trimmed) appears 2+ times, OR
 *   - It's a well-known unambiguous pattern like `***`, `* * *`, `\*`, `---`.
 */
export function normalizeSceneBreaks(text: string): {
  text: string;
  detectedPattern: string | null;
  count: number;
} {
  const lines = text.split("\n");
  const counts: Record<string, number> = {};

  for (const line of lines) {
    if (!isDividerCandidate(line)) continue;
    // Skip pure markdown headings (e.g. "# " with content already handled by
    // heading regex elsewhere — but a bare "#" with no following text is a
    // divider candidate).
    const t = line.trim();
    counts[t] = (counts[t] ?? 0) + 1;
  }

  // Well-known unambiguous divider patterns — qualify even on first occurrence.
  const WELL_KNOWN = new Set([
    "***",
    "* * *",
    "\\*\\*\\*",
    "\\* \\* \\*",
    "\\*",
    "---",
    "___",
    "* \\* *",
  ]);

  const qualified = new Set<string>();
  for (const [pattern, n] of Object.entries(counts)) {
    if (n >= 2 || WELL_KNOWN.has(pattern)) {
      qualified.add(pattern);
    }
  }

  if (qualified.size === 0) {
    return { text, detectedPattern: null, count: 0 };
  }

  // Replace each qualified divider line with the canonical marker.
  let replacedCount = 0;
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (qualified.has(t)) {
      out.push(SCENE_BREAK_MARKER);
      replacedCount++;
    } else {
      out.push(line);
    }
  }

  // For diagnostics, report the most common detected pattern.
  const sortedPatterns = [...qualified].sort(
    (a, b) => (counts[b] ?? 0) - (counts[a] ?? 0),
  );
  return {
    text: out.join("\n"),
    detectedPattern: sortedPatterns[0] ?? null,
    count: replacedCount,
  };
}

/**
 * Detect the paragraph (small) break style used in a manuscript.
 *
 * After scene breaks have been normalized, look for any remaining short
 * standalone divider lines that occur between paragraphs. If none, the
 * paragraph break is just an empty line (the markdown default).
 *
 * Returns a human-readable label: "empty line" or the marker string itself
 * (e.g. "#", "•").
 */
export function detectParagraphBreak(text: string): string {
  const lines = text.split("\n");
  const counts: Record<string, number> = {};

  for (const line of lines) {
    const t = line.trim();
    if (t === SCENE_BREAK_MARKER) continue;
    if (!isDividerCandidate(line)) continue;
    // Skip anything that looks like a markdown heading marker (lines starting
    // with `#` followed by a space are headings, handled elsewhere; bare `#`
    // alone IS a candidate here).
    counts[t] = (counts[t] ?? 0) + 1;
  }

  // Find the most common remaining standalone divider, if any appears 2+ times.
  let best: string | null = null;
  let bestCount = 1;
  for (const [pat, n] of Object.entries(counts)) {
    if (n >= 2 && n > bestCount) {
      best = pat;
      bestCount = n;
    }
  }

  return best ?? "empty line";
}
