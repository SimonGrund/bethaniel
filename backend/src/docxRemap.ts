// ── Mapping edited chapters back onto docx paragraphs ──
//
// Corrections carry no positions: `Correction` is { original, corrected } and
// the pipeline recovers positions by string search. Worse, some exported text
// has no correction objects behind it at all — verifyAcceptedCorrections
// returns server-repaired chapter text, and translate mode replaces text
// wholesale. So this does not try to plumb correction offsets. The stable
// contract every export path already has is the pair (originalText, editedText)
// per chapter; the edit spans are derived by diffing.
//
// The substitution decision is always plain-text vs plain-text WITHIN one
// paragraph. Markdown offsets are used only to locate the paragraph, and the
// located text is verified against the docx before anything is changed. Every
// failure mode therefore degrades to "this paragraph keeps its original text",
// never to "this paragraph is corrupted".

import { diffWordsWithSpace, diffChars } from "diff";

import type { ParagraphMapEntry } from "./conversion.js";
import type { DocxTextIndex, ParagraphTextEdit } from "./docxSurgery.js";

export interface ChapterExport {
  original: string;
  edited: string;
}

export interface UnmappedNote {
  reason: "chapter-not-found" | "paragraph-mismatch" | "not-mappable";
  detail: string;
  paragraphIndex?: number;
}

export interface RemapResult {
  edits: Array<{ paragraphIndex: number } & ParagraphTextEdit>;
  unmapped: UnmappedNote[];
}

/**
 * Reduce a markdown block to the text a Word paragraph would hold.
 *
 * Mirrors what the exporter's inline handling adds, in reverse: the heading
 * prefix, emphasis markers (longest first, so *** is not read as * twice), and
 * image references, which have no textual counterpart in the run.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/(\*\*\*|___)(.+?)\1/gs, "$2")
    .replace(/(\*\*|__)(.+?)\1/gs, "$2")
    .replace(/(\*|_)(.+?)\1/gs, "$2")
    .replace(/\\([_*`])/g, "$1");
}

/** Whitespace-insensitive comparison, for the tolerant second attempt. */
function loose(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Start/end offset of every blank-line-separated block in `text`. */
function blockSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /[^\n][\s\S]*?(?=\n\s*\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!m[0].trim()) continue;
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/**
 * Monotone offset map from the original chapter text to the edited one.
 *
 * Used only to slice the edited counterpart of a paragraph — never to decide
 * what to replace. Both offsets it is ever asked for are block boundaries, so
 * pairing the blocks up by index answers every real query exactly.
 *
 * The word diff below is the fallback, and it is a fallback for a reason: on a
 * translation no two words match, which is Myers' O(n·d) worst case. A chapter
 * cost over a second there, so a novel's export blocked the backend for
 * minutes — the "download takes forever" report. Blocks align in O(n), and for
 * the edit modes (which never merge or split paragraphs) and for a translation
 * (whose prompts forbid it, and whose upgrade pass is guarded on it) the counts
 * match, so the fast path is the path taken.
 */
function buildOffsetMap(original: string, edited: string): (pos: number) => number {
  const points: Array<[number, number]> = [[0, 0]];

  const oBlocks = blockSpans(original);
  const eBlocks = blockSpans(edited);
  if (oBlocks.length > 0 && oBlocks.length === eBlocks.length) {
    for (let i = 0; i < oBlocks.length; i++) {
      points.push([oBlocks[i][0], eBlocks[i][0]]);
      points.push([oBlocks[i][1], eBlocks[i][1]]);
    }
  } else {
    let o = 0;
    let e = 0;
    for (const part of diffWordsWithSpace(original, edited)) {
      if (part.added) {
        e += part.value.length;
      } else if (part.removed) {
        o += part.value.length;
      } else {
        o += part.value.length;
        e += part.value.length;
      }
      points.push([o, e]);
    }
  }
  points.push([original.length, edited.length]);

  return (pos: number) => {
    // Binary search for the last point at or before `pos`. The linear scan
    // this replaced ran once per paragraph over a points array that grew with
    // the chapter, which is a second quadratic term on the same hot path.
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (points[mid][0] <= pos) lo = mid;
      else hi = mid - 1;
    }
    const [op, ep] = points[lo];
    return Math.max(0, Math.min(edited.length, ep + (pos - op)));
  };
}

