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

/**
 * Monotone offset map from the original chapter text to the edited one.
 *
 * Used only to slice the edited counterpart of a paragraph — never to decide
 * what to replace.
 */
function buildOffsetMap(original: string, edited: string): (pos: number) => number {
  const points: Array<[number, number]> = [[0, 0]];
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
  return (pos: number) => {
    let best = 0;
    for (const [op, ep] of points) {
      if (op <= pos) best = ep + (pos - op);
      else break;
    }
    return Math.max(0, Math.min(edited.length, best));
  };
}

/** Character-level spans between two plain-text versions of one paragraph. */
function paragraphEdits(before: string, after: string): ParagraphTextEdit[] {
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

  for (const part of diffChars(before, after)) {
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
