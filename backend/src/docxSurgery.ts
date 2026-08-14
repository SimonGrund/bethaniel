// ── Surgical DOCX editing ──
//
// Rewrite the text inside <w:t> elements of word/document.xml and leave every
// other byte alone. Fonts, colours, highlights, spacing, text boxes, tables,
// headers, footnotes and images survive because nothing regenerates them — the
// other parts of the zip are never opened.
//
// Deliberately NOT an XML parse/serialize round trip. Re-serializing rewrites
// attribute order and self-closing forms across the whole file, which is the
// main way exotic Word features break. This scans, then splices bytes.
//
// The guarantee: an edit is applied only when it can be applied without
// altering formatting. Anything else is skipped and reported. There is no
// policy parameter — a guarantee you can switch off is not one.

import JSZip from "jszip";

export interface TextNode {
  /** Ordinal of the containing <w:r> within its paragraph. */
  runIndex: number;
  /** "virtual" nodes (<w:tab/>, <w:br/>, …) hold a character but no content range. */
  kind: "t" | "virtual";
  /** Offset of the first character inside <w:t>. */
  xmlStart: number;
  /** Offset of the "<" in "</w:t>". */
  xmlEnd: number;
  /** Offset just past the ">" that ends the <w:t …> open tag. */
  openTagEnd: number;
  preserve: boolean;
  /** Entity-decoded text. */
  text: string;
  /** Offset of this node's text within the paragraph's plain text. */
  textStart: number;
  /** Raw <w:rPr>…</w:rPr> bytes — the run's formatting identity. */
  rPrXml: string;
}

export interface DocxParagraph {
  /** Ordinal among all <w:p> in document order, counted at the opening tag. */
  index: number;
  /** 0 = body level; >0 = nested (e.g. inside w:txbxContent). */
  depth: number;
  inTable: boolean;
  isEmpty: boolean;
  /** A page/section break starts at this paragraph. */
  isPageBreak: boolean;
  /** Carries a drawing, picture or embedded object. */
  hasObject: boolean;
  /** Saw a <w:t> element, even an empty one — matches the old predicate. */
  sawTextElement: boolean;
  text: string;
  nodes: TextNode[];
}

export interface DocxTextIndex {
  xml: string;
  paragraphs: DocxParagraph[];
}

/** A replacement expressed in a paragraph's plain-text coordinates. */
export interface ParagraphTextEdit {
  start: number;
  end: number;
  replacement: string;
}

export interface Splice {
  xmlStart: number;
  xmlEnd: number;
  text: string;
  /** Set when the <w:t> open tag needs xml:space="preserve" added. */
  addPreserveAt?: number;
}

export interface SkippedEdit extends ParagraphTextEdit {
  paragraphIndex: number;
  original: string;
  /**
   * The passage around the change, so a user can search for it in Word.
   *
   * A skipped edit is only actionable if its place can be found: "shaky" alone
   * is unsearchable, the sentence holding it is not.
   */
  context: string;
  reason:
    | "mixed-formatting"
    | "virtual-node"
    | "out-of-range"
    | "unmappable-paragraph";
}

