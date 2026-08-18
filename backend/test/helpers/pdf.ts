// ── Building PDFs by hand, for tests ──
//
// PDF reconstruction is inference from geometry: a 12pt gap is a line wrap, a
// 24pt gap is a paragraph break. Testing that needs input whose coordinates are
// known exactly, which no converter gives you — `cupsfilter` produces monospace
// text hard-wrapped mid-word, nothing like a typeset book.
//
// So the fixtures are written directly. Uncompressed PDF is a plain-text format
// and this emits just enough of it: a catalogue, a page tree, one content
// stream of positioned text runs per page, and the base-14 fonts, which every
// reader has built in and which carry real italic and bold names for the
// emphasis detection to find.

/** One run of text placed at an exact point on the page. */
export interface PdfTextRun {
  text: string;
  /** Points from the left edge. */
  x: number;
  /** Points from the BOTTOM edge, as PDF measures it. */
  y: number;
  size?: number;
  font?: "roman" | "italic" | "bold" | "bolditalic";
}

export interface PdfPage {
  runs: PdfTextRun[];
}

const FONTS = {
  roman: { key: "F1", base: "Times-Roman" },
  italic: { key: "F2", base: "Times-Italic" },
  bold: { key: "F3", base: "Times-Bold" },
  bolditalic: { key: "F4", base: "Times-BoldItalic" },
};

/** Escape the three characters that end a PDF string literal. */
function pdfString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function contentStream(page: PdfPage): string {
  const parts: string[] = [];
  for (const run of page.runs) {
    const font = FONTS[run.font ?? "roman"];
    parts.push(
      "BT",
      `/${font.key} ${run.size ?? 12} Tf`,
      `1 0 0 1 ${run.x} ${run.y} Tm`,
      `(${pdfString(run.text)}) Tj`,
      "ET",
    );
  }
  return parts.join("\n");
}

/**
 * A valid single- or multi-page PDF.
 *
 * Objects are written in order and their byte offsets recorded as they go,
 * because the cross-reference table has to point at each one exactly — a wrong
 * offset is the difference between a document and a parse error.
 */
export function buildPdf(pages: PdfPage[]): Buffer {
  const objects: string[] = [];
  const pageCount = pages.length;

  // 1: catalogue, 2: page tree, then per page an object and a content stream,
  // then the four fonts.
  const firstPageObj = 3;
  const pageObjIds = pages.map((_, i) => firstPageObj + i * 2);
  const fontFirstId = firstPageObj + pageCount * 2;

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageObjIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] /Count ${pageCount} >>`,
  );

  const fontRes = Object.values(FONTS)
    .map((f, i) => `/${f.key} ${fontFirstId + i} 0 R`)
    .join(" ");

  pages.forEach((page, i) => {
    const contentId = pageObjIds[i] + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << ${fontRes} >> >> /Contents ${contentId} 0 R >>`,
    );
    const stream = contentStream(page);
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });

  for (const f of Object.values(FONTS)) {
    objects.push(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`,
    );
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

/** Lines of prose down a page at a fixed leading, the shape of a typeset book. */
export function paragraph(
  lines: string[],
  opts: { top: number; leading?: number; x?: number; font?: PdfTextRun["font"] },
): PdfTextRun[] {
  const leading = opts.leading ?? 14;
  return lines.map((text, i) => ({
    text,
    x: opts.x ?? 72,
    y: opts.top - i * leading,
    font: opts.font,
  }));
}
