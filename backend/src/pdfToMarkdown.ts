// ── PDF → Markdown ──
//
// PDF is a layout format, not a document format. It records where each glyph
// sits and nothing about what a paragraph is, so a page arrives as a scatter of
// positioned fragments — often one per word, with the spaces between them
// implied by coordinates rather than written down.
//
// Everything the editor needs is inferred here:
//   fragments → lines (same baseline)
//             → prose (running heads and page numbers removed)
//             → paragraphs (a wider vertical gap than the leading)
//             → markdown (emphasis from font names, headings from font size)
//
// The inference is good, not perfect, and it degrades in the honest direction:
// a missed paragraph break joins two paragraphs, it never invents text. What it
// cannot do is go back — a PDF has no text flow to write corrections into, so
// this is import-only and the UI says so before the file is accepted.
//
// Images are dropped. pdfjs exposes them as decoded bitmaps rather than the
// original encoded files, so restoring them would mean re-encoding every one
// and guessing its place in a text flow that PDF does not define.

/** A file that is not a readable PDF — truncated, corrupt, or encrypted. */
export class PdfReadError extends Error {
  constructor(detail: string) {
    super(`This PDF could not be read (${detail}). It may be damaged or password-protected.`);
    this.name = "PdfReadError";
  }
}

/**
 * A PDF whose text comes out as gibberish.
 *
 * Subset-embedded fonts carry no ToUnicode map when the producer omits one, and
 * then the codes in the content stream are glyph indices with no relation to
 * Unicode. The page looks perfect and the text is a substitution cipher:
 * "the forces" arrives as "the Horces", "they" as "theN". Print-ready files are
 * the common source.
 *
 * It cannot be undone reliably — recovering it means solving a cipher — and for
 * a copy-editor, confidently wrong text is the worst possible outcome.
 */
export class GarbledPdfError extends Error {
  constructor() {
    super(
      "This PDF's text cannot be read correctly — its fonts carry no character " +
        "map, so the text extracts as gibberish. This is common in print-ready " +
        "files. Use the Word document or the file you typeset from instead.",
    );
    this.name = "GarbledPdfError";
  }
}

/** A PDF with no text layer at all — a scan or a photographed book. */
export class ScannedPdfError extends Error {
  constructor() {
    super(
      "This PDF has no text in it — it looks like a scan. Betty cannot read " +
        "scanned pages.",
    );
    this.name = "ScannedPdfError";
  }
}

interface Fragment {
  text: string;
  x: number;
  y: number;
  /** Font size in points; the tallest line on a page is usually its heading. */
  size: number;
  italic: boolean;
  bold: boolean;
  page: number;
  /** Right edge, for deciding whether a space belongs before the next run. */
  endX: number;
  /** Whether the font declared a ToUnicode map; without one, text is suspect. */
  mapped: boolean;
}

interface Line {
  text: string;
  y: number;
  x: number;
  size: number;
  page: number;
}

/** Same baseline, allowing for the sub-point jitter typesetters introduce. */
const BASELINE_TOLERANCE = 2;
/** A gap wider than the leading by this much starts a new paragraph. */
const PARAGRAPH_GAP_RATIO = 1.35;
/** A line this much taller than the body text is a heading. */
const HEADING_SIZE_RATIO = 1.25;

// pdfjs ships ESM; the legacy build is the one that runs under Node without a
// browser worker, which is what the backend needs.
async function loadPdfjs() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
}

/** Every positioned text fragment in the document, in reading order. */
async function readFragments(buffer: Buffer): Promise<Fragment[]> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    // The app is offline; never let a document send us looking for resources.
    disableFontFace: true,
    isEvalSupported: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    // A file the user chose, not a server fault. Say which so they can act.
    throw new PdfReadError(
      err instanceof Error ? err.message.replace(/\.$/, "") : "unknown error",
    );
  }

  const out: Fragment[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    // Populates commonObjs, which is the only place the real font names live —
    // getTextContent's `styles` reports nothing but "serif".
    await page.getOperatorList();
    const content = await page.getTextContent();

    for (const item of content.items) {
      if (typeof item.str !== "string" || item.str.trim() === "") continue;
      let italic = false;
      let bold = false;
      let mapped = true;
      try {
        const font = page.commonObjs.get(item.fontName);
        italic = Boolean(font?.italic);
        bold = Boolean(font?.bold);
        mapped = Boolean(font?.toUnicode);
      } catch {
        // A font we cannot resolve costs emphasis on that run, nothing more.
      }
      const width = typeof item.width === "number" ? item.width : 0;
      out.push({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        size: item.height || Math.abs(item.transform[3]) || 12,
        italic,
        bold,
        page: p,
        endX: item.transform[4] + width,
        mapped,
      });
    }
    page.cleanup();
  }
  // The document owns worker-side memory; releasing it matters when a user
  // uploads several manuscripts in one session.
  await doc.cleanup?.();
  await task.destroy?.();
  return out;
}