// ── Entities ──

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeEntities(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One character each, so plain-text offsets line up with what Word renders. */
const VIRTUAL: Record<string, string> = {
  "w:tab": "\t",
  "w:br": "\n",
  "w:cr": "\n",
  "w:noBreakHyphen": "-",
  "w:softHyphen": "­",
  "w:sym": "�",
};

const TAG_RE = /<(\/?)([A-Za-z0-9:_.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/**
 * Scan word/document.xml into paragraphs and their text nodes.
 *
 * Depth-aware: a <w:p> inside <w:txbxContent> is its own paragraph, not part of
 * the enclosing one. The regex this replaces terminated the outer paragraph at
 * the inner `</w:p>`, which silently misaligned every document with a text box.
 */
export function indexDocumentXml(xml: string): DocxTextIndex {
  const paragraphs: DocxParagraph[] = [];
  const stack: DocxParagraph[] = [];

  let tblDepth = 0;
  let fallbackDepth = 0; // inside mc:Fallback — a duplicate of mc:Choice
  let skipTextDepth = 0; // inside w:delText / w:instrText
  let sectPrDepth = 0;
  let runIndex = -1;
  let rPrStart = -1;
  let currentRPr = "";

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(xml)) !== null) {
    const [full, closing, name, , selfClose] = m;
    const isClose = closing === "/";
    const isSelf = selfClose === "/";
    const tagEnd = m.index + full.length;

    // Alternate content: index the primary branch only.
    if (name === "mc:Fallback") {
      if (isClose) fallbackDepth = Math.max(0, fallbackDepth - 1);
      else if (!isSelf) fallbackDepth += 1;
      continue;
    }
    if (fallbackDepth > 0) continue;

    if (name === "w:tbl") {
      if (isClose) tblDepth = Math.max(0, tblDepth - 1);
      else if (!isSelf) tblDepth += 1;
      continue;
    }

    if (name === "w:p") {
      if (isSelf) {
        paragraphs.push({
          index: paragraphs.length,
          depth: stack.length,
          inTable: tblDepth > 0,
          isEmpty: true,
          isPageBreak: false,
          hasObject: false,
          sawTextElement: false,
          text: "",
          nodes: [],
        });
      } else if (isClose) {
        const done = stack.pop();
        if (done) done.isEmpty = done.text.length === 0;
      } else {
        const p: DocxParagraph = {
          index: paragraphs.length,
          depth: stack.length,
          inTable: tblDepth > 0,
          isEmpty: true,
          isPageBreak: false,
          hasObject: false,
          sawTextElement: false,
          text: "",
          nodes: [],
        };
        paragraphs.push(p);
        stack.push(p);
        runIndex = -1;
      }
      continue;
    }

    const p = stack[stack.length - 1];
    if (!p) continue;

    // Structural signals, gathered on the innermost open paragraph so a text
    // box's break does not leak onto the paragraph containing it.
    // Note the deliberate absence of `continue`: a page-break <w:br> still falls
    // through to the virtual-node handling below, so it occupies one character
    // exactly like any other break. Offsets must not depend on the break's kind.
    if (name === "w:br" && /w:type\s*=\s*"page"/.test(m[3])) {
      p.isPageBreak = true;
    }
    if (name === "w:pageBreakBefore" && !isClose) {
      const val = m[3].match(/w:val\s*=\s*"([^"]+)"/);
      if (!val || ["true", "1", "on"].includes(val[1].toLowerCase())) {
        p.isPageBreak = true;
      }
      continue;
    }
    if (name === "w:sectPr") {
      if (isClose) sectPrDepth = Math.max(0, sectPrDepth - 1);
      else if (!isSelf) sectPrDepth += 1;
      continue;
    }
    if (name === "w:type" && sectPrDepth > 0) {
      const val = m[3].match(/w:val\s*=\s*"(nextPage|oddPage|evenPage)"/);
      if (val) p.isPageBreak = true;
      continue;
    }
    if (name === "w:drawing" || name === "w:pict" || name === "w:object") {
      p.hasObject = true;
      continue;
    }

    if (name === "w:r" && !isClose && !isSelf) {
      runIndex += 1;
      currentRPr = "";
      continue;
    }

    // Capture the run's formatting bytes verbatim — this is the identity used
    // to decide whether an edit may span runs.
    if (name === "w:rPr") {
      if (isSelf) continue;
      if (isClose) {
        if (rPrStart >= 0) currentRPr = xml.slice(rPrStart, tagEnd);
        rPrStart = -1;
      } else {
        rPrStart = m.index;
      }
      continue;
    }

    if (name === "w:delText" || name === "w:instrText") {
      if (isSelf) continue;
      skipTextDepth += isClose ? -1 : 1;
      if (skipTextDepth < 0) skipTextDepth = 0;
      continue;
    }

    if (isSelf && VIRTUAL[name] !== undefined) {
      p.nodes.push({
        runIndex,
        kind: "virtual",
        xmlStart: m.index,
        xmlEnd: tagEnd,
        openTagEnd: tagEnd,
        preserve: false,
        text: VIRTUAL[name],
        textStart: p.text.length,
        rPrXml: currentRPr,
      });
      p.text += VIRTUAL[name];
      continue;
    }

    if (name === "w:t" && !isClose && skipTextDepth === 0) {
      p.sawTextElement = true;
      if (isSelf) continue;
      const close = xml.indexOf("</w:t>", tagEnd);
      if (close === -1) continue;
      const raw = xml.slice(tagEnd, close);
      const text = decodeEntities(raw);
      p.nodes.push({
        runIndex,
        kind: "t",
        xmlStart: tagEnd,
        xmlEnd: close,
        openTagEnd: tagEnd,
        preserve: /xml:space\s*=\s*"preserve"/.test(full),
        text,
        textStart: p.text.length,
        rPrXml: currentRPr,
      });
      p.text += text;
      TAG_RE.lastIndex = close;
      continue;
    }
  }

  for (const p of paragraphs) {
    p.isEmpty = !p.isPageBreak && !p.sawTextElement && !p.hasObject;
  }
  return { xml, paragraphs };
}

