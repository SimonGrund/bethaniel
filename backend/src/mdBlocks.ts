// ── Markdown block structure, shared by every exporter ──
//
// Extracted from mdToHtml so the DOCX and EPUB paths agree on *structure* by
// construction rather than by two implementations happening to match. Inline
// formatting is deliberately NOT shared: the HTML path and the DOCX path have
// different capabilities (html-to-docx could not render bold+italic; the docx
// builder can), so each owns its own inline handling.
//
// Pure and dependency-free — no rendering decisions live here.

import { PAGEBREAK_MARKER, isChapterHeadingLine } from "./chapters.js";
import { SCENE_BREAK_MARKER } from "./sceneBreaks.js";

export type MdBlock =
  /** One or more source lines forming a paragraph; joined with a line break. */
  | { kind: "paragraph"; lines: string[] }
  /** Explicit page break from the importer. */
  | { kind: "pagebreak" }
  /** `***` or the scene-break marker. */
  | { kind: "sceneBreak" }
  /** A lone `#`, or one of a run of blank lines — the author's soft break. */
  | { kind: "minorBreak" }
  | {
      kind: "heading";
      level: number;
      text: string;
      /** Levels 1-2 and bare chapter lines start a new chapter. */
      isChapter: boolean;
      /** A chapter heading that is not already preceded by a page break. */
      needsPageBreak: boolean;
    };

/**
 * Walk markdown into blocks.
 *
 * Mirrors the original mdToHtml loop exactly, including two behaviours that look
 * incidental but are load-bearing:
 *   - runs of blank lines beyond the first become minor breaks (the importer
 *     preserves an author's empty Word paragraphs as extra blank lines), emitted
 *     lazily so leading and trailing blanks contribute nothing
 *   - a chapter heading gets a page break before it only when one is not already
 *     there, and never before the first chapter
 */
export function parseMdBlocks(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let lastWasPagebreak = false;
  let seenChapterHeading = false;
  let pendingBlankLines = 0;

  const paragraphLines: string[] = [];
  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push({ kind: "paragraph", lines: [...paragraphLines] });
    paragraphLines.length = 0;
    lastWasPagebreak = false;
  };

  const emitSectionBlanks = () => {
    if (pendingBlankLines >= 2 && blocks.length > 0) {
      for (let i = 1; i < pendingBlankLines; i++) {
        blocks.push({ kind: "minorBreak" });
      }
    }
    pendingBlankLines = 0;
  };

  const pushHeading = (level: number, text: string, isChapter: boolean) => {
    flushParagraph();
    const needsPageBreak = isChapter && seenChapterHeading && !lastWasPagebreak;
    blocks.push({ kind: "heading", level, text, isChapter, needsPageBreak });
    if (isChapter) seenChapterHeading = true;
    lastWasPagebreak = false;
  };

  for (const line of md.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      pendingBlankLines += 1;
      continue;
    }
    emitSectionBlanks();

    if (trimmed === PAGEBREAK_MARKER) {
      flushParagraph();
      blocks.push({ kind: "pagebreak" });
      lastWasPagebreak = true;
      continue;
    }

    if (trimmed === SCENE_BREAK_MARKER || /^(\*\s*){3,}$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ kind: "sceneBreak" });
      lastWasPagebreak = false;
      continue;
    }

    if (trimmed === "#") {
      flushParagraph();
      blocks.push({ kind: "minorBreak" });
      lastWasPagebreak = false;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      pushHeading(level, headingMatch[2], level <= 2);
      continue;
    }

    if (isChapterHeadingLine(trimmed)) {
      pushHeading(1, trimmed, true);
      continue;
    }

    paragraphLines.push(line.trimEnd());
    lastWasPagebreak = false;
  }

  flushParagraph();
  return blocks;
}