/**
 * How far a character diff may wander before the paragraph is treated as
 * rewritten outright. A correction edits a word or a clause, so its distance
 * is a handful of characters; a translated paragraph shares nothing but its
 * punctuation, and diffing it produced a hundred-odd one-character spans that
 * cost real time to compute and shredded the Word paragraph into as many runs.
 * Past this point one whole-paragraph replacement is smaller, faster and truer
 * to what actually happened.
 */
const REWRITE_DISTANCE_RATIO = 0.5;

/** Character-level spans between two plain-text versions of one paragraph. */
function paragraphEdits(before: string, after: string): ParagraphTextEdit[] {
  const parts = diffChars(before, after, {
    maxEditLength: Math.max(
      32,
      Math.round(Math.max(before.length, after.length) * REWRITE_DISTANCE_RATIO),
    ),
  });
  // Over the cap: too different to be an edit of this paragraph. Replace it.
  if (!parts) return [{ start: 0, end: before.length, replacement: after }];

  const edits: ParagraphTextEdit[] = [];
  let pos = 0;
  let pendingStart = -1;
  let removed = "";
  let added = "";

  const flush = () => {
    if (pendingStart < 0) return;
    edits.push({
      start: pendingStart,
      end: pendingStart + removed.length,
      replacement: added,
    });
    pendingStart = -1;
    removed = "";
    added = "";
  };

  for (const part of parts) {
    if (part.added) {
      if (pendingStart < 0) pendingStart = pos;
      added += part.value;
    } else if (part.removed) {
      if (pendingStart < 0) pendingStart = pos;
      removed += part.value;
      pos += part.value.length;
    } else {
      flush();
      pos += part.value.length;
    }
  }
  flush();
  return edits;
}

/**
 * Turn edited chapters into paragraph-local edits against the original docx.
 */
export function remapChaptersToParagraphEdits(
  docMd: string,
  paragraphMap: ParagraphMapEntry[],
  index: DocxTextIndex,
  chapters: ChapterExport[],
): RemapResult {
  const edits: RemapResult["edits"] = [];
  const unmapped: UnmappedNote[] = [];

  // Chapters are ordered and non-overlapping slices of docMd, so a forward
  // cursor makes the anchor unambiguous.
  let cursor = 0;

  for (const chapter of chapters) {
    if (chapter.original === chapter.edited) continue;

    let at = docMd.indexOf(chapter.original, cursor);
    if (at < 0) at = docMd.indexOf(chapter.original);
    if (at < 0) {
      unmapped.push({
        reason: "chapter-not-found",
        detail: chapter.original.slice(0, 60),
      });
      continue;
    }
    const chapterEnd = at + chapter.original.length;
    cursor = chapterEnd;

    const toEdited = buildOffsetMap(chapter.original, chapter.edited);

    for (const entry of paragraphMap) {
      if (entry.mdStart < at || entry.mdEnd > chapterEnd) continue;

      const paragraph = index.paragraphs[entry.docxParaIndex];
      if (!paragraph) continue;

      if (!entry.mappable) {
        unmapped.push({
          reason: "not-mappable",
          detail: paragraph.text.slice(0, 60),
          paragraphIndex: entry.docxParaIndex,
        });
        continue;
      }

      const oldMd = docMd.slice(entry.mdStart, entry.mdEnd);
      const newMd = chapter.edited.slice(
        toEdited(entry.mdStart - at),
        toEdited(entry.mdEnd - at),
      );

      const beforePlain = stripMarkdown(oldMd);
      const afterPlain = stripMarkdown(newMd);

      // Verify before acting. If the markdown we located does not match what
      // the docx actually holds, we do not understand this paragraph well
      // enough to edit it — leave it exactly as the author wrote it.
      if (
        beforePlain !== paragraph.text &&
        loose(beforePlain) !== loose(paragraph.text)
      ) {
        unmapped.push({
          reason: "paragraph-mismatch",
          detail: paragraph.text.slice(0, 60),
          paragraphIndex: entry.docxParaIndex,
        });
        continue;
      }
      if (beforePlain === afterPlain) continue;

      // Diff against the docx's own text, so offsets are in its coordinates
      // even when whitespace differed from the markdown.
      for (const e of paragraphEdits(paragraph.text, afterPlain)) {
        edits.push({ paragraphIndex: entry.docxParaIndex, ...e });
      }
    }
  }

  return { edits, unmapped };
}