/**
 * Shrink an edit to the characters that actually differ.
 *
 * This is what keeps cross-run conflicts rare: a one-word fix inside a long
 * sentence collapses to a few characters and, in the overwhelming majority of
 * cases, lands inside a single run where formatting is preserved bit-for-bit.
 */
function trimEdit(original: string, e: ParagraphTextEdit): ParagraphTextEdit {
  const old = original.slice(e.start, e.end);
  let a = 0;
  while (a < old.length && a < e.replacement.length && old[a] === e.replacement[a]) {
    a++;
  }
  let b = 0;
  while (
    b < old.length - a &&
    b < e.replacement.length - a &&
    old[old.length - 1 - b] === e.replacement[e.replacement.length - 1 - b]
  ) {
    b++;
  }
  return {
    start: e.start + a,
    end: e.end - b,
    replacement: e.replacement.slice(a, e.replacement.length - b),
  };
}

/**
 * Turn paragraph-local edits into byte splices.
 *
 * An edit is applied when it touches one text node, or several whose formatting
 * is byte-identical. When it would span differing formatting there is no
 * formatting-preserving answer — a rewrite crossing an italic boundary cannot
 * say which characters are italic — so it is skipped and reported.
 */
/** Characters of surrounding text kept on each side of a skipped edit. */
const CONTEXT_CHARS = 80;

/**
 * The passage around an edit, widened to whole words and marked with ellipses
 * when it is genuinely an excerpt. A paragraph short enough to quote whole is
 * quoted whole — ellipses on a complete sentence would only mislead.
 */
export function excerpt(text: string, start: number, end: number): string {
  let from = Math.max(0, start - CONTEXT_CHARS);
  let to = Math.min(text.length, end + CONTEXT_CHARS);
  // Do not cut mid-word: a broken word is worse to search for than a shorter
  // excerpt.
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space !== -1 && space < start) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space !== -1 && space > end) to = space;
  }
  return (
    (from > 0 ? "…" : "") +
    text.slice(from, to).trim() +
    (to < text.length ? "…" : "")
  );
}

