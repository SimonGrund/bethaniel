// ── Markdown → DOCX, built programmatically ──
//
// Replaces html-to-docx@1.8, which was abandoned (last published 2023-03-26),
// carried two unpatched image-size advisories through an inlined bundle, and had
// two defects this file exists to fix:
//   - nested emphasis kept only the innermost tag, so ***bold italic*** degraded
//     to italic — the reader-critical channel for fiction
//   - empty paragraphs were dropped unless padded with &#160;
//
// Block structure comes from the shared walker in mdBlocks.ts, so this and the
// HTML/EPUB path cannot drift structurally. Inline handling is deliberately
// separate: the two targets no longer have the same capabilities.

import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

import { parseMdBlocks, type MdBlock } from "./mdBlocks.js";
import { readImageDimensions } from "./imageDimensions.js";

/** Half-points: Word's unit for font size. 24 = 12pt. */
const FONT_SIZE_HALF_POINTS = 24;
const FONT = "Times New Roman";
/** Twips per line at single spacing — Word's unit for `w:line`. */
const TWIPS_PER_LINE = 240;
/**
 * Widest an embedded image may render, in pixels at 96 dpi — the unit `docx`
 * transformations use. 576px = 6in, the text width of a US Letter page with
 * one-inch margins. Only a fallback: an image whose display size the document
 * recorded is shown at that size instead.
 */
const MAX_IMAGE_WIDTH_PX = 576;

export interface DocxBuildOptions {
  sectionBreak: "asterisks" | "dash" | "blank";
  minorBreak: "blank" | "hash";
  lineSpacing: number;
  /** Start each chapter on a new page. See DocxExportOptions for why it is off. */
  chapterPageBreaks?: boolean;
}

/** Resolves a markdown image reference to bytes, or null when unavailable. */
export type ImageBytesResolver = (src: string) => Buffer | null;

/**
 * The size the author displayed an image at, in pixels at 96 dpi, or null when
 * the document kept no such record (a .md upload, or a .docx imported before
 * sizes were preserved).
 */
export type ImageSizeResolver = (src: string) => { width: number; height: number } | null;

type Inline =
  | { kind: "text"; text: string; bold: boolean; italic: boolean }
  | { kind: "image"; src: string; alt: string };

/**
 * Split one line into formatted spans.
 *
 * Images are matched before emphasis so a URL containing underscores or
 * asterisks is not mangled — the same ordering the HTML path relies on.
 * Emphasis is matched longest-marker-first (*** before ** before *).
 *
 * Emphasis content is parsed AGAIN rather than taken as flat text, because
 * mammoth's <strong><em> and <em><strong> reach us through turndown as
 * `**_text_**` and `_**text**_` — never as `***text***`. A flat parser kept
 * only the outer marker, so every bold-italic phrase imported from Word lost
 * half its emphasis on export.
 */
export function parseInline(line: string): Inline[] {
  return parseInlineInto(line, false, false);
}

function parseInlineInto(
  line: string,
  bold: boolean,
  italic: boolean,
): Inline[] {
  const out: Inline[] = [];
  const pattern =
    /!\[([^\]]*)\]\(([^)]+)\)|(\*\*\*|___)(.+?)\3|(\*\*|__)(.+?)\5|(\*|_)(.+?)\7/g;

  let last = 0;
  let m: RegExpExecArray | null;
  const push = (text: string) => {
    if (text) out.push({ kind: "text", text, bold, italic });
  };
  // Inherit the enclosing emphasis; a nested marker only ever adds to it.
  const descend = (text: string, addBold: boolean, addItalic: boolean) => {
    out.push(...parseInlineInto(text, bold || addBold, italic || addItalic));
  };

  while ((m = pattern.exec(line)) !== null) {
    push(line.slice(last, m.index));
    if (m[2] !== undefined) {
      out.push({ kind: "image", src: m[2], alt: m[1] ?? "" });
    } else if (m[4] !== undefined) {
      descend(m[4], true, true);
    } else if (m[6] !== undefined) {
      descend(m[6], true, false);
    } else if (m[8] !== undefined) {
      descend(m[8], false, true);
    }
    last = pattern.lastIndex;
  }
  push(line.slice(last));
  return out;
}

/** Pixel size from the file itself, capped to a sensible page width. */
function intrinsicSize(bytes: Buffer): { width: number; height: number } | null {
  const dim = readImageDimensions(bytes);
  if (!dim) return null;
  const scale = Math.min(1, MAX_IMAGE_WIDTH_PX / dim.width);
  return {
    width: Math.round(dim.width * scale),
    height: Math.round(dim.height * scale),
  };
}