/** Markdown emphasis for a run, chosen to match what the DOCX path emits. */
function emphasise(text: string, italic: boolean, bold: boolean): string {
  if (!text.trim()) return text;
  // Markers must sit outside the text but inside its surrounding spaces, or the
  // markdown does not render.
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  if (bold && italic) return `${lead}**_${core}_**${trail}`;
  if (bold) return `${lead}**${core}**${trail}`;
  if (italic) return `${lead}_${core}_${trail}`;
  return text;
}

/** Fragments sharing a baseline, joined with the spaces their gaps imply. */
function assembleLines(fragments: Fragment[], bodySize: number): Line[] {
  const lines: Line[] = [];
  const pages = new Map<number, Fragment[]>();
  for (const f of fragments) {
    const list = pages.get(f.page);
    if (list) list.push(f);
    else pages.set(f.page, [f]);
  }

  for (const page of [...pages.keys()].sort((a, b) => a - b)) {
    const all = pages.get(page)!;
    // Held back from row assembly: a drop cap shares a baseline with a line it
    // does not belong to, and merging it there is what produced "# Dof storms".
    const caps = all.filter((f) => isDropCap(f, bodySize));
    const items = caps.length ? all.filter((f) => !caps.includes(f)) : all;
    const rows: Fragment[][] = [];
    for (const f of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].y - f.y) <= BASELINE_TOLERANCE) row.push(f);
      else rows.push([f]);
    }

    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      let text = "";
      let prev: Fragment | null = null;
      for (const f of row) {
        // PDFs usually omit the space between words and let the offset say it.
        if (
          prev &&
          !/\s$/.test(text) &&
          !/^\s/.test(f.text) &&
          f.x - prev.endX > prev.size * 0.15
        ) {
          text += " ";
        }
        text += emphasise(f.text, f.italic, f.bold);
        prev = f;
      }
      // Adjacent runs in the same style produce `_a__b_`; make them one span.
      text = text.replace(/__/g, "").replace(/\*\*\*\*/g, "");
      lines.push({
        text: text.trim(),
        y: row[0].y,
        x: row[0].x,
        size: Math.max(...row.map((f) => f.size)),
        page,
      });
    }

    for (const cap of caps) {
      // The topmost line that starts to the right of the cap and no higher than
      // its own top edge: the first line of the paragraph it opens.
      const capTop = cap.y + cap.size;
      const target = lines
        .filter(
          (l) => l.page === page && l.x > cap.x + 1 && l.y <= capTop && l.y >= cap.y,
        )
        .sort((a, b) => b.y - a.y)[0];
      if (target) {
        target.text = cap.text.trim() + target.text;
      } else {
        // Nothing to attach to — keep the letter rather than lose it.
        lines.push({ text: cap.text.trim(), y: cap.y, x: cap.x, size: cap.size, page });
      }
    }
  }
  return lines;
}

/** Digits masked, so "Page 3" and "Page 4" count as the same furniture. */
function furnitureKey(line: Line): string {
  return `${Math.round(line.y)}|${line.text.replace(/\d+/g, "#").toLowerCase()}`;
}

/**
 * Remove running heads, feet and page numbers.
 *
 * They repeat at the same height on page after page, which is exactly what
 * prose never does. Left in, they land in the middle of a sentence.
 */
