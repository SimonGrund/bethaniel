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
import { foldSegments, visibleFormat } from "./emphasisSpans.js";
import { commentXml, maxId, writeComments, type CommentAuthor } from "./docxComments.js";

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
  /** Inside a tracked change the document already carries (<w:ins>,
   *  <w:moveTo>). A tracked export cannot nest its own revision there. */
  inRevision?: boolean;
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
  /** Offset where the paragraph's content begins: past <w:p …> and its
   *  <w:pPr>…</w:pPr>. Where a comment's range starts. */
  contentStart?: number;
  /** Offset of </w:p>. Where a comment's range ends. */
  closeStart?: number;
  /** Offset of the <w:p …> opening tag: which top-level block holds it. */
  openStart?: number;
}

export interface DocxTextIndex {
  xml: string;
  paragraphs: DocxParagraph[];
}

/** A replacement expressed in a paragraph's plain-text coordinates. */
/**
 * A paragraph whose internal emphasis was given up so its text could be
 * replaced, and what that emphasis was.
 *
 * The count alone told an author that 112 paragraphs had lost something
 * without saying which, or what — so the only way to find out was to read the
 * book against the original. This carries enough to put it back by hand.
 */
export interface FlattenedParagraph {
  paragraphIndex: number;
  /** The paragraph as it read before, so it can be found in the original. */
  before: string;
  /** The runs that differed from the paragraph's first formatting: the
   *  italic word, the highlighted phrase — whatever was distinct. */
  emphasised: string[];
}

export interface ParagraphTextEdit {
  start: number;
  end: number;
  replacement: string;
  /**
   * This edit replaces the paragraph outright — a translation, not a
   * correction.
   *
   * It changes one decision below: a span crossing runs whose formatting
   * differs is normally REFUSED, because a correction cannot know which
   * formatting its replacement should take. For a whole-paragraph replacement
   * there is nothing to preserve — every word is going — and refusing leaves
   * the paragraph in the source language. So it is collapsed to the
   * paragraph's first formatting and counted, rather than dropped.
   */
  wholeParagraph?: boolean;
  /**
   * One string per folded segment of this paragraph, in order — set only when
   * a translation's emphasis could be matched to the runs already present.
   *
   * With it, each segment's runs receive their own text and the emphasised
   * translation lands in the author's own italic run, keeping their font and
   * size. Without it the paragraph is flattened as before.
   */
  segments?: string[];
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
    | "unmappable-paragraph"
    // Tracked export only: inside a revision the document already has.
    | "tracked-region";
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
  let revisionDepth = 0; // inside an existing <w:ins> / <w:moveTo>
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