function runsFor(
  line: string,
  resolveImage: ImageBytesResolver | undefined,
  resolveSize: ImageSizeResolver | undefined,
): (TextRun | ImageRun)[] {
  const runs: (TextRun | ImageRun)[] = [];
  for (const node of parseInline(line)) {
    if (node.kind === "text") {
      // Only set the flags when true. Passing `false` makes the library emit
      // <w:b w:val="false"/> on every plain run — noise in the XML, and it
      // defeats any downstream check for "is this run bold".
      runs.push(
        new TextRun({
          text: node.text,
          ...(node.bold ? { bold: true } : {}),
          ...(node.italic ? { italics: true } : {}),
          font: FONT,
          size: FONT_SIZE_HALF_POINTS,
        }),
      );
      continue;
    }
    // Images need explicit dimensions; without them we drop the image rather
    // than emit an ImageRun Word will refuse to open.
    const bytes = resolveImage?.(node.src);
    if (!bytes) continue;
    // The size the author chose beats anything derived from the file. Only when
    // no such record exists do we fall back to the intrinsic pixels, bounded so
    // a large photo cannot run off the page.
    const size = resolveSize?.(node.src) ?? intrinsicSize(bytes);
    if (!size) continue;
    runs.push(
      new ImageRun({
        // The library infers the type from the bytes; png is a safe declared
        // default for the formats we extract.
        type: "png",
        data: bytes,
        transformation: size,
      }),
    );
  }
  return runs;
}

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function sceneBreakParagraph(
  style: DocxBuildOptions["sectionBreak"],
  spacing: { line: number },
): Paragraph {
  const margins = { before: 240, after: 240, line: spacing.line };
  if (style === "blank") {
    return new Paragraph({
      spacing: margins,
      children: [new TextRun({ text: " ", font: FONT, size: FONT_SIZE_HALF_POINTS })],
    });
  }
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: margins,
    children: [
      new TextRun({
        text: style === "dash" ? "—" : "***",
        font: FONT,
        size: FONT_SIZE_HALF_POINTS,
      }),
    ],
  });
}

function minorBreakParagraph(
  style: DocxBuildOptions["minorBreak"],
  spacing: { line: number },
): Paragraph {
  // No &#160; padding needed: unlike html-to-docx, an empty paragraph survives.
  return new Paragraph({
    alignment: style === "hash" ? AlignmentType.CENTER : undefined,
    spacing,
    children: [
      new TextRun({
        text: style === "hash" ? "#" : " ",
        font: FONT,
        size: FONT_SIZE_HALF_POINTS,
      }),
    ],
  });
}

function blockToParagraphs(
  block: MdBlock,
  opts: DocxBuildOptions,
  resolveImage: ImageBytesResolver | undefined,
  resolveSize: ImageSizeResolver | undefined,
): Paragraph[] {
  const spacing = { line: Math.round(TWIPS_PER_LINE * opts.lineSpacing) };

  switch (block.kind) {
    case "paragraph": {
      const children: (TextRun | ImageRun)[] = [];
      block.lines.forEach((line, i) => {
        // A single newline inside a paragraph is a soft break, not a new one.
        if (i > 0) children.push(new TextRun({ break: 1 }));
        children.push(...runsFor(line, resolveImage, resolveSize));
      });
      return [new Paragraph({ spacing, children })];
    }
    case "pagebreak":
      return [new Paragraph({ children: [new PageBreak()] })];
    case "sceneBreak":
      return [sceneBreakParagraph(opts.sectionBreak, spacing)];
    case "minorBreak":
      return [minorBreakParagraph(opts.minorBreak, spacing)];
    case "heading": {
      const out: Paragraph[] = [];
      // `needsPageBreak` is the HTML path's chapter convention, not something
      // the author wrote. Real breaks arrive as their own "pagebreak" block.
      if (block.needsPageBreak && opts.chapterPageBreaks) {
        out.push(new Paragraph({ children: [new PageBreak()] }));
      }
      out.push(
        new Paragraph({
          heading: HEADING_LEVELS[Math.min(block.level, 6) - 1],
          spacing,
          children: runsFor(block.text, resolveImage, resolveSize),
        }),
      );
      return out;
    }
  }
}

/** Build a .docx from markdown. */
export async function buildDocx(
  md: string,
  opts: DocxBuildOptions,
  resolveImage?: ImageBytesResolver,
  resolveSize?: ImageSizeResolver,
): Promise<Buffer> {
  const paragraphs = parseMdBlocks(md).flatMap((b) =>
    blockToParagraphs(b, opts, resolveImage, resolveSize),
  );

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: FONT_SIZE_HALF_POINTS },
        },
      },
    },
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: FONT,
                    size: FONT_SIZE_HALF_POINTS,
                  }),
                ],
              }),
            ],
          }),
        },
        children: paragraphs.length
          ? paragraphs
          : [new Paragraph({ children: [] })],
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