function stripFurniture(lines: Line[], pageCount: number): Line[] {
  if (pageCount < 3) return lines;

  const seen = new Map<string, Set<number>>();
  for (const line of lines) {
    const key = furnitureKey(line);
    const pages = seen.get(key);
    if (pages) pages.add(line.page);
    else seen.set(key, new Set([line.page]));
  }

  // Only the outermost line on a page can be furniture. Masking digits makes
  // "Chapter 3" and "Chapter 4" match, but it also makes two different lines of
  // prose match if they differ only by a number — and repetition alone would
  // then strip the body of the book. Position is the property that actually
  // separates a running head from a sentence.
  const edges = new Set<Line>();
  for (const page of new Set(lines.map((l) => l.page))) {
    const onPage = lines.filter((l) => l.page === page);
    if (onPage.length < 3) continue;
    edges.add(onPage.reduce((a, b) => (a.y >= b.y ? a : b)));
    edges.add(onPage.reduce((a, b) => (a.y <= b.y ? a : b)));
  }

  const threshold = Math.max(2, Math.ceil(pageCount / 2));
  return lines.filter((line) => {
    // A line that is nothing but a number is a page number wherever it sits.
    if (/^\d{1,4}$/.test(line.text.trim())) return false;
    if (!edges.has(line)) return true;
    return (seen.get(furnitureKey(line))?.size ?? 0) < threshold;
  });
}

/**
 * The body leading — the gap between two lines of the same paragraph.
 *
 * Taken as a low percentile of the gaps rather than the commonest one. The mode
 * is the paragraph gap whenever a document has more paragraph breaks than
 * wrapped lines, which is true of anything short, and then nothing ever splits.
 * Leading is by definition the tightest regular spacing on the page, so a low
 * percentile finds it — and unlike the raw minimum it shrugs off a superscript
 * or a stray fragment sitting a point off its baseline.
 */
function bodyLeading(lines: Line[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].page !== lines[i - 1].page) continue;
    const gap = Math.round(lines[i - 1].y - lines[i].y);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 14;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length * 0.2)];
}

/** The commonest font size: the body text, against which headings stand out. */
function modalSize(lines: Line[]): number {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const size = Math.round(line.size);
    // Weighted by characters: a chapter heading is one short line among many
    // long ones, and counting lines would let it pass for the body size.
    counts.set(size, (counts.get(size) ?? 0) + line.text.length);
  }
  let best = 12;
  let bestCount = 0;
  for (const [size, n] of counts) {
    if (n > bestCount) {
      best = size;
      bestCount = n;
    }
  }
  return best;
}

