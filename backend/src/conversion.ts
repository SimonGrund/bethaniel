// ── File conversion (pure JS — no external binaries) ──

import JSZip from "jszip";
import type TurndownService from "turndown";
import * as fs from "fs";
import * as path from "path";
import { PAGEBREAK_MARKER, isChapterHeadingLine } from "./chapters.js";
import { parseMdBlocks } from "./mdBlocks.js";
import { indexDocumentXml } from "./docxSurgery.js";
import { buildDocx, type ImageBytesResolver } from "./mdToDocx.js";
import { SCENE_BREAK_MARKER } from "./sceneBreaks.js";
import { cleanPublishArtifacts } from "./publishReview.js";

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

    // Uses the same scanner as surgical export, so import ordinals and surgery
    // ordinals cannot disagree. It also fixes a real defect in the regex this
    // replaced: that pattern terminated an outer <w:p> at an INNER </w:p>, so
    // any document containing a text box was silently misaligned — every
    // paragraph after the box shifted by one.
    return indexDocumentXml(docXml).paragraphs.map((p) => ({
      isPageBreak: p.isPageBreak,
      isEmpty: p.isEmpty,
    }));
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
      // Title/Subtitle styles (authors often use "Title" for chapter/part
      // headings). Mammoth's built-in map already handles the Heading1..6
      // styleIds — which is why localized docs ("Overskrift 1"/"Überschrift 1")
      // still import as headings — but it has no Title/Subtitle mapping. Map
      // both the English style-name and the language-neutral styleId so a real
      // markdown heading (the most reliable chapter signal) is emitted.
      "p[style-name='Title'] => h1:fresh",
      "p.Title => h1:fresh",
      "p[style-name='Subtitle'] => h2:fresh",
      "p.Subtitle => h2:fresh",
      // Word CHARACTER styles carry no direct <w:i/> on the run, and mammoth's
      // default map only knows 'Strong' — without these, style-based italics
      // silently import as plain text.
      "r[style-name='Emphasis'] => em",
      "r.Emphasis => em", // styleId form — survives localized Word UIs
      "r[style-name='Subtle Emphasis'] => em",
      "r[style-name='Intense Emphasis'] => em",
      "r[style-name='Book Title'] => em",
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
    return stripMarkdownEscapes(
      turndown
        .turndown(result.value)
        .split("\n")
        .map(normalizeDividerLine)
        .join("\n"),
    );
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

  return stripMarkdownEscapes(text);
}

/**
 * Turndown backslash-escapes markdown-special characters it finds as literal
 * TEXT in the docx (`_` → `\_`, `*` → `\*`). Fiction manuscripts never
 * intentionally contain escaped markdown — such text is an artifact of an
 * earlier export/import (e.g. emphasis markers leaked as literal characters),
 * and the escapes surface as junk like `\_s\_` in edited output. Unescaping
 * restores the intended emphasis or leaves a harmless bare marker.
 */
