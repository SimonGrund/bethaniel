// ── The text around a suggestion on a review card ──
//
// The card used to borrow extractSentenceContext from the old review list,
// which runs out to the nearest ". ! ?" — and the card renders it with
// pre-wrap. Dialogue ending in a closing quote, a heading, a scene break, a
// line of verse: none of those end in one of the three marks, so the
// "sentence" ran on across paragraph after paragraph, and the Accept and
// Dismiss buttons were pushed below the fold.
//
// So two readings. The compact one, shown by default, never leaves the
// paragraph the change is in, stops at the sentence, caps each side, and
// flattens line breaks: the card stays a few lines tall whatever the
// manuscript looks like around it. The extended one, on request, is the
// paragraph before, the paragraph itself and the paragraph after, line
// breaks kept — still capped, because a paragraph can be a page.
//
// Pure, and tested from backend/test/deckContext.test.ts because the
// frontend has no test runner.

import { locateInText } from "./textLocate";

export interface CardContext {
  before: string;
  after: string;
}

const NONE: CardContext = { before: "", after: "" };

/** Each side of the compact reading, in characters. */
export const COMPACT_SIDE = 160;
/** Each side of the extended reading, in characters. */
export const EXTENDED_SIDE = 700;
/** A sentence fragment this short beside the change pulls in its neighbour. */
const SHORT_GAP = 15;

// A sentence ends at . ! ? or …, with any closing quotes or brackets after
// it, followed by whitespace.
const SENTENCE_END = /[.!?…]["'”’»)\]]*(?=\s)/g;

function locate(original: string, fullText: string): { start: number; end: number } | null {
  const found = locateInText(original, fullText, 0);
  if (!found) return null;
  // locateInText's last-ditch fallback matches a single word of the phrase;
  // the context around that would repeat the rest of the phrase back.
  if (found.length < original.trim().length / 2) return null;
  return { start: found.index, end: found.index + found.length };
}

function flatten(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Keep the end of `s`, at most `max` characters, cut at a word. */
function tailOf(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(s.length - max);
  const space = cut.indexOf(" ");
  return "…" + (space >= 0 && space < max / 2 ? cut.slice(space + 1) : cut);
}

/** Keep the start of `s`, at most `max` characters, cut at a word. */
function headOf(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut) + "…";
}

/** The sentence the change is in, never crossing a line break. */
export function compactContext(original: string, fullText: string): CardContext {
  const at = locate(original, fullText);
  if (!at) return NONE;

  const paraStart = fullText.lastIndexOf("\n", at.start - 1) + 1;
  const nl = fullText.indexOf("\n", at.end);
  const paraEnd = nl < 0 ? fullText.length : nl;

  // Back to the start of the sentence — or of the one before, when the
  // change opens its sentence and there would be nothing to read before it.
  const head = fullText.slice(paraStart, at.start);
  const starts: number[] = [0];
  for (const m of head.matchAll(SENTENCE_END)) starts.push(m.index! + m[0].length);
  let from = starts[starts.length - 1];
  if (flatten(head.slice(from)).length <= SHORT_GAP && starts.length >= 2) {
    from = starts[starts.length - 2];
  }
  const before = tailOf(flatten(head.slice(from)), COMPACT_SIDE);

  // On to the end of the sentence — or of the next, when the change closes
  // its sentence.
  const tail = fullText.slice(at.end, paraEnd);
  const ends: number[] = [];
  for (const m of tail.matchAll(SENTENCE_END)) ends.push(m.index! + m[0].length);
  let to = ends.length ? ends[0] : tail.length;
  if (flatten(tail.slice(0, to)).length <= SHORT_GAP) {
    to = ends.length >= 2 ? ends[1] : tail.length;
  }
  const after = headOf(flatten(tail.slice(0, to)), COMPACT_SIDE);

  return { before, after };
}

/** The paragraph before, the paragraph itself and the one after. */
export function extendedContext(original: string, fullText: string): CardContext {
  const at = locate(original, fullText);
  if (!at) return NONE;

  // Paragraphs are the non-blank lines; a blank line between them is one
  // break, however many the manuscript has.
  const tidy = (s: string) =>
    s
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n");

  const beforeLines = fullText.slice(0, at.start).split("\n");
  // The line the change is in, plus the last non-blank line before it.
  let firstLine = beforeLines.length - 1;
  for (let i = firstLine - 1; i >= 0; i--) {
    if (beforeLines[i].trim()) {
      firstLine = i;
      break;
    }
  }
  let before = tidy(beforeLines.slice(firstLine).join("\n"));
  // The change opens its paragraph: the paragraph before stays one.
  if (before && !beforeLines[beforeLines.length - 1].trim()) before += "\n\n";
  before = tailOf(before, EXTENDED_SIDE);

  const afterLines = fullText.slice(at.end).split("\n");
  let lastLine = 0;
  for (let i = 1; i < afterLines.length; i++) {
    if (afterLines[i].trim()) {
      lastLine = i;
      break;
    }
  }
  let after = tidy(afterLines.slice(0, lastLine + 1).join("\n"));
  // The change closes its paragraph: the paragraph after starts a new one.
  if (after && !afterLines[0].trim()) after = "\n\n" + after;
  after = headOf(after, EXTENDED_SIDE);

  return { before, after };
}