/** Whether a line ends a sentence, used where geometry runs out. */
function looksFinished(text: string): boolean {
  return /[.!?…]["'”’)\]]?\s*$/.test(text);
}

/**
 * Rejoin a word split across lines.
 *
 * A trailing hyphen before a lowercase continuation is typesetting and comes
 * out; before a capital it is part of the word ("well-Known") and stays.
 */
function joinWrapped(left: string, right: string): string {
  if (/[-‐]$/.test(left)) {
    // Lowercase continuation: typesetting split a word, so close it up.
    if (/^[a-zà-öø-ÿ]/.test(right)) return left.slice(0, -1) + right;
    // Otherwise the hyphen belongs to the word ("well-Known") — keep it, but
    // still without a space, or the compound comes apart.
    return left + right;
  }
  return `${left} ${right}`;
}

interface Block {
  text: string;
  size: number;
}

/** Group lines into paragraphs, using the leading as the unit of measure. */
function buildBlocks(lines: Line[]): Block[] {
  const leading = bodyLeading(lines);
  const blocks: Block[] = [];
  let current: Line[] = [];

  const flush = () => {
    if (current.length === 0) return;
    let text = current[0].text;
    for (let i = 1; i < current.length; i++) {
      text = joinWrapped(text, current[i].text);
    }
    blocks.push({ text, size: Math.max(...current.map((l) => l.size)) });
    current = [];
  };

  for (const line of lines) {
    if (current.length === 0) {
      current.push(line);
      continue;
    }
    const prev = current[current.length - 1];
    let breaks: boolean;
    if (line.page !== prev.page) {
      // Geometry says nothing across a page boundary. A finished sentence is
      // the only evidence available, and it is usually right.
      breaks = looksFinished(prev.text);
    } else {
      const gap = prev.y - line.y;
      // A first-line indent starts a paragraph even when the gap does not.
      const indented = line.x > prev.x + 4;
      // So does a change of size: a heading and the prose under it are never
      // the same block, however tightly they are set.
      const resized = Math.abs(line.size - prev.size) > 1;
      breaks = gap > leading * PARAGRAPH_GAP_RATIO || indented || resized;
    }
    if (breaks) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

/** Markdown, with oversized lines promoted to headings. */
function render(blocks: Block[], bodySize: number): string {
  const out: string[] = [];
  for (const block of blocks) {
    const heading =
      block.size >= bodySize * HEADING_SIZE_RATIO && block.text.length <= 120;
    if (heading) {
      // Emphasis markers on a heading are noise once it is a heading.
      const bare = block.text.replace(/^[*_]+/, "").replace(/[*_]+$/, "");
      out.push(`# ${bare}`);
    } else {
      out.push(block.text);
    }
  }
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * Share of words carrying a capital after their first letter.
 *
 * Near zero in any real prose, in any language. A glyph-index cipher maps
 * lowercase letters onto whatever character sits at that index, and capitals
 * land mid-word constantly — "Horces", "theN", "instantlN". Measured at 6.4% on
 * the file that prompted this, against 0.0% on every sample manuscript in the
 * repo, English, Danish, German and Spanish alike.
 *
 * Deliberately not a dictionary check: the cipher only remaps a handful of
 * glyphs, so most words survive and function-word frequency cannot tell the two
 * apart — measured 26.5% garbled against 23.5% for real German.
 */
function midWordCapitalRate(text: string): number {
  const words = text.match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ']{2,}/g) ?? [];
  if (words.length < 200) return 0;
  const odd = words.filter((w) => /[A-ZÀ-Þ]/.test(w.slice(1))).length;
  return odd / words.length;
}

/** Above this share of mid-word capitals, with unmapped fonts, text is a cipher. */
const GARBLED_CAPITAL_RATE = 0.02;

/**
 * Drop caps.
 *
 * A drop cap spans two or three lines, so its baseline sits with the SECOND or
 * third line of the paragraph, not the first. Assembled naively it is glued to
 * the wrong line and — being several times the body size — promoted to a
 * heading: the opening "D" of "Dust haze hung over Tabahi" became a heading
 * reading "# Dof storms", and the paragraph began "ust haze".
 *
 * It belongs at the start of the topmost line indented past it.
 */
function isDropCap(f: Fragment, bodySize: number): boolean {
  return /^[A-Za-zÀ-Þ]$/.test(f.text.trim()) && f.size >= bodySize * 1.8;
}

/**
 * Read a PDF into markdown.
 *
 * Throws ScannedPdfError when there is no text layer, so the caller can say why
 * rather than hand the user an empty manuscript.
 */
export async function pdfToMarkdown(buffer: Buffer): Promise<string> {
  const fragments = await readFragments(buffer);
  if (fragments.length === 0) throw new ScannedPdfError();

  const pageCount = Math.max(...fragments.map((f) => f.page));

  // Body size first: drop-cap detection needs it, and it is read from the
  // fragments rather than the lines so a drop cap cannot skew its own test.
  const sizeWeights = new Map<number, number>();
  for (const f of fragments) {
    const size = Math.round(f.size);
    sizeWeights.set(size, (sizeWeights.get(size) ?? 0) + f.text.length);
  }
  let bodySize = 12;
  let heaviest = 0;
  for (const [size, weight] of sizeWeights) {
    if (weight > heaviest) {
      bodySize = size;
      heaviest = weight;
    }
  }

  const lines = stripFurniture(
    assembleLines(fragments, bodySize),
    pageCount,
  ).filter((l) => l.text.trim() !== "");
  if (lines.length === 0) throw new ScannedPdfError();

  const markdown = render(buildBlocks(lines), bodySize);

  // Fonts without a ToUnicode map give glyph indices, not characters. That
  // alone is not proof — a standard-encoded font decodes fine without one — so
  // the text itself has to look wrong too before we refuse it.
  const unmapped = fragments
    .filter((f) => !f.mapped)
    .reduce((n, f) => n + f.text.length, 0);
  const total = fragments.reduce((n, f) => n + f.text.length, 0);
  if (
    total > 0 &&
    unmapped / total > 0.5 &&
    midWordCapitalRate(markdown) >= GARBLED_CAPITAL_RATE
  ) {
    throw new GarbledPdfError();
  }

  return markdown;
}
