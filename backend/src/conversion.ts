// ── File conversion (pure JS — no external binaries) ──

import JSZip from "jszip";
import mammoth from "mammoth";
import TurndownService from "turndown";
import HTMLtoDOCX from "html-to-docx";
import { PAGEBREAK_MARKER } from "./chapters.js";

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
export async function extractPagebreaksFromDocx(
  docxBuffer: Buffer,
): Promise<number[]> {
  try {
    const zip = await JSZip.loadAsync(docxBuffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    if (!docXml) return [];

    const breaks: number[] = [];
    const paragraphs = docXml.split(/<w:p[ >]/);

    for (let pIndex = 0; pIndex < paragraphs.length; pIndex++) {
      const p = paragraphs[pIndex];
      let found = false;

      if (/<w:br[^>]*w:type="page"/.test(p)) {
        found = true;
      }
      if (!found && /<w:pageBreakBefore/.test(p)) {
        const valMatch = p.match(/<w:pageBreakBefore[^>]*w:val="([^"]+)"/);
        if (
          !valMatch ||
          ["true", "1", "on"].includes(valMatch[1].toLowerCase())
        ) {
          found = true;
        }
      }
      if (!found && /<w:sectPr/.test(p)) {
        const typeMatch = p.match(
          /<w:type[^>]*w:val="(nextPage|oddPage|evenPage)"/,
        );
        if (typeMatch) found = true;
      }

      if (found) breaks.push(pIndex);
    }
    return breaks;
  } catch {
    return [];
  }
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

  let text = turndown.turndown(result.value);

  // Inject pagebreak markers
  const pbs = await extractPagebreaksFromDocx(docxBuffer);
  if (pbs.length > 0) {
    const blocks = text.split(/\n\s*\n/);
    const pbSet = new Set(pbs);
    const outBlocks: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      if (pbSet.has(i) && i > 0) {
        outBlocks.push(PAGEBREAK_MARKER);
      }
      outBlocks.push(blocks[i]);
    }
    text = outBlocks.join("\n\n");
  }
  return text;
}

/** Convert Markdown to .docx, return the binary buffer. */
export async function markdownToDocx(md: string): Promise<Buffer> {
  // Convert markdown to simple HTML for docx generation
  const html = mdToHtml(md);
  const docxBuffer = await HTMLtoDOCX(html, undefined, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  });
  return Buffer.from(docxBuffer as ArrayBuffer);
}

/** Minimal Markdown → HTML converter for export (headings, bold, italic, paragraphs, pagebreaks). */
function mdToHtml(md: string): string {
  const lines = md.split("\n");
  const htmlLines: string[] = [];

  for (const line of lines) {
    let processed = line;

    // Pagebreak marker → page break in DOCX
    if (processed.trim() === PAGEBREAK_MARKER) {
      htmlLines.push(
        `<p style="page-break-before:always;margin:0;padding:0;line-height:0;font-size:0">&nbsp;</p>`,
      );
      continue;
    }

    // Headings
    const headingMatch = processed.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlLines.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Empty line = paragraph break
    if (processed.trim() === "") {
      htmlLines.push("");
      continue;
    }

    // Regular paragraph
    htmlLines.push(`<p>${inlineFormat(processed)}</p>`);
  }

  return htmlLines.join("\n");
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
