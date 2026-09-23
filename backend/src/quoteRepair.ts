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
import {
  expectedRoles,
  readMarks,
  resolveConvention,
  type QuoteStyle,
} from "./quoteMarks.js";

/** Words of context kept either side, so the pair can be located in the text. */
const CONTEXT_CHARS = 32;

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
 * Corrections for curly quotation marks facing the wrong way for their
 * position — “Good.“ — in a manuscript written in curly marks.
 *
 * That is the one fault repaired. A straight mark among curly ones used to
 * be converted too, and is no longer: straight or curly is the author's
 * choice (or their word processor's), not an error, and a run that turned
 * up dozens of “fixes” to quotation marks read as noise to the author whose
 * book it was. Straight marks are left exactly as typed, everywhere.
 *
 * Apostrophes are untouched: only double quotes are considered.
 *
 * One correction per paragraph, not per mark. A line like `"We can try,"` has
 * two marks to fix, and emitting them separately produced two corrections whose
 * spans overlapped — apply the first and the second no longer matches the text
 * it was cut from. A paragraph is unique enough to locate and cannot collide
 * with its neighbour.
 */
export function getQuoteCorrections(
  text: string,
  declared?: QuoteStyle | null,
): Correction[] {
  const convention = resolveConvention(text, declared);
  const style = convention.style;
  // No convention to conform to and no orientation to judge: a manuscript in
  // straight quotes has no wrong-way marks, and one with no clear style has
  // nothing to be normalised towards.
  if (!style) return [];

  const out: Correction[] = [];

  for (const paragraph of text.split(/\n\n+/)) {
    const marks = readMarks(paragraph, convention);
    if (marks.length === 0) continue;
    // An odd number of marks means the paragraph is genuinely unbalanced —
    // a mark missing, or duplicated text carrying a stray one. Alternation
    // cannot tell WHICH mark is the faulty one, and on a real book it "fixed"
    // the wrong one every time. These are exactly what the publication scan
    // reports, with the passage attached, for a human to look at.
    if (marks.length % 2 !== 0) continue;

    // What each mark SHOULD be, by position. Not what readMarks says it IS:
    // this pass repairs marks whose character is wrong, and reading the
    // character would only confirm the typo. See expectedRoles.
    const want = expectedRoles(marks);
    const chars = [...paragraph];
    let restyled = false;
    // A curly mark pointing the wrong way is a typo, and more than one of
    // them in a paragraph means the fault is something else. "…change of
    // plans. “You are going…criminals.” Couldn't very well…" needs a mark
    // DELETED, not turned round; alternation wanted two flips and would have
    // put an opening mark mid-sentence. One is a typo; two is a different
    // defect, and the whole paragraph is left for a human.
    let orientationFixes = 0;

    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const wantChar =
        style === "straight"
          ? '"'
          : want[i] === "open"
            ? convention.family.open
            : convention.family.close;
      if (m.char === wantChar) continue;
      const at = codePointIndex(paragraph, m.index);
      // A mark of the wrong STYLE is normalised outright: the style is not in
      // doubt, and its role comes from the same alternation as everything
      // else. A mark of the right style facing the wrong way is a typo, and
      // is held to the vetoes below.
      const wrongStyle = (m.char === '"') !== (style === "straight");
      if (wrongStyle) {
        chars[at] = wantChar;
        restyled = true;
        continue;
      }
      // Counted before the vetoes: a flip we decline to make is still
      // evidence that the paragraph is not a simple typo.
      orientationFixes++;
      const nextCh = chars[at + 1] ?? "";
      const prevCh = chars[at - 1] ?? "";
      // Refuse a placement the surrounding text contradicts. Two opening marks
      // in a row are malformed, and alternation would turn the second into a
      // closing mark sitting directly against a word — worse than the fault it
      // set out to fix, and not something to guess at.
      if (wantChar === convention.family.close && /[\p{L}\p{N}]/u.test(nextCh)) {
        continue;
      }
      if (wantChar === convention.family.open && /[\p{L}\p{N}]/u.test(prevCh)) {
        continue;
      }
      chars[at] = wantChar;
    }

    if (orientationFixes > 1) continue;
    const corrected = chars.join("");
    if (corrected === paragraph) continue;

    // One correction per paragraph, never one per mark. A line like
    // `"We can try,"` has two marks to fix, and emitting them separately
    // produced two corrections whose spans overlapped — apply the first and
    // the second no longer matches the text it was cut from. A paragraph is
    // unique enough to locate and cannot collide with its neighbour.
    //
    // A paragraph that needed both kinds of repair is reported as a style
    // one: the author answers the style question once for the whole book,
    // and a wrong-way mark inside such a paragraph rides along with it.
    out.push(
      restyled
        ? ({
            original: paragraph,
            corrected,
            kind: "copy",
            confidence: 1,
            // The manuscript's own convention decides this, so there is no
            // judgement for a reviewer to add and no tokens to spend on one.
            preApproved: true,
            reason: "quote-style",
            note: "A quotation mark that is not the style this book uses.",
          } as Correction)
        : ({
            original: paragraph,
            corrected,
            kind: "copy",
            confidence: 1,
            note: "A quotation mark facing the wrong way.",
          } as Correction),
    );
  }

  return out;
}

/** `readMarks` reports UTF-16 indexes; `[...paragraph]` is code points. This
 *  converts one to the other so a surrogate pair earlier in the paragraph
 *  cannot shift which character gets rewritten. */
function codePointIndex(paragraph: string, utf16Index: number): number {
  let cp = 0;
  let i = 0;
  for (const ch of paragraph) {
    if (i >= utf16Index) break;
    i += ch.length;
    cp++;
  }
  return cp;
}