    // An existing tracked insertion. Self-closing forms are paragraph-mark
    // revisions inside <w:rPr> and enclose no text.
    if ((name === "w:ins" || name === "w:moveTo") && !isSelf) {
      revisionDepth = Math.max(0, revisionDepth + (isClose ? -1 : 1));
      continue;
    }

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
          openStart: m.index,
        });
      } else if (isClose) {
        const done = stack.pop();
        if (done) {
          done.isEmpty = done.text.length === 0;
          done.closeStart = m.index;
        }
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
          contentStart: tagEnd,
          openStart: m.index,
        };
        paragraphs.push(p);
        stack.push(p);
        runIndex = -1;
      }
      continue;
    }

    const p = stack[stack.length - 1];
    if (!p) continue;
    if (name === "w:pPr" && isClose) p.contentStart = tagEnd;

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
        ...(revisionDepth > 0 ? { inRevision: true } : {}),
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
): {
  splices: Splice[];
  skipped: SkippedEdit[];
  flattened: number;
  flattenedDetail: FlattenedParagraph[];
  restored: number;
  /** A translation was written through a tab or line break it could not
   *  carry: the text is in, the layout is worth a look. */
  layoutDoubt: boolean;
} {
  const splices: Splice[] = [];
  const skipped: SkippedEdit[] = [];
  let layoutDoubt = false;
  /** Whole-paragraph replacements that lost intra-paragraph formatting. */
  let flattened = 0;
  const flattenedDetail: FlattenedParagraph[] = [];
  /** Whole-paragraph replacements whose emphasis was put back. */
  let restored = 0;
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

    // Trimming shrinks an edit to the span that actually changed, which is
    // right for a correction and wrong for an allocated translation: the
    // allocation describes every segment of the paragraph, and trimming a
    // shared prefix or suffix (a trailing full stop is enough) drops a run out
    // of `touched`, leaving fewer segments than the allocation has parts. The
    // paragraph would then be refused for a difference that is not real.
    //
    // Nor is a translation's replacement trimmed at all: a shared final "e"
    // is a coincidence between two languages, and trimming it put a line
    // break before the last letter ("…second lin" / "e").
    const e = raw.wholeParagraph ? raw : trimEdit(p.text, raw);
    if (e.start === e.end && e.replacement === "") continue; // no-op

    // Nodes the trimmed span touches. A zero-width insert attaches to the node
    // containing the insertion point.
    let touched = p.nodes.filter((n) => {
      const nEnd = n.textStart + n.text.length;
      return e.start < nEnd && e.end > n.textStart
        ? true
        : e.start === e.end && e.start >= n.textStart && e.start <= nEnd;
    });
    // An insertion where a text node meets a tab touches both; it belongs to
    // the text. Seen on a contents line: "EPILOG<TAB>168" to "EPILOGUE" trims
    // to "insert UE after EPILOG", which was refused as touching the tab.
    if (e.start === e.end && touched.some((n) => n.kind !== "virtual")) {
      touched = touched.filter((n) => n.kind !== "virtual");
    }

    if (touched.length === 0) {
      skip(raw, "out-of-range");
      continue;
    }
    if (touched.some((n) => n.kind === "virtual")) {
      // A correction must not guess where a tab or a line break goes. A
      // translation is going into this paragraph regardless — leaving it in
      // the source language is the one outcome worse than a lost line break
      // — so it is written into the text around them, and flagged.
      if (!raw.wholeParagraph) {
        skip(raw, "virtual-node");
        continue;
      }
      touched = touched.filter((n) => n.kind !== "virtual");
      if (touched.length === 0) {
        skip(raw, "virtual-node");
        continue;
      }
      layoutDoubt = true;
    }
    /** Text per segment, when this translation's emphasis could be placed. */
    let allocation: string[] | null = null;

    if (touched.length > 1) {
      const fmt = new Set(touched.map((n) => visibleFormat(n.rPrXml)));
      if (fmt.size > 1) {
        // A correction must not guess which formatting to keep — refusing is
        // the guarantee this export exists for. A translation has no such
        // choice to get wrong: the paragraph is going regardless, and
        // refusing it hands the author their own language back.
        if (!raw.wholeParagraph) {
          skip(raw, "mixed-formatting");
          continue;
        }

        // The translation carries its own emphasis, and this paragraph
        // already has the runs to hold it. Checked again here rather than
        // trusted: a mis-sized allocation would put text in the wrong run,
        // which is the one outcome worse than losing the emphasis.
        const segments = foldSegments(touched);
        if (raw.segments && raw.segments.length === segments.length) {
          allocation = raw.segments;
          restored++;
        } else {
          flattened++;
          // Record WHAT was given up, not just that something was.
          //
          // The formatting being kept is the one covering most of the
          // paragraph, NOT the first run's. A paragraph opening with a bold
          // term — "**Monogamish** relationships are primarily monogamous…" —
          // has the bold run first, and reading that as the base reports the
          // whole rest of the paragraph as the lost emphasis: backwards, and
          // it turns a two-word note into a note quoting the entire
          // paragraph. Measured on a real manuscript, three of twelve notes
          // were inverted this way.
          const byLength = new Map<string, number>();
          for (const n of touched)
            if (n.kind !== "virtual")
              byLength.set(
                visibleFormat(n.rPrXml),
                (byLength.get(visibleFormat(n.rPrXml)) ?? 0) + n.text.length,
              );
          let kept = visibleFormat(touched[0]?.rPrXml ?? "");
          let widest = -1;
          for (const [rPr, len] of byLength)
            if (len > widest) {
              widest = len;
              kept = rPr;
            }
          // As phrases, not runs: a title the author italicised word by word
          // ("Kom" "på" "benene" "igen", plain spaces between) is one thing to
          // put back. Runs of the other formatting separated only by
          // whitespace join into one phrase, read off the paragraph's text.
          const emphasised: string[] = [];
          let from = -1;
          let to = -1;
          const close = () => {
            if (from >= 0) {
              const phrase = p.text.slice(from, to).trim();
              if (phrase) emphasised.push(phrase);
            }
            from = -1;
          };
          for (const n of touched) {
            if (n.kind === "virtual") {
              close();
              continue;
            }
            const end = n.textStart + n.text.length;
            if (visibleFormat(n.rPrXml) !== kept) {
              if (from < 0) from = n.textStart;
              to = end;
            } else if (from >= 0 && n.text.trim() !== "") {
              close();
            }
          }
          close();
          flattenedDetail.push({ paragraphIndex: p.index, before: p.text, emphasised });
        }
      }
    }

    // Record each node's share.
    //
    // With an allocation, the first node of each SEGMENT takes that segment's
    // text and the rest of the segment is emptied — so the emphasised
    // translation lands in the run that was already emphasised. Without one,
    // the first node takes everything, exactly as before.
    let segmentIndex = -1;
    let lastRPr: string | null = null;
    touched.forEach((n, i) => {
      const nEnd = n.textStart + n.text.length;
      const from = Math.max(e.start, n.textStart) - n.textStart;
      const to = Math.min(e.end, nEnd) - n.textStart;

      // No virtual-node case: an edit touching one was skipped as
      // "virtual-node" further up, so none can reach here.
      let insert: string;
      if (!allocation) {
        insert = i === 0 ? e.replacement : "";
      } else {
        // Grouped exactly as foldSegments grouped them, or the allocation
        // would land one segment off.
        const startsSegment = lastRPr === null || visibleFormat(n.rPrXml) !== lastRPr;
        if (startsSegment) segmentIndex++;
        lastRPr = visibleFormat(n.rPrXml);
        insert = startsSegment ? (allocation[segmentIndex] ?? "") : "";
      }

      const list = pending.get(n) ?? [];
      list.push({ from, to, insert });
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

  return { splices, skipped, flattened, flattenedDetail, restored, layoutDoubt };
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
export interface RewriteOptions {
  /** A translation: every doubt — lost emphasis, a layout it could not
   *  carry — becomes a Word comment on its paragraph. */
  doubtComments?: boolean;
  /** Further comments to anchor, from the remap (docxRemap `notes`). */
  comments?: Array<{ paragraphIndex: number; text: string }>;
  author?: CommentAuthor;
  /** Keep only the top-level blocks holding a paragraph in these ranges
   *  (docxRemap `scope`): a partial translation exports what was translated,
   *  not the rest of the book in the source language. The final section
   *  properties always stay, so the page setup is the book's own. */
  keepParagraphs?: Array<[number, number]>;
}

/**
 * The document with every top-level block of <w:body> removed that holds no
 * kept paragraph. A block with no paragraphs at all (a bookmark marker) is
 * kept; so is the body's own <w:sectPr>.
 */
export function trimBody(xml: string, keep: (paragraphIndex: number) => boolean): string {
  const bodyOpen = xml.match(/<w:body\b[^>]*>/);
  if (!bodyOpen || bodyOpen.index === undefined) return xml;
  const paragraphs = indexDocumentXml(xml).paragraphs;
  const tag = /<(\/?)([A-Za-z][\w.:-]*)\b[^>]*?(\/?)>/g;
  tag.lastIndex = bodyOpen.index + bodyOpen[0].length;
  const drop: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let name = "";
  let m: RegExpExecArray | null;
  const decide = (s: number, e: number, n: string) => {
    if (n === "w:sectPr") return;
    const inside = paragraphs.filter((p) => p.openStart !== undefined && p.openStart >= s && p.openStart < e);
    if (inside.length > 0 && !inside.some((p) => keep(p.index))) drop.push([s, e]);
  };
  while ((m = tag.exec(xml)) !== null) {
    const [full, closing, tagName, selfClose] = m;
    if (closing === "/") {
      if (depth === 0) break; // </w:body>
      depth--;
      if (depth === 0) decide(start, m.index + full.length, name);
    } else if (selfClose === "/") {
      if (depth === 0) decide(m.index, m.index + full.length, tagName);
    } else {
      if (depth === 0) {
        start = m.index;
        name = tagName;
      }
      depth++;
    }
  }
  let out = xml;
  for (const [s, e] of drop.reverse()) out = out.slice(0, s) + out.slice(e);
  return out;
}

const BETTY: Omit<CommentAuthor, "date"> = { author: "Betty", initials: "B" };

export async function rewriteDocxText(
  docxBuffer: Buffer,
  edits: Array<{ paragraphIndex: number } & ParagraphTextEdit>,
  options: RewriteOptions = {},
): Promise<{
  buffer: Buffer;
  applied: number;
  skipped: SkippedEdit[];
  /** Paragraphs whose intra-paragraph formatting was collapsed to apply a
   *  whole-paragraph replacement. A real loss, so it is reported. */
  flattened: number;
  /** What each of those gave up, for the notes document. */
  flattenedDetail: FlattenedParagraph[];
  /** Paragraphs whose emphasis was put back into the author's own run. */
  restored: number;
  /** Comments Betty left in the document. */
  comments: number;
}> {
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
  let flattened = 0;
  let restored = 0;
  const flattenedDetail: FlattenedParagraph[] = [];
  /** Comment text per paragraph, joined when one paragraph has several. */
  const notes = new Map<number, string[]>();
  const note = (i: number, text: string) => {
    const list = notes.get(i);
    if (list) list.push(text);
    else notes.set(i, [text]);
  };
  for (const [paragraphIndex, list] of byParagraph) {
    const res = planParagraphSplices(index.paragraphs[paragraphIndex], list);
    allSplices.push(...res.splices);
    skipped.push(...res.skipped);
    applied += list.length - res.skipped.length;
    flattened += res.flattened;
    restored += res.restored;
    flattenedDetail.push(...res.flattenedDetail);
    if (options.doubtComments && res.layoutDoubt) {
      note(
        paragraphIndex,
        "This paragraph had a tab or a line break that could not be carried into the translation. The text is all here; check the layout.",
      );
    }
  }
  if (options.doubtComments) {
    for (const f of flattenedDetail) {
      if (f.emphasised.length === 0) continue;
      note(
        f.paragraphIndex,
        `In the original, ${f.emphasised.map((e) => `“${e}”`).join(", ")} ${f.emphasised.length === 1 ? "was" : "were"} emphasised (italic, bold or similar). Betty could not tell which words of the translation ${f.emphasised.length === 1 ? "it belongs" : "they belong"} to, so this paragraph is in plain text: put the emphasis back where it fits.`,
      );
    }
  }
  for (const c of options.comments ?? []) note(c.paragraphIndex, c.text);

  // Each commented paragraph gets one comment spanning its whole content.
  const commentParts: string[] = [];
  if (notes.size > 0) {
    const author: CommentAuthor = options.author ?? { ...BETTY, date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
    let id = Math.max(maxId(xml, "w:id"), maxId((await zip.file("word/comments.xml")?.async("string")) ?? "", "w:id")) + 1;
    for (const [i, texts] of notes) {
      const para = index.paragraphs[i];
      if (!para || para.contentStart === undefined || para.closeStart === undefined) continue;
      allSplices.push(
        { xmlStart: para.contentStart, xmlEnd: para.contentStart, text: `<w:commentRangeStart w:id="${id}"/>` },
        {
          xmlStart: para.closeStart,
          xmlEnd: para.closeStart,
          text: `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`,
        },
      );
      commentParts.push(commentXml(id, texts.join("\n"), author));
      id++;
    }
  }

  let newXml = applySplices(xml, allSplices);
  if (options.keepParagraphs && options.keepParagraphs.length > 0) {
    const ranges = options.keepParagraphs;
    newXml = trimBody(newXml, (i) => ranges.some(([a, b]) => i >= a && i <= b));
  }
  zip.file("word/document.xml", newXml);
  await writeComments(zip, newXml, commentParts);
  const buffer = Buffer.from(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return { buffer, applied, skipped, flattened, flattenedDetail, restored, comments: commentParts.length };
}