export function planParagraphSplices(
  p: DocxParagraph,
  edits: ParagraphTextEdit[],
): { splices: Splice[]; skipped: SkippedEdit[] } {
  const splices: Splice[] = [];
  const skipped: SkippedEdit[] = [];
  /** Per node: the local replacements it must absorb, applied together below. */
  const pending = new Map<
    TextNode,
    { from: number; to: number; insert: string }[]
  >();

  const skip = (e: ParagraphTextEdit, reason: SkippedEdit["reason"]) =>
    skipped.push({
      ...e,
      paragraphIndex: p.index,
      original: p.text.slice(e.start, e.end),
      context: excerpt(p.text, e.start, e.end),
      reason,
    });

  for (const raw of edits) {
    if (
      raw.start < 0 ||
      raw.end > p.text.length ||
      raw.start > raw.end ||
      !Number.isFinite(raw.start) ||
      !Number.isFinite(raw.end)
    ) {
      skip(raw, "out-of-range");
      continue;
    }

    const e = trimEdit(p.text, raw);
    if (e.start === e.end && e.replacement === "") continue; // no-op

    // Nodes the trimmed span touches. A zero-width insert attaches to the node
    // containing the insertion point.
    const touched = p.nodes.filter((n) => {
      const nEnd = n.textStart + n.text.length;
      return e.start < nEnd && e.end > n.textStart
        ? true
        : e.start === e.end && e.start >= n.textStart && e.start <= nEnd;
    });

    if (touched.length === 0) {
      skip(raw, "out-of-range");
      continue;
    }
    if (touched.some((n) => n.kind === "virtual")) {
      skip(raw, "virtual-node");
      continue;
    }
    if (touched.length > 1) {
      const fmt = new Set(touched.map((n) => n.rPrXml));
      if (fmt.size > 1) {
        skip(raw, "mixed-formatting");
        continue;
      }
    }

    // Record each node's share. The first touched node receives the whole
    // replacement; later ones simply lose their overlapped characters.
    touched.forEach((n, i) => {
      const nEnd = n.textStart + n.text.length;
      const from = Math.max(e.start, n.textStart) - n.textStart;
      const to = Math.min(e.end, nEnd) - n.textStart;
      const list = pending.get(n) ?? [];
      list.push({ from, to, insert: i === 0 ? e.replacement : "" });
      pending.set(n, list);
    });
  }

  // One splice per node, with all of its edits applied together. Emitting a
  // splice per edit would have each rewrite the whole node from the original
  // text, so two fixes in the same run would silently clobber each other.
  for (const [n, list] of pending) {
    let next = n.text;
    for (const part of [...list].sort((a, b) => b.from - a.from)) {
      next = next.slice(0, part.from) + part.insert + next.slice(part.to);
    }
    const needsPreserve = !n.preserve && (/^\s/.test(next) || /\s$/.test(next));
    splices.push({
      xmlStart: n.xmlStart,
      xmlEnd: n.xmlEnd,
      text: encodeEntities(next),
      ...(needsPreserve ? { addPreserveAt: n.openTagEnd } : {}),
    });
  }

  return { splices, skipped };
}

/** Apply splices end-to-start so earlier offsets stay valid. */
export function applySplices(xml: string, splices: Splice[]): string {
  const ordered = [...splices].sort((a, b) => b.xmlStart - a.xmlStart);
  let out = xml;
  for (const s of ordered) {
    out = out.slice(0, s.xmlStart) + s.text + out.slice(s.xmlEnd);
    if (s.addPreserveAt !== undefined) {
      // The open tag ends just before xmlStart; insert the attribute before ">".
      const gt = out.lastIndexOf(">", s.xmlStart - 1);
      if (gt > 0 && !/xml:space/.test(out.slice(Math.max(0, gt - 60), gt))) {
        out = out.slice(0, gt) + ' xml:space="preserve"' + out.slice(gt);
      }
    }
  }
  return out;
}

/**
 * Rewrite the text of an existing .docx in place.
 *
 * Only word/document.xml is touched; JSZip passes every other entry through
 * byte-for-byte, which is why formatting survives without this code knowing
 * what any of it means.
 */
export async function rewriteDocxText(
  docxBuffer: Buffer,
  edits: Array<{ paragraphIndex: number } & ParagraphTextEdit>,
): Promise<{ buffer: Buffer; applied: number; skipped: SkippedEdit[] }> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("Not a Word document: word/document.xml is missing");

  const xml = await file.async("string");
  const index = indexDocumentXml(xml);

  const byParagraph = new Map<number, ParagraphTextEdit[]>();
  const skipped: SkippedEdit[] = [];
  for (const e of edits) {
    const p = index.paragraphs[e.paragraphIndex];
    if (!p) {
      skipped.push({
        ...e,
        original: "",
        // The paragraph is not in the document at all, so there is no passage
        // to quote. The row still carries the intended replacement.
        context: "",
        reason: "unmappable-paragraph",
      });
      continue;
    }
    const list = byParagraph.get(e.paragraphIndex);
    if (list) list.push(e);
    else byParagraph.set(e.paragraphIndex, [e]);
  }

  const allSplices: Splice[] = [];
  let applied = 0;
  for (const [paragraphIndex, list] of byParagraph) {
    const res = planParagraphSplices(index.paragraphs[paragraphIndex], list);
    allSplices.push(...res.splices);
    skipped.push(...res.skipped);
    applied += list.length - res.skipped.length;
  }

  zip.file("word/document.xml", applySplices(xml, allSplices));
  const buffer = Buffer.from(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return { buffer, applied, skipped };
}
