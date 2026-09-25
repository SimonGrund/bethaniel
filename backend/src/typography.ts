// ── The typographic marks that are not quotation marks ──
//
// `quoteMarks.ts` reads the book's double-quote convention and says nothing
// about anything else, which left the commonest typographic defect in a
// finished manuscript unreported. Measured on two real books:
//
//   Rage of the Rule     1,250 curly apostrophes,  93 straight
//   Path of the Taker    1,955 curly apostrophes,  67 straight
//
// `the young boy's devotion`, `we don't make it home` — straight apostrophes
// in books that are curly everywhere else. Seven per cent and three per cent
// is nobody's house style; it is what survives a paste from a plain-text
// editor. It is invisible on screen at body size and plain in print, which
// is the worst combination a publication check can leave alone. (It also
// turned up a real defect neither author had seen: `the children's’ eager to
// get started`, an apostrophe typed twice.)
//
// The same reading answers three more questions of the same kind: ellipses
// typed as three dots in a book that uses the character, characters that
// occupy space but cannot be seen, and drafting placeholders left in.
//
// Two rules hold this file together.
//
// The style is the manuscript's, never a preference of ours. A book set in
// straight apostrophes throughout is correct and must be left alone, exactly
// as `detectDominantStyle` treats quotation marks. Only inconsistency is a
// finding.
//
// And a finding is reported ONCE with a count, never once per instance.
// Ninety-three straight apostrophes is one decision applied ninety-three
// times; listing them separately would bury every other finding on the page
// and — before the info band was capped — would have dragged a clean book
// into the red for a single paste.

import type { Correction } from "./types.js";
import type { QuoteStyle } from "./quoteMarks.js";

/** Curly or straight, the same two answers quotation marks have. */
export type ApostropheStyle = QuoteStyle;

/** Whether the book writes an ellipsis as `…` or as three dots. */
export type EllipsisStyle = "character" | "dots";

export type TypographyKind =
  | "apostrophe-style"
  | "ellipsis-style"
  | "invisible-character"
  | "placeholder";

export interface TypographyIssue {
  kind: TypographyKind;
  /** How many instances — the finding is reported once, with this number. */
  count: number;
  /** One of them, in enough surrounding text to be found in the manuscript. */
  example: string;
  /** Every one of them: where it starts in the text searched, and how long
   *  the mark is — so the scan can say which chapter each is in. */
  positions: { index: number; length: number }[];
  /** For the two style checks: what the rest of the book does. */
  expected?: string;
  /** For placeholders: the distinct markers found, for the message. */
  markers?: string[];
}

// ── Apostrophes ──
//
// Three positions, and they are not equally safe to judge.
//
// Between two letters (`don't`) an apostrophe cannot be anything else: no
// quotation mark has a letter hard against it on both sides.
//
// After a letter and before a space (`the boys'`) it is usually a possessive
// plural and occasionally the closing half of a single-quoted phrase. Both
// books tested contain zero single-quoted spans, so this position is worth
// having — but only where the paragraph holds nothing that could have opened
// such a span. That check is paragraph-local and cheap.
//
// Before a letter and after a space (`'tis`, `'90s`) is left alone entirely.
// It is indistinguishable from an opening single quote by position, and the
// two books between them contain three of these. Not worth the risk.
const IN_WORD = (mark: string) =>
  new RegExp(`(?<=\\p{L})${mark}(?=\\p{L})`, "gu");
const AFTER_WORD = (mark: string) =>
  new RegExp(`(?<=\\p{L})${mark}(?![\\p{L}'’])`, "gu");

