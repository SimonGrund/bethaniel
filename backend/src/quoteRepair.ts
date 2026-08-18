// ── Deterministic quotation-mark repair ──
//
// The publication scan finds unbalanced quotes. Copy edit was expected to fix
// them; measured on three real defects from a live book, it fixed one:
//
//   “We can try.          missing closing mark      → the model fixed it
//   “Good.“               closing mark typed as “   → missed
//   To save you,"         straight mark among curly → missed
//
// The two it misses are unambiguous, which makes them deterministic work rather
// than a prompt to argue with. And the copy-edit prompt deliberately warns the
// model off quotation marks ("NEVER place a quotation mark directly next to an
// existing one"), because it used to splice duplicates against existing ones —
// so pushing harder there would reopen a worse bug.
//
// What is NOT done here: inventing a missing closing mark. Where it belongs is
// a judgement — end of sentence, end of paragraph, before or after the dialogue
// tag — and the model already gets that right. Guessing would splice a quote
// into the middle of someone's prose.

import type { Correction } from "./types.js";

/**
 * Whether each double-quote mark in a paragraph opens a quotation.
 *
 * Decided by alternation, not by the preceding character. The character before
 * a mark cannot tell you: “But sir—” is speech cut off mid-sentence and ends,
 * correctly, with an em-dash and a CLOSING mark. A rule that read the dash as
 * opening context flipped 61 correct marks in one book.
 *
 * State resets at every paragraph, which is also what the continued-speech
 * convention needs: each paragraph of a long speech opens with a mark.
 */
function marksOpen(paragraph: string): boolean[] {
  const out: boolean[] = [];
  let inside = false;
  for (const ch of paragraph) {
    if (ch !== '"' && ch !== "\u201C" && ch !== "\u201D") continue;
    out.push(!inside);
    inside = !inside;
  }
  return out;
}

/** Words of context kept either side, so the pair can be located in the text. */
const CONTEXT_CHARS = 32;

/** Share of marks that must agree before a style counts as the manuscript's. */
const STYLE_MAJORITY = 0.75;

/** Below this many double-quote marks there is no style to infer. */
const MIN_MARKS_TO_JUDGE = 4;

type Style = "curly" | "straight";

/**
 * The manuscript's prevailing double-quote style.
 *
 * Style is the author's choice; only inconsistency is an error. A book set in
 * straight quotes throughout is correct and must be left alone.
 */
function dominantStyle(text: string): Style | null {
  const curly = (text.match(/[“”]/g) ?? []).length;
  const straight = (text.match(/"/g) ?? []).length;
  const total = curly + straight;
  // Too few marks to call it a style. One straight quote in a passage with no
  // others is not evidence of anything, and flipping it would be a guess.
  if (total < MIN_MARKS_TO_JUDGE) return null;
  if (curly / total >= STYLE_MAJORITY) return "curly";
  if (straight / total >= STYLE_MAJORITY) return "straight";
  // Genuinely mixed: the manuscript has no convention to conform to, and
  // picking one would rewrite half the dialogue in the book.
  return null;
}

/**
 * A snippet around an index, trimmed to whole words, WITH the offset of the
 * index inside it.
 *
 * The offset has to travel with the snippet: a passage like “Good.“ contains
 * the same character twice, and locating it by search rewrote the wrong one —
 * turning the correct opening mark into a closing one and leaving the fault.
 */
function contextAround(
  text: string,
  index: number,
  length: number,
): { snippet: string; offset: number } {
  let from = Math.max(0, index - CONTEXT_CHARS);
  let to = Math.min(text.length, index + length + CONTEXT_CHARS);
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space !== -1 && space < index) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space !== -1 && space > index + length) to = space;
  }
  return { snippet: text.slice(from, to), offset: index - from };
}

/**
 * Corrections that make the manuscript's quotation marks internally consistent.
 *
 * Two faults are repaired, both unambiguous:
 *   - a straight mark in a manuscript written in curly ones (and the reverse)
 *   - a curly mark facing the wrong way for its position
 *
 * Apostrophes are untouched: only double quotes are considered.
 *
 * One correction per paragraph, not per mark. A line like `"We can try,"` has
 * two marks to fix, and emitting them separately produced two corrections whose
 * spans overlapped — apply the first and the second no longer matches the text
 * it was cut from. A paragraph is unique enough to locate and cannot collide
 * with its neighbour.
 */
export function getQuoteCorrections(text: string): Correction[] {
  const style = dominantStyle(text);
  if (!style) return [];

  const paragraphs = text.split(/\n\n+/);
  const out: Correction[] = [];

  for (const paragraph of paragraphs) {
    const opens = marksOpen(paragraph);
    // An odd number of marks means the paragraph is genuinely unbalanced —
    // a mark missing, or duplicated text carrying a stray one. Alternation
    // cannot tell WHICH mark is the faulty one, and on a real book it "fixed"
    // the wrong one every time. These are exactly what the publication scan
    // reports, with the passage attached, for a human to look at.
    if (opens.length % 2 !== 0) continue;
    let seen = 0;
    let changed = false;
    // Curly marks facing the wrong way. Converting a straight mark to curly is
    // safe in bulk — the style is not in doubt — but a curly mark pointing the
    // wrong way is a typo, and more than one of them in a paragraph means the
    // fault is something else. "…change of plans. “You are going…criminals.”
    // Couldn't very well…" needs a mark DELETED, not turned round; alternation
    // wanted two flips and would have put an opening mark mid-sentence.
    let orientationFixes = 0;
    const chars = [...paragraph];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch !== '"' && ch !== "\u201C" && ch !== "\u201D") continue;
      const want =
        style === "straight" ? '"' : opens[seen] ? "\u201C" : "\u201D";
      seen++;
      if (ch === want) continue;
      // Refuse a placement the surrounding text contradicts. Two opening marks
      // in a row are malformed, and alternation would turn the second into a
      // closing mark sitting directly against a word — worse than the fault it
      // set out to fix, and not something to guess at.
      // Counted before the veto below: a flip we decline to make is still
      // evidence that the paragraph is not a simple typo.
      if (ch !== '"') orientationFixes++;
      const nextCh = chars[i + 1] ?? "";
      const prevCh = chars[i - 1] ?? "";
      if (want === "\u201D" && /[\p{L}\p{N}]/u.test(nextCh)) continue;
      if (want === "\u201C" && /[\p{L}\p{N}]/u.test(prevCh)) continue;
      chars[i] = want;
      changed = true;
    }
    if (!changed || orientationFixes > 1) continue;
    out.push({
      original: paragraph,
      corrected: chars.join(""),
      kind: "copy",
      confidence: 1,
      note: "Quotation marks made consistent with the rest of the manuscript.",
    } as Correction);
  }

  return out;
}
