// ── File conversion (pure JS — no external binaries) ──

import JSZip from "jszip";
import type TurndownService from "turndown";
import * as fs from "fs";
import * as path from "path";
import { PAGEBREAK_MARKER, isChapterHeadingLine } from "./chapters.js";
import { SCENE_BREAK_MARKER } from "./sceneBreaks.js";

// Where uploaded-document media (images extracted from .docx) live on disk.
// Markdown image refs are stored as `media/<docId>/<file>` relative to DATA_DIR,
// so they round-trip independently of any single request.
const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const MEDIA_DIR = path.join(DATA_DIR, "media");

/** Map an image MIME type to a file extension. */
function extFromContentType(contentType: string | undefined): string {
  switch ((contentType ?? "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    case "image/webp":
      return "webp";
    case "image/tiff":
      return "tiff";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}

/** Resolve a markdown image ref (`media/<docId>/x.png`) to an absolute path. */
export function resolveMediaPath(ref: string): string {
  return path.join(DATA_DIR, ref);
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  tiff: "image/tiff",
  bmp: "image/bmp",
};

// Heavy conversion deps (mammoth, turndown, html-to-docx) are dynamically
// imported on first use so they don't load before the server starts listening.
// They're only needed when a user actually imports/exports a .docx.
let _turndown: TurndownService | null = null;
async function getTurndown(): Promise<TurndownService> {
  if (_turndown) return _turndown;
  const { default: TurndownCtor } = await import("turndown");
  const td = new TurndownCtor({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Keep line breaks as-is
  td.addRule("lineBreak", {
    filter: "br",
    replacement: () => "\n",
  });
  _turndown = td;
  return td;
}

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

/**
 * Convert .docx bytes to Markdown via mammoth + turndown.
 *
 * When `docId` is given, embedded images are extracted to
 * `MEDIA_DIR/<docId>/imageN.<ext>` and referenced from the markdown as
 * `![](media/<docId>/imageN.ext)` so graphics survive the edit/export pipeline.
 */
export async function docxToMarkdown(
  docxBuffer: Buffer,
  opts: { docId?: string } = {},
): Promise<string> {
  const { docId } = opts;
  const mammoth = (await import("mammoth")).default;
  const turndown = await getTurndown();

  // Image extraction: write each embedded image to disk and reference it with a
  // lightweight relative path (instead of inlining a huge base64 data URI into
  // the markdown that the LLM would then have to round-trip).
  const mammothOpts: Record<string, unknown> = {
    styleMap: [
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
    ],
  };
  if (docId) {
    const docMediaDir = path.join(MEDIA_DIR, docId);
    await fs.promises.mkdir(docMediaDir, { recursive: true });
    let imageCount = 0;
    mammothOpts.convertImage = mammoth.images.imgElement(
      async (image: { contentType?: string; read: (e: string) => Promise<string> }) => {
        imageCount += 1;
        const ext = extFromContentType(image.contentType);
        const fileName = `image${imageCount}.${ext}`;
        const b64 = await image.read("base64");
        await fs.promises.writeFile(
          path.join(docMediaDir, fileName),
          Buffer.from(b64, "base64"),
        );
        return { src: `media/${docId}/${fileName}` };
      },
    );
  }

  const result = await mammoth.convertToHtml({ buffer: docxBuffer }, mammothOpts);

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

  // Separate paragraphs with a blank line (standard markdown), so the whole
  // pipeline — chunking (splits on blank lines), the LLM, and the exporter —
  // agree on what a paragraph boundary is. Extra empty Word paragraphs add
  // further blank lines (collapsed harmlessly on render).
  const appendBlock = (block: string) => {
    if (!block) {
      pendingEmptyParagraphs += 1;
      return;
    }
    if (text) {
      text += "\n".repeat(pendingEmptyParagraphs + 2);
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
  /** How to render section/scene breaks. Default: "asterisks" (centered * * *). */
  sectionBreak: "asterisks" | "dash" | "blank";
  /** Line spacing multiplier. Default: 1.3 */
  lineSpacing: number;
}

export const DEFAULT_DOCX_EXPORT_OPTIONS: DocxExportOptions = {
  sectionBreak: "asterisks",
  lineSpacing: 1.3,
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
  // Convert markdown to simple HTML for docx generation (images embedded as
  // base64 data URIs, which html-to-docx inlines into the .docx).
  const html = mdToHtml(md, options, embedImageDataUri);
  const HTMLtoDOCX = (await import("html-to-docx")).default;
  const docxBuffer = await HTMLtoDOCX(html, undefined, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
    font: "Times New Roman",
    fontSize: 24, // 12pt in half-points
  });
  return Buffer.from(docxBuffer as ArrayBuffer);
}

/**
 * Render markdown to HTML, faithfully reproducing the input's paragraph layout:
 *   - A blank line separates paragraphs (standard markdown).
 *   - A single newline inside a block is a soft line break (<br/>).
 *   - Real structural markers (page breaks, headings, scene breaks) are honoured.
 *
 * `imageResolver(alt, src)` turns a markdown image ref into an <img> tag; the
 * DOCX path embeds base64 data URIs, the EPUB path rewrites to relative refs.
 *
 * Exported so the EPUB builder can reuse the exact same block parsing.
 */
export function mdToHtml(
  md: string,
  opts: DocxExportOptions,
  imageResolver: ImageResolver = embedImageDataUri,
): string {
  const lines = md.split("\n");
  const htmlLines: string[] = [];
  const lineHeight = `line-height:${opts.lineSpacing}`;
  let lastWasPagebreak = false;
  let seenChapterHeading = false;

  const paragraphLines: string[] = [];
  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const joined = paragraphLines
      .map((ln) => inlineFormat(ln, imageResolver))
      .join("<br/>");
    htmlLines.push(`<p style="${lineHeight}">${joined}</p>`);
    paragraphLines.length = 0;
    lastWasPagebreak = false;
  };

  // Consecutive blank lines beyond the first are empty source paragraphs —
  // the author's soft section breaks, which the DOCX importer preserved as
  // extra blank lines. Round-trip each back to a real empty line (same nbsp
  // paragraph as the lone-"#" minor break). Emitted lazily on the next
  // content line so leading/trailing blanks add nothing.
  let pendingBlankLines = 0;
  const emitSectionBlanks = () => {
    if (pendingBlankLines >= 2 && htmlLines.length > 0) {
      for (let i = 1; i < pendingBlankLines; i++) {
        htmlLines.push(`<p style="${lineHeight}">&#160;</p>`);
      }
    }
    pendingBlankLines = 0;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Blank line: paragraph separator — runs of them become section breaks.
    if (trimmed === "") {
      flushParagraph();
      pendingBlankLines += 1;
      continue;
    }
    emitSectionBlanks();

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

    // Lone "#": minor section break (smaller than a scene break) — render as
    // a real empty line. The &#160; keeps html-to-docx from dropping the
    // paragraph; numeric (not &nbsp;) so the EPUB XHTML parses it too.
    if (trimmed === "#") {
      flushParagraph();
      htmlLines.push(`<p style="${lineHeight}">&#160;</p>`);
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
        `<h${level} style="${lineHeight}">${inlineFormat(headingMatch[2], imageResolver)}</h${level}>`,
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
      htmlLines.push(
        `<h1 style="${lineHeight}">${inlineFormat(trimmed, imageResolver)}</h1>`,
      );
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

/** Turns a markdown image (alt, src) into an <img> tag (or "" if unresolvable). */
export type ImageResolver = (alt: string, src: string) => string;

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** DOCX image resolver: inline the file as a base64 data URI. */
export const embedImageDataUri: ImageResolver = (alt, src) => {
  try {
    const abs = src.startsWith("media/") ? resolveMediaPath(src) : src;
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "image/png";
    const data = fs.readFileSync(abs).toString("base64");
    return `<img src="data:${mime};base64,${data}" alt="${escapeHtmlAttr(alt)}" />`;
  } catch {
    return ""; // image missing on disk — drop gracefully
  }
};

function inlineFormat(text: string, imageResolver: ImageResolver): string {
  // Images first (before emphasis), so their URLs aren't mangled.
  text = text.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_m, alt: string, src: string) => imageResolver(alt, src),
  );
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");
  // Italic
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  text = text.replace(/_(.+?)_/g, "<em>$1</em>");
  return text;
}