/** Something that could have OPENED a single-quoted span in this paragraph. */
const SINGLE_QUOTE_OPENER = /(^|[\s“"([{])['‘’](?=\p{L})/u;

/** Below this many apostrophes there is no majority worth calling one. */
const MIN_APOSTROPHES_TO_JUDGE = 8;

/** Share that must agree, matching quoteMarks.detectDominantStyle. */
const STYLE_MAJORITY = 0.75;

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/**
 * The apostrophe the book uses, or null when it has not said.
 *
 * Counted from in-word apostrophes only. They are the position that cannot
 * be a quotation mark, so they are the only evidence that means one thing.
 */
export function detectApostropheStyle(text: string): ApostropheStyle | null {
  const curly = countMatches(text, IN_WORD("’"));
  const straight = countMatches(text, IN_WORD("'"));
  const total = curly + straight;
  if (total < MIN_APOSTROPHES_TO_JUDGE) return null;
  if (curly / total >= STYLE_MAJORITY) return "curly";
  if (straight / total >= STYLE_MAJORITY) return "straight";
  return null;
}

const APOSTROPHE_CHAR: Record<ApostropheStyle, string> = {
  curly: "’",
  straight: "'",
};

/**
 * Rewrite one paragraph's off-style apostrophes, or return it unchanged.
 *
 * Exported because the scan counts what this would change and the copy edit
 * applies it, and the two must not be able to disagree about which marks are
 * in scope.
 */
export function repairApostrophes(
  paragraph: string,
  style: ApostropheStyle,
): string {
  const want = APOSTROPHE_CHAR[style];
  const wrong = style === "curly" ? "'" : "’";
  let out = paragraph.replace(IN_WORD(wrong), want);
  // The trailing position only when nothing here could have opened a
  // single-quoted span — see the note above.
  if (!SINGLE_QUOTE_OPENER.test(paragraph)) {
    out = out.replace(AFTER_WORD(wrong), want);
  }
  return out;
}

// ── Ellipses ──

const ELLIPSIS_CHAR = /…/g;
/** Exactly three dots. Four or more is a different thing and left alone. */
const ELLIPSIS_DOTS = /(?<!\.)\.\.\.(?!\.)/g;

/** Below this there is no habit to read. */
const MIN_ELLIPSES_TO_JUDGE = 5;

export function detectEllipsisStyle(text: string): EllipsisStyle | null {
  const char = countMatches(text, ELLIPSIS_CHAR);
  const dots = countMatches(text, ELLIPSIS_DOTS);
  const total = char + dots;
  if (total < MIN_ELLIPSES_TO_JUDGE) return null;
  if (char / total >= STYLE_MAJORITY) return "character";
  if (dots / total >= STYLE_MAJORITY) return "dots";
  return null;
}

export function repairEllipses(
  paragraph: string,
  style: EllipsisStyle,
): string {
  return style === "character"
    ? paragraph.replace(ELLIPSIS_DOTS, "…")
    : paragraph.replace(ELLIPSIS_CHAR, "...");
}

// ── Characters that take up space and cannot be seen ──
//
// A non-breaking space survives every export and holds two words together
// through justification, opening a river down a printed page. A zero-width
// character is worse: it is inside a word, it breaks search and spell-check,
// and nothing on screen says it is there.
//
// Tabs and trailing spaces are NOT in this list. They are invisible too, but
// they are structural in Markdown — two trailing spaces are a line break —
// and stripping them would change the text rather than clean it.
const SPACE_LIKE =
  /[  -   　]/g;
const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

export function repairInvisibles(paragraph: string): string {
  return paragraph.replace(SPACE_LIKE, " ").replace(ZERO_WIDTH, "");
}

// ── Drafting placeholders ──
//
// Neither test book contains one, which is the argument for the check rather
// than against it: it costs nothing to run and the failure it catches is a
// book published with TODO in chapter nine. All-caps only, and bounded by
// non-letters, so a character called Tk and a word ending in "todo" are safe.
//
// Case-SENSITIVE on the bare markers, which is load-bearing: with the
// case-insensitive flag a character named Tk was a drafting placeholder, and
// so was any sentence containing "todo". Only the two markers that are words
// rather than initials are matched in any case.
const PLACEHOLDER = new RegExp(
  "(?<![\\p{L}\\p{N}])(" +
    ["TODO", "FIXME", "TKTK", "TK", "XXX+"].join("|") +
    "|\\[\\s*[Ii]nsert[^\\]]*\\]" +
    "|\\[\\s*[Tt][Bb][Dd]\\s*\\]" +
    "|[Ll]orem [Ii]psum" +
    ")(?![\\p{L}\\p{N}])",
  "gu",
);

// ── Reading the whole manuscript ──

/** Enough of the surrounding text to find the passage in the book. */
const EXCERPT_RADIUS = 45;

function excerptAt(text: string, index: number, length: number): string {
  const from = Math.max(0, index - EXCERPT_RADIUS);
  const to = Math.min(text.length, index + length + EXCERPT_RADIUS);
  const body = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

/**
 * Every typographic inconsistency in a manuscript, one entry per kind.
 *
 * `declaredQuoteStyle` is the style the author chose in the settings panel.
 * It wins over the manuscript's own majority for the same reason it does in
 * `resolveConvention`: a book set to curly should be told about its straight
 * apostrophes even if it is currently only sixty per cent curly, because
 * that is the direction the copy edit would move it.
 */
export function findTypographyIssues(
  text: string,
  declaredQuoteStyle?: QuoteStyle | null,
): TypographyIssue[] {
  const issues: TypographyIssue[] = [];

  const apostrophe = declaredQuoteStyle ?? detectApostropheStyle(text);
  if (apostrophe) {
    const positions: { index: number; length: number }[] = [];
    // Exact offsets: split with the separators kept, since a paragraph
    // break is not always exactly two newlines.
    let at = 0;
    for (const piece of text.split(/(\n\n+)/)) {
      if (!/^\n+$/.test(piece)) {
        const fixed = repairApostrophes(piece, apostrophe);
        if (fixed !== piece) {
          for (const i of differingPositions(piece, fixed)) {
            positions.push({ index: at + i, length: 1 });
          }
        }
      }
      at += piece.length;
    }
    if (positions.length > 0) {
      issues.push({
        kind: "apostrophe-style",
        count: positions.length,
        example: excerptAt(text, positions[0].index, 1),
        expected: apostrophe,
        positions,
      });
    }
  }

  const ellipsis = detectEllipsisStyle(text);
  if (ellipsis) {
    const offStyle =
      ellipsis === "character"
        ? [...text.matchAll(ELLIPSIS_DOTS)]
        : [...text.matchAll(ELLIPSIS_CHAR)];
    if (offStyle.length > 0) {
      issues.push({
        kind: "ellipsis-style",
        count: offStyle.length,
        example: excerptAt(text, offStyle[0].index, offStyle[0][0].length),
        expected: ellipsis,
        positions: offStyle.map((m) => ({ index: m.index, length: m[0].length })),
      });
    }
  }

  const invisible = [...text.matchAll(SPACE_LIKE), ...text.matchAll(ZERO_WIDTH)];
  if (invisible.length > 0) {
    invisible.sort((a, b) => a.index - b.index);
    issues.push({
      kind: "invisible-character",
      count: invisible.length,
      example: excerptAt(text, invisible[0].index, 1),
      positions: invisible.map((m) => ({ index: m.index, length: 1 })),
    });
  }

  const placeholders = [...text.matchAll(PLACEHOLDER)];
  if (placeholders.length > 0) {
    issues.push({
      kind: "placeholder",
      count: placeholders.length,
      example: excerptAt(text, placeholders[0].index, placeholders[0][0].length),
      markers: [...new Set(placeholders.map((m) => m[0]))].slice(0, 5),
      positions: placeholders.map((m) => ({ index: m.index, length: m[0].length })),
    });
  }

  return issues;
}

/**
 * Which character positions two equal-length strings differ at.
 *
 * Every repair above is one character for one character or a deletion, so the
 * count of differences is the count of marks fixed — which is the number the
 * finding reports. A deletion shortens the string, so the lengths are checked
 * rather than assumed.
 */
function differingPositions(before: string, after: string): number[] {
  if (before.length !== after.length) {
    // A zero-width character was removed. Count the removals instead.
    return Array.from({ length: before.length - after.length }, (_, i) => i);
  }
  const out: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) out.push(i);
  }
  return out;
}

/**
 * The same repairs as corrections, for a copy edit.
 *
 * One per paragraph, never one per mark, for the reason `quoteRepair.ts`
 * gives: two corrections cut from the same paragraph have overlapping spans,
 * and applying the first leaves the second unable to find its own text.
 *
 * `preApproved`, like the quote-style repair: the manuscript's own convention
 * decides these, so there is no judgement for a reviewer to add and no tokens
 * to spend asking for one. Placeholders are deliberately absent — what should
 * replace `TODO` is the one thing here nobody but the author knows.
 */
export function getTypographyCorrections(
  text: string,
  declaredQuoteStyle?: QuoteStyle | null,
): Correction[] {
  const apostrophe = declaredQuoteStyle ?? detectApostropheStyle(text);
  const ellipsis = detectEllipsisStyle(text);
  const out: Correction[] = [];

  for (const paragraph of text.split(/\n\n+/)) {
    if (!paragraph.trim()) continue;
    let fixed = paragraph;
    if (apostrophe) fixed = repairApostrophes(fixed, apostrophe);
    if (ellipsis) fixed = repairEllipses(fixed, ellipsis);
    fixed = repairInvisibles(fixed);
    if (fixed === paragraph) continue;
    out.push({
      original: paragraph,
      corrected: fixed,
      kind: "copy",
      confidence: 1,
      preApproved: true,
      reason: "typography",
      note: "A mark that is not the form this book uses elsewhere.",
    } as Correction);
  }
  return out;
}
