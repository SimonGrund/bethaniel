// ── File conversion (pure JS — no external binaries) ──

import JSZip from "jszip";
import mammoth from "mammoth";
import TurndownService from "turndown";
import HTMLtoDOCX from "html-to-docx";
import { PAGEBREAK_MARKER, isChapterHeadingLine } from "./chapters.js";
import { SCENE_BREAK_MARKER } from "./sceneBreaks.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Keep line breaks as-is
turndown.addRule("lineBreak", {
  filter: "br",
  replacement: () => "\n",
});

/**
 * Extract page-break paragraph indices from a .docx file.
 * Mirrors extract_pagebreaks_from_docx() in ui.py.
 */
async function getDocxParagraphInfo(
  docxBuffer: Buffer,
): Promise<Array<{ isPageBreak: boolean; isEmpty: boolean }>> {
  try {
    const zip = await JSZip.loadAsync(docxBuffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    if (!docXml) return [];

    const paragraphs = docXml.match(/<w:p\b[\s\S]*?(?:<\/w:p>|\/>)/g) ?? [];

    return paragraphs.map((p) => {
      let isPageBreak = false;

      if (/<w:br[^>]*w:type="page"/.test(p)) {
        isPageBreak = true;
      }
      if (!isPageBreak && /<w:pageBreakBefore/.test(p)) {
        const valMatch = p.match(/<w:pageBreakBefore[^>]*w:val="([^"]+)"/);
        if (
          !valMatch ||
          ["true", "1", "on"].includes(valMatch[1].toLowerCase())
        ) {
          isPageBreak = true;
        }
      }
      if (!isPageBreak && /<w:sectPr/.test(p)) {
        const typeMatch = p.match(
          /<w:type[^>]*w:val="(nextPage|oddPage|evenPage)"/,
        );
        if (typeMatch) isPageBreak = true;
      }

      const hasVisibleText = /<w:t(?:\s|>)/.test(p);
      const hasObject = /<w:drawing|<w:pict|<w:object/.test(p);
      const isEmpty = !isPageBreak && !hasVisibleText && !hasObject;

      return { isPageBreak, isEmpty };
    });
  } catch {
    return [];
  }
}

export async function extractPagebreaksFromDocx(
  docxBuffer: Buffer,
): Promise<number[]> {
  const infos = await getDocxParagraphInfo(docxBuffer);
  const breaks: number[] = [];
  for (let i = 0; i < infos.length; i++) {
    if (infos[i].isPageBreak) breaks.push(i);
  }
  return breaks;
}

/** Convert .docx bytes to Markdown via mammoth + turndown. */
export async function docxToMarkdown(docxBuffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml(
    { buffer: docxBuffer },
    {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
      ],
    },
  );

  const normalizeDividerLine = (line: string): string => {
    const t = line.trim();
    if (/^(\\?\*\s*){3,}$/.test(t) && /\*/.test(t)) {
      const hadSpaces = /\s/.test(t);
      return hadSpaces ? "* * *" : "***";
    }
    return line;
  };

  // Mammoth emits one <p> per Word paragraph. Turndown would normally turn
  // every paragraph into markdown blocks separated by blank lines, which
  // loses the distinction between an ordinary paragraph boundary and an
  // intentionally empty paragraph. Instead, preserve ordinary paragraphs as
  // single newlines and only emit a real blank line for explicit empty <p>s.
  const blockRe = /<(p|h1|h2|h3)\b[^>]*>[\s\S]*?<\/\1>/gi;
  const htmlBlocks = result.value.match(blockRe) ?? [];
  const paragraphInfo = await getDocxParagraphInfo(docxBuffer);

  if (htmlBlocks.length === 0) {
    return turndown
      .turndown(result.value)
      .split("\n")
      .map(normalizeDividerLine)
      .join("\n");
  }

  let text = "";
  let pendingEmptyParagraphs = 0;
  let pendingPageBreak = false;
  let blockIndex = 0;

  const appendBlock = (block: string) => {
    if (!block) {
      pendingEmptyParagraphs += 1;
      return;
    }
    if (text) {
      text += "\n".repeat(pendingEmptyParagraphs + 1);
    }
    text += block;
    pendingEmptyParagraphs = 0;
  };

  for (const info of paragraphInfo) {
    if (info.isPageBreak) {
      pendingPageBreak = true;
      continue;
    }
    if (info.isEmpty) {
      pendingEmptyParagraphs += 1;
      continue;
    }

    let mdBlock = htmlBlocks[blockIndex]
      ? turndown.turndown(htmlBlocks[blockIndex]).trim()
      : "";
    blockIndex += 1;

    if (mdBlock) {
      mdBlock = mdBlock.split("\n").map(normalizeDividerLine).join("\n");
    }

    if (pendingPageBreak && text && mdBlock) {
      const nextFirstLine = (
        mdBlock.split("\n").find((ln) => ln.trim()) ?? ""
      ).trim();
      const looksLikeHeading =
        /^#{1,2}\s+/.test(nextFirstLine) || isChapterHeadingLine(nextFirstLine);
      if (looksLikeHeading) {
        appendBlock(PAGEBREAK_MARKER);
      }
      pendingPageBreak = false;
    }

    appendBlock(mdBlock);
  }

  for (; blockIndex < htmlBlocks.length; blockIndex++) {
    const mdBlock = turndown
      .turndown(htmlBlocks[blockIndex])
      .trim()
      .split("\n")
      .map(normalizeDividerLine)
      .join("\n");
    appendBlock(mdBlock);
  }

  return text;
}