function stripMarkdownEscapes(md: string): string {
  return md.replace(/\\([_*`])/g, "$1");
}

/** Options for DOCX export formatting. */
export interface DocxExportOptions {
  /** How to render scene breaks. Default: "asterisks" (centered ***). */
  sectionBreak: "asterisks" | "dash" | "blank";
  /**
   * How to render minor section breaks (blank-line runs and lone "#").
   * "blank" — an empty (nbsp) paragraph, faithful to the manuscript.
   * "hash"  — a centered "#": Atticus strips empty paragraphs when pasting,
   *           so a visible marker is the only thing that survives the trip.
   */
  minorBreak: "blank" | "hash";
  /** Line spacing multiplier. Default: 1.3 */
  lineSpacing: number;
}

export const DEFAULT_DOCX_EXPORT_OPTIONS: DocxExportOptions = {
  sectionBreak: "asterisks",
  minorBreak: "blank",
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
  // Built programmatically rather than via HTML. html-to-docx is gone: it was
  // abandoned in 2023, carried two unpatched image-size advisories through an
  // inlined bundle, and silently dropped one half of bold+italic.
  return buildDocx(md, options, readImageBytes);
}

/** Image bytes for the DOCX builder, or null when the file is unavailable. */
export const readImageBytes: ImageBytesResolver = (src) => {
  try {
    const abs = src.startsWith("media/") ? resolveMediaPath(src) : src;
    return fs.readFileSync(abs);
  } catch {
    return null; // missing on disk — the builder drops the image
  }
};

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
  const lineHeight = `line-height:${opts.lineSpacing}`;
  const htmlLines: string[] = [];
  const pageBreak = `<div class="page-break" style="page-break-after:always"></div>`;

  for (const block of parseMdBlocks(md)) {
    switch (block.kind) {
      case "paragraph": {
        const joined = block.lines
          .map((ln) => inlineFormat(ln, imageResolver))
          .join("<br/>");
        htmlLines.push(`<p style="${lineHeight}">${joined}</p>`);
        break;
      }
      case "pagebreak":
        htmlLines.push(pageBreak);
        break;
      case "sceneBreak":
        htmlLines.push(renderSceneBreak(opts.sectionBreak, lineHeight));
        break;
      case "minorBreak":
        htmlLines.push(renderMinorBreak(opts.minorBreak, lineHeight));
        break;
      case "heading": {
        if (block.needsPageBreak) htmlLines.push(pageBreak);
        const inner = inlineFormat(block.text, imageResolver);
        htmlLines.push(
          `<h${block.level} style="${lineHeight}">${inner}</h${block.level}>`,
        );
        break;
      }
    }
  }

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
  // "***" (no spaces): the form Atticus recognizes as a scene break.
  return `<p style="text-align:center;${lineHeight};margin-top:12pt;margin-bottom:12pt">***</p>`;
}

/** Minor section break (blank-line run / lone "#") — see DocxExportOptions. */
function renderMinorBreak(
  style: DocxExportOptions["minorBreak"],
  lineHeight: string,
): string {
  if (style === "hash") {
    return `<p style="text-align:center;${lineHeight}">#</p>`;
  }
  // The &#160; keeps html-to-docx from dropping the paragraph; numeric
  // (not &nbsp;) so the EPUB XHTML parses it too.
  return `<p style="${lineHeight}">&#160;</p>`;
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
  // Last-gate defense: strip stray emphasis markers wrapping only punctuation
  // (`okay_?_` → `okay?`). Such artifacts sit next to a word char, so the
  // emphasis regexes below (which need a non-word boundary) skip them and they
  // would otherwise reach the DOCX as literal underscores.
  text = cleanPublishArtifacts(text).cleaned;
  // Images first (before emphasis), so their URLs aren't mangled.
  text = text.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_m, alt: string, src: string) => imageResolver(alt, src),
  );
  // Defense in depth: strip stray backslash-escaped markers BEFORE the
  // emphasis regexes (see stripMarkdownEscapes) — otherwise `\_s\_` pairs as
  // emphasis with the backslashes left orphaned as literal text.
  text = text.replace(/\\([_*`])/g, "$1");
  // Emphasis. Two hard constraints from html-to-docx@1.8:
  //   - Italic MUST be <i>, never <em> — the bundle it loads styles <i> but
  //     emits <em> content as a plain unstyled run (all italics silently lost).
  //   - Nested tags keep only the INNERMOST format (<b><i>x</i></b> → italic
  //     only), so ***bold italic*** degrades to italic — the reader-critical
  //     channel for fiction. A library upgrade is the real fix for bold+italic.
  // Span edges require a non-space character so inline asterisks ("5 * 3")
  // and 4+-star divider lines are never eaten; the underscore variants also
  // require a non-word boundary so intra-word underscores survive.
  text = text.replace(/\*\*\*([^\s*](?:[^*]*[^\s*])?)\*\*\*/g, "<b><i>$1</i></b>");
  text = text.replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(
    /(?<![\p{L}\p{N}_])__([^\s_](?:[^_]*[^\s_])?)__(?![\p{L}\p{N}_])/gu,
    "<strong>$1</strong>",
  );
  text = text.replace(/\*([^\s*](?:[^*]*[^\s*])?)\*/g, "<i>$1</i>");
  text = text.replace(
    /(?<![\p{L}\p{N}_])_([^\s_](?:[^_]*[^\s_])?)_(?![\p{L}\p{N}_])/gu,
    "<i>$1</i>",
  );
  return text;
}