/** Options for DOCX export formatting. */
export interface DocxExportOptions {
  /** How to render section/scene breaks (e.g. "***" centered, "---", blank line). Default: "***" */
  sectionBreak: "asterisks" | "dash" | "blank";
  /** How to render small breaks between paragraphs. Default: "space" (extra vertical space) */
  smallBreak: "space" | "hash" | "none";
  /** Line spacing multiplier. Default: 1.3 */
  lineSpacing: number;
  /** If false, skip all break-aware rendering (no scene-break detection, no
   * automatic chapter page breaks). Used when the user opted out of break
   * detection at upload — the markdown is then round-tripped plainly. */
  detectBreaks: boolean;
}

export const DEFAULT_DOCX_EXPORT_OPTIONS: DocxExportOptions = {
  sectionBreak: "asterisks",
  smallBreak: "space",
  lineSpacing: 1.3,
  detectBreaks: true,
};

/** Convert Markdown to .docx, return the binary buffer. */
export async function markdownToDocx(
  md: string,
  opts: Partial<DocxExportOptions> = {},
): Promise<Buffer> {
  const options: DocxExportOptions = {
    ...DEFAULT_DOCX_EXPORT_OPTIONS,
    ...opts,
  };
  // Convert markdown to simple HTML for docx generation
  const html = mdToHtml(md, options);
  const docxBuffer = await HTMLtoDOCX(html, undefined, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
    font: "Times New Roman",
    fontSize: 24, // 12pt in half-points
  });
  return Buffer.from(docxBuffer as ArrayBuffer);
}

// Adjust mdToHtml to prevent misplaced page breaks before regular text
function mdToHtml(md: string, opts: DocxExportOptions): string {
  const lines = md.split("\n");
  const htmlLines: string[] = [];
  const lineHeight = `line-height:${opts.lineSpacing}`;
  let lastWasPagebreak = false;
  let seenChapterHeading = false;
  let blankRun = 0;

  const paragraphLines: string[] = [];
  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const joined = paragraphLines.map((ln) => inlineFormat(ln)).join("<br/>");
    htmlLines.push(`<p style="${lineHeight}">${joined}</p>`);
    paragraphLines.length = 0;
    lastWasPagebreak = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      blankRun += 1;
      if (blankRun >= 1) {
        if (opts.smallBreak === "space") {
          htmlLines.push(`<p style="${lineHeight}">&nbsp;</p>`);
        } else if (opts.smallBreak === "hash") {
          htmlLines.push(`<p style="text-align:center;${lineHeight}">#</p>`);
        }
      }
      continue;
    }

    blankRun = 0;

    if (trimmed === PAGEBREAK_MARKER) {
      flushParagraph();
      htmlLines.push(
        `<div class="page-break" style="page-break-after:always"></div>`,
      );
      lastWasPagebreak = true;
      continue;
    }

    if (trimmed === SCENE_BREAK_MARKER || /^(\*\s*){3}$/.test(trimmed)) {
      flushParagraph();
      htmlLines.push(renderSceneBreak(opts.sectionBreak, lineHeight));
      lastWasPagebreak = false;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      const isChapter = level <= 2;
      if (isChapter && seenChapterHeading && !lastWasPagebreak) {
        htmlLines.push(
          `<div class="page-break" style="page-break-after:always"></div>`,
        );
      }
      htmlLines.push(
        `<h${level} style="${lineHeight}">${inlineFormat(headingMatch[2])}</h${level}>`,
      );
      if (isChapter) seenChapterHeading = true;
      lastWasPagebreak = false;
      continue;
    }

    if (isChapterHeadingLine(trimmed)) {
      flushParagraph();
      if (seenChapterHeading && !lastWasPagebreak) {
        htmlLines.push(
          `<div class="page-break" style="page-break-after:always"></div>`,
        );
      }
      htmlLines.push(`<h1 style="${lineHeight}">${inlineFormat(trimmed)}</h1>`);
      seenChapterHeading = true;
      lastWasPagebreak = false;
      continue;
    }

    paragraphLines.push(line.trimEnd());
    lastWasPagebreak = false;
  }

  flushParagraph();

  return htmlLines.join("\n");
}

function renderSceneBreak(
  style: DocxExportOptions["sectionBreak"],
  lineHeight: string,
): string {
  if (style === "dash") {
    return `<p style="text-align:center;${lineHeight};margin-top:12pt;margin-bottom:12pt">&mdash;</p>`;
  }
  if (style === "blank") {
    return `<p style="${lineHeight};margin-top:12pt;margin-bottom:12pt">&nbsp;</p>`;
  }
  return `<p style="text-align:center;${lineHeight};margin-top:12pt;margin-bottom:12pt">* * *</p>`;
}

function inlineFormat(text: string): string {
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");
  // Italic
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  text = text.replace(/_(.+?)_/g, "<em>$1</em>");
  return text;
}
