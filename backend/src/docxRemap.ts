// ── Mapping edited chapters back onto docx paragraphs ──
//
// Corrections carry no positions: `Correction` is { original, corrected } and
// the pipeline recovers positions by string search. Worse, some exported text
// has no correction objects behind it at all — verifyAcceptedCorrections
// returns server-repaired chapter text, and translate mode replaces text
// wholesale. So this does not try to plumb correction offsets. The stable
// contract every export path already has is the pair (originalText, editedText)
// per chapter; the edit spans are derived by diffing.
//
// The substitution decision is always plain-text vs plain-text WITHIN one
// paragraph. Markdown offsets are used only to locate the paragraph, and the
// located text is verified against the docx before anything is changed. Every
// failure mode therefore degrades to "this paragraph keeps its original text",
// never to "this paragraph is corrupted".

import { diffWordsWithSpace, diffChars } from "diff";

import type { ParagraphMapEntry } from "./conversion.js";
import type { DocxTextIndex, ParagraphTextEdit } from "./docxSurgery.js";
import {
  allocateEmphasis,
  foldSegments,
  splitEmphasis,
} from "./emphasisSpans.js";

export interface ChapterExport {
  original: string;
  edited: string;
}

export interface UnmappedNote {
  reason: "chapter-not-found" | "paragraph-mismatch" | "not-mappable";
  detail: string;
  paragraphIndex?: number;
}

export interface RemapResult {
  /** `chapterIndex` is the edit's position in the `chapters` passed in. */
  edits: Array<{ paragraphIndex: number; chapterIndex: number } & ParagraphTextEdit>;
  unmapped: UnmappedNote[];
  /** A translation's doubts, as comments to anchor (docxSurgery
   *  rewriteDocxText `comments`): a paragraph placed by similarity rather
   *  than by its exact text, or one with no place at all, whose translation
   *  rides in the comment. In a translation these replace `unmapped`. */
  notes: Array<{ paragraphIndex: number; text: string }>;
  /** The Word paragraphs each chapter covers, first to last, in the order the
   *  chapters were given. A partial translation exports only these. */
  scope: Array<[number, number]>;
  /** Some of the document's own text lies outside every chapter given: the
   *  job covered part of the book, and the export is that part. False for a
   *  whole-book job, whose export must keep even what no chapter reached (a
   *  colophon, a closing image) after the last mapped paragraph. */
  partial: boolean;
}

/** Shared words over all words, both sides lowercased: how alike two
 *  paragraphs read, for placing one whose exact text was not found. */
function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** At least this alike to be placed by similarity, with a comment. */
const PLACE_BY_SIMILARITY = 0.6;

/**
 * Reduce a markdown block to the text a Word paragraph would hold.
 *
 * Mirrors what the exporter's inline handling adds, in reverse: the heading
 * prefix, emphasis markers (longest first, so *** is not read as * twice), and
 * image references, which have no textual counterpart in the run.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // A link is its text in Word. Turndown writes a table of contents as
    // "[Chapter 17](#TOC250118)" and a URL as "[www…](http://…)"; leaving the
    // syntax in made every such paragraph fail to verify.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*\*|___)(.+?)\1/gs, "$2")
    .replace(/(\*\*|__)(.+?)\1/gs, "$2")
    .replace(/(\*|_)(.+?)\1/gs, "$2")
    // Every punctuation character CommonMark lets a backslash escape, not just
    // the three emphasis ones. Turndown escapes a list marker as "1\." so it is
    // not re-parsed as a list, and leaving that backslash in made the text
    // differ from what Word holds ("1.  Listen…") — so every numbered list item
    // failed to verify and stayed in the source language. The escape is
    // markdown's, not the author's; the text Word holds never contains it.
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1");
}

/** Markdown with images removed and links reduced to their text, emphasis
 *  left in place — what the emphasis allocation reads (splitEmphasis). */
function withoutImagesAndLinks(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/**
 * A leading list marker: "1. ", "12) ", "- ", "* ", bullets.
 *
 * Word renders an auto-number into the paragraph's text, and turndown writes
 * its own number when it re-emits the list — so the two disagree the moment a
 * list does not start at one, or is split, or is nested. The prose after the
 * marker is identical; only the number differs.
 */
const LIST_MARKER_RE = /^\s*(?:\d+\s*[.)]|[-*\u2022\u25CF\u25AA])\s+/;

function withoutListMarker(s: string): string {
  return s.replace(LIST_MARKER_RE, "");
}

/** Whitespace-insensitive comparison, for the tolerant second attempt. */
function loose(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Start/end offset of every blank-line-separated block in `text`. */
function blockSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /[^\n][\s\S]*?(?=\n\s*\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!m[0].trim()) continue;
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/**
 * Monotone offset map from the original chapter text to the edited one.
 *
 * Used only to slice the edited counterpart of a paragraph — never to decide
 * what to replace. Both offsets it is ever asked for are block boundaries, so
 * pairing the blocks up by index answers every real query exactly.
 *
 * The word diff below is the fallback, and it is a fallback for a reason: on a
 * translation no two words match, which is Myers' O(n·d) worst case. A chapter
 * cost over a second there, so a novel's export blocked the backend for
 * minutes — the "download takes forever" report. Blocks align in O(n), and for
 * the edit modes (which never merge or split paragraphs) and for a translation
 * (whose prompts forbid it, and whose upgrade pass is guarded on it) the counts
 * match, so the fast path is the path taken.
 */
function buildOffsetMap(original: string, edited: string): (pos: number) => number {
  const points: Array<[number, number]> = [[0, 0]];

  const oBlocks = blockSpans(original);
  const eBlocks = blockSpans(edited);
  if (oBlocks.length > 0 && oBlocks.length === eBlocks.length) {
    for (let i = 0; i < oBlocks.length; i++) {
      points.push([oBlocks[i][0], eBlocks[i][0]]);
      points.push([oBlocks[i][1], eBlocks[i][1]]);
    }
  } else {
    let o = 0;
    let e = 0;
    for (const part of diffWordsWithSpace(original, edited)) {
      if (part.added) {
        e += part.value.length;
      } else if (part.removed) {
        o += part.value.length;
      } else {
        o += part.value.length;
        e += part.value.length;
      }
      points.push([o, e]);
    }
  }
  points.push([original.length, edited.length]);

  return (pos: number) => {
    // Binary search for the last point at or before `pos`. The linear scan
    // this replaced ran once per paragraph over a points array that grew with
    // the chapter, which is a second quadratic term on the same hot path.
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (points[mid][0] <= pos) lo = mid;
      else hi = mid - 1;
    }
    const [op, ep] = points[lo];
    return Math.max(0, Math.min(edited.length, ep + (pos - op)));
  };
}

/**
 * How far a character diff may wander before the paragraph is treated as
 * rewritten outright. A correction edits a word or a clause, so its distance
 * is a handful of characters; a translated paragraph shares nothing but its
 * punctuation, and diffing it produced a hundred-odd one-character spans that
 * cost real time to compute and shredded the Word paragraph into as many runs.
 * Past this point one whole-paragraph replacement is smaller, faster and truer
 * to what actually happened.
 */
const REWRITE_DISTANCE_RATIO = 0.5;

/** Character-level spans between two plain-text versions of one paragraph. */
function paragraphEdits(before: string, after: string): ParagraphTextEdit[] {
  const parts = diffChars(before, after, {
    maxEditLength: Math.max(
      32,
      Math.round(Math.max(before.length, after.length) * REWRITE_DISTANCE_RATIO),
    ),
  });
  // Over the cap: too different to be an edit of this paragraph. Replace it
  // outright, and say so — docxSurgery treats a whole-paragraph replacement
  // differently when the paragraph's runs are not uniformly formatted, because
  // refusing one leaves the source language in the author's book.
  if (!parts)
    return [
      { start: 0, end: before.length, replacement: after, wholeParagraph: true },
    ];

  const edits: ParagraphTextEdit[] = [];
  let pos = 0;
  let pendingStart = -1;
  let removed = "";
  let added = "";

  const flush = () => {
    if (pendingStart < 0) return;
    edits.push({
      start: pendingStart,
      end: pendingStart + removed.length,
      replacement: added,
    });
    pendingStart = -1;
    removed = "";
    added = "";
  };

  for (const part of parts) {
    if (part.added) {
      if (pendingStart < 0) pendingStart = pos;
      added += part.value;
    } else if (part.removed) {
      if (pendingStart < 0) pendingStart = pos;
      removed += part.value;
      pos += part.value.length;
    } else {
      flush();
      pos += part.value.length;
    }
  }
  flush();
  return edits;
}

/**
 * Turn edited chapters into paragraph-local edits against the original docx.
 */
/** A label or page number in a tabbed line: digits, Roman numerals, dots. */
const LABELISH = /^[\s\d.,:;()ivxlcdmIVXLCDM–-]*$/;

/**
 * The translation of one tabbed line — a table-of-contents entry, "Title<TAB>13"
 * — as an edit of its title alone. Word holds each tab as its own element, so a
 * whole-paragraph replacement cannot cross one (docxSurgery refuses it as a
 * virtual node), and a book's whole contents page stayed in the source
 * language. The markdown has spaces where Word has tabs, so the translation's
 * own copy of the label and the page number is trimmed off. Null when the line
 * holds more than one piece of text: there is no telling which words go where.
 */
export function tabbedTitleEdit(
  text: string,
  afterPlain: string,
): { start: number; end: number; replacement: string } | null {
  const pieces: { at: number; s: string }[] = [];
  let at = 0;
  for (const s of text.split("\t")) {
    pieces.push({ at, s });
    at += s.length + 1;
  }
  const titles = pieces.filter((p) => p.s.trim() && !LABELISH.test(p.s));
  if (titles.length !== 1) return null;
  let replacement = afterPlain.trim();
  for (const p of pieces) {
    const label = p.s.trim();
    if (!label || !LABELISH.test(label)) continue;
    if (replacement.endsWith(label)) replacement = replacement.slice(0, -label.length).trim();
    if (replacement.startsWith(label)) replacement = replacement.slice(label.length).trim();
  }
  if (!replacement) return null;
  const title = titles[0];
  const lead = title.s.length - title.s.trimStart().length;
  const start = title.at + lead;
  return { start, end: start + title.s.trim().length, replacement };
}

/**
 * Split `text` in two at the word boundary nearest `fraction` of its length,
 * never inside an emphasised phrase (an odd count of markers before the
 * split). For a translated sentence the source had broken across a page:
 * each of the two Word paragraphs keeps its share, so the layout holds and
 * no text is lost or doubled.
 */
function splitAtFraction(text: string, fraction: number): [string, string] {
  const target = Math.round(text.length * fraction);
  // Never inside an image or a link: a split on a space in an image's
  // description put "AI](media/…/image83.png)" into a translated paragraph.
  const guarded: Array<[number, number]> = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\([^)]*\)/g)) {
    guarded.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const inGuard = (i: number) => guarded.some(([a, b]) => i > a && i < b);
  let best = -1;
  let underscore = 0;
  let stars = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "_") underscore++;
    else if (ch === "*") stars++;
    else if (/\s/.test(ch) && !inGuard(i) && underscore % 2 === 0 && stars % 4 === 0 && stars % 2 === 0) {
      if (best < 0 || Math.abs(i - target) < Math.abs(best - target)) best = i;
    }
  }
  if (best <= 0) return [text, ""];
  return [text.slice(0, best).trimEnd(), text.slice(best).trimStart()];
}

/**
 * Pair a chapter's source paragraphs with its translated ones by length —
 * the standard way to align a text with its translation. One source
 * paragraph usually becomes one translated paragraph, but a translator
 * rightly joins a sentence that the source (a typeset book converted to
 * Word) broke across a page, and occasionally splits a long one. Character
 * offsets cannot follow that: on the book this was found on, every paragraph
 * after the first join was cut in the wrong place.
 *
 * Returns the translated text for each SOURCE paragraph. Two source
 * paragraphs sharing one translation share its text, split in proportion;
 * one source paragraph given two translations gets both. Unchanged when the
 * counts match and every pair is plausible.
 */
export function alignTranslatedBlocks(original: string[], edited: string[]): string[] {
  const n = original.length;
  const m = edited.length;
  const len = (s: string) => stripMarkdown(s).length + 1;
  const lo = original.map(len);
  const le = edited.map(len);
  // The translation's overall expansion, so a language that runs long does
  // not make every pair look wrong.
  const scale = le.reduce((a, b) => a + b, 0) / Math.max(1, lo.reduce((a, b) => a + b, 0));
  const fit = (e: number, o: number) => Math.abs(Math.log(e / (scale * o)));
  const JOIN = 0.3; // a join or split is normal, but not free
  const SKIP = 2.5; // a paragraph with no counterpart at all is rare
  const INF = Number.POSITIVE_INFINITY;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  const move: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i][j];
      if (here === INF) continue;
      const relax = (di: number, dj: number, c: number, code: number) => {
        if (i + di > n || j + dj > m) return;
        if (here + c < cost[i + di][j + dj]) {
          cost[i + di][j + dj] = here + c;
          move[i + di][j + dj] = code;
        }
      };
      if (i < n && j < m) relax(1, 1, fit(le[j], lo[i]), 11);
      if (i + 1 < n && j < m) relax(2, 1, fit(le[j], lo[i] + lo[i + 1]) + JOIN, 21);
      if (i < n && j + 1 < m) relax(1, 2, fit(le[j] + le[j + 1], lo[i]) + JOIN, 12);
      if (i < n) relax(1, 0, SKIP, 10);
      if (j < m) relax(0, 1, SKIP, 1);
    }
  }
  const out: string[] = new Array(n).fill("");
  const extra: string[][] = Array.from({ length: n + 1 }, () => []);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const code = move[i][j];
    if (code === 11) {
      out[i - 1] = edited[j - 1];
      i--; j--;
    } else if (code === 21) {
      const [a, b] = splitAtFraction(edited[j - 1], lo[i - 2] / (lo[i - 2] + lo[i - 1]));
      out[i - 2] = a;
      out[i - 1] = b;
      i -= 2; j--;
    } else if (code === 12) {
      out[i - 1] = `${edited[j - 2]} ${edited[j - 1]}`;
      i--; j -= 2;
    } else if (code === 10) {
      // No counterpart: the paragraph keeps its own text, honestly untranslated.
      out[i - 1] = original[i - 1];
      i--;
    } else {
      // A translated paragraph with no source of its own joins its neighbour.
      extra[i].unshift(edited[j - 1]);
      j--;
    }
  }
  for (let k = 0; k <= n; k++) {
    if (extra[k].length === 0) continue;
    const at = Math.max(0, k - 1);
    out[at] = [out[at], ...extra[k]].filter(Boolean).join(" ");
  }
  return out;
}

/** How far a mismatched paragraph looks for its real counterpart, either
 *  side of where the last realignment says it should be. */
const REALIGN_WINDOW = 8;
/** How far forward it looks when that fails. Forward only: an importer that
 *  loses Word paragraphs makes the markdown lag behind, never run ahead — and
 *  a whole contents page (thirteen lines on the book this was found on) can
 *  be lost at once. */
const REALIGN_REACH = 64;

export interface RemapOptions {
  /** A translation: every changed paragraph is replaced whole. Diffing two
   *  languages character by character found "edits" in a short title — an
   *  inserted "Safe", an "e?" — that crossed formatting runs and were
   *  refused, leaving the title in the source language. */
  wholeParagraphs?: boolean;
}

export function remapChaptersToParagraphEdits(
  docMd: string,
  paragraphMap: ParagraphMapEntry[],
  index: DocxTextIndex,
  chapters: ChapterExport[],
  options: RemapOptions = {},
): RemapResult {
  const edits: RemapResult["edits"] = [];
  const unmapped: UnmappedNote[] = [];
  const notes: RemapResult["notes"] = [];
  const scope: RemapResult["scope"] = [];
  let first = -1;
  let last = -1;
  /** Every Word paragraph some markdown block accounted for. */
  const seen = new Set<number>();
  const covers = (i: number) => {
    if (i < 0 || i >= index.paragraphs.length) return;
    seen.add(i);
    if (first < 0 || i < first) first = i;
    if (i > last) last = i;
  };
  const editsFor = (before: string, after: string): ParagraphTextEdit[] => {
    if (!options.wholeParagraphs) return paragraphEdits(before, after);
    if (before.includes("\t")) {
      const title = tabbedTitleEdit(before, after);
      // A translation's replacement of the title span: flattened rather than
      // refused when the title spans mixed runs (a contents line's hyperlink
      // and field runs), exactly as a whole paragraph would be. The tabs and
      // the page number are outside the span and untouched.
      if (title) return [{ ...title, wholeParagraph: true }];
    }
    return [{ start: 0, end: before.length, replacement: after, wholeParagraph: true }];
  };
  // Word paragraphs already claimed by a block, so a realigned block never
  // takes one that another block verified against.
  const claimed = new Set<number>();
  // How far the map has turned out to be off. Once one paragraph is found
  // thirteen further on, the next is looked for thirteen further on too.
  let drift = 0;

  /**
   * Where this block's text really is in the document: the paragraph the map
   * names when it holds that text, else the nearest unclaimed one that does.
   * The map pairs blocks and paragraphs in order, so ONE Word paragraph
   * without a block of its own (a nested contents line, on the book this was
   * found on) shifted every pair after it, and every paragraph from there to
   * the end of the book failed to verify. Claims what it finds and keeps the
   * drift. Also run for a paragraph with nothing to change, so the drift
   * stays true and the chapter's scope starts where the chapter does.
   */
  const locate = (
    entry: ParagraphMapEntry,
    beforePlain: string,
  ): { at: number; verdict: "exact" | "list" } | null => {
    const named = entry.docxParaIndex;
    const own = index.paragraphs[named];
    let found: { at: number; verdict: "exact" | "list" } | null = null;
    if (own && !claimed.has(named)) {
      const v = verify(beforePlain, own.text);
      if (v) found = { at: named, verdict: v };
    }
    if (!found) {
      const expected = named + drift;
      const order: number[] = [expected];
      for (let d = 1; d <= REALIGN_WINDOW; d++) order.push(expected + d, expected - d);
      for (let d = REALIGN_WINDOW + 1; d <= REALIGN_REACH; d++) order.push(expected + d);
      // Behind as well, for a translation: a pull quote or a text box that
      // Word holds out of the text's order can put the paragraph back
      // there, and a translation must be placed, not left out.
      if (options.wholeParagraphs) for (let d = REALIGN_WINDOW + 1; d <= REALIGN_REACH; d++) order.push(expected - d);
      for (const i of order) {
        const candidate = index.paragraphs[i];
        if (!candidate || claimed.has(i)) continue;
        const v = verify(beforePlain, candidate.text);
        if (v) {
          found = { at: i, verdict: v };
          break;
        }
      }
    }
    if (found) {
      claimed.add(found.at);
      drift = found.at - named;
      covers(found.at);
    }
    return found;
  };
  const verify = (beforePlain: string, text: string): "exact" | "list" | null => {
    if (beforePlain === text || loose(beforePlain) === loose(text)) return "exact";
    if (
      LIST_MARKER_RE.test(text) &&
      loose(withoutListMarker(beforePlain)) === loose(withoutListMarker(text))
    )
      return "list";
    return null;
  };

  // Chapters are ordered and non-overlapping slices of docMd, so a forward
  // cursor makes the anchor unambiguous.
  let cursor = 0;

  for (const [chapterIndex, chapter] of chapters.entries()) {
    if (first >= 0) scope.push([first, last]);
    first = -1;
    last = -1;

    let at = docMd.indexOf(chapter.original, cursor);
    if (at < 0) at = docMd.indexOf(chapter.original);
    if (at < 0) {
      unmapped.push({
        reason: "chapter-not-found",
        detail: chapter.original.slice(0, 60),
      });
      continue;
    }
    const chapterEnd = at + chapter.original.length;
    cursor = chapterEnd;
    // An unchanged chapter is still part of what was worked on: it is in
    // the scope, it just has nothing to write.
    if (chapter.original === chapter.edited) {
      for (const entry of paragraphMap)
        if (entry.mdStart >= at && entry.mdEnd <= chapterEnd) covers(entry.docxParaIndex + drift);
      continue;
    }

    const toEdited = buildOffsetMap(chapter.original, chapter.edited);
    // A translation is aligned paragraph to paragraph by length, not by
    // character offsets (alignTranslatedBlocks). Keyed by where each source
    // paragraph starts within the chapter.
    let alignedByStart: Map<number, string> | null = null;
    if (options.wholeParagraphs) {
      const spans = blockSpans(chapter.original);
      const sourceBlocks = spans.map(([s0, e0]) => chapter.original.slice(s0, e0));
      const editedBlocks = blockSpans(chapter.edited).map(([s0, e0]) => chapter.edited.slice(s0, e0));
      const aligned = alignTranslatedBlocks(sourceBlocks, editedBlocks);
      alignedByStart = new Map(spans.map(([s0], k) => [s0, aligned[k]]));
    }

    for (const entry of paragraphMap) {
      if (entry.mdStart < at || entry.mdEnd > chapterEnd) continue;

      let paraIndex = entry.docxParaIndex;
      let paragraph = index.paragraphs[paraIndex];
      if (!paragraph) continue;

      const oldMd = docMd.slice(entry.mdStart, entry.mdEnd);
      const newMd =
        alignedByStart?.get(entry.mdStart - at) ??
        chapter.edited.slice(toEdited(entry.mdStart - at), toEdited(entry.mdEnd - at));
      // Nothing to apply, so nothing lost: a paragraph this export cannot map
      // is only worth reporting when a change was meant for it.
      if (stripMarkdown(oldMd) === stripMarkdown(newMd)) {
        if (!entry.mappable || !locate(entry, stripMarkdown(oldMd))) covers(entry.docxParaIndex + drift);
        continue;
      }

      // A table cell is marked not mappable on import. A correction keeps
      // that caution; a translation verifies the cell's text like any other
      // paragraph (below) and writes into it, or a translated book kept its
      // tables in the source language.
      if (!entry.mappable && !options.wholeParagraphs) {
        covers(entry.docxParaIndex + drift);
        unmapped.push({
          reason: "not-mappable",
          detail: paragraph.text.slice(0, 60),
          paragraphIndex: entry.docxParaIndex,
        });
        continue;
      }

      const beforePlain = stripMarkdown(oldMd);
      const afterPlain = stripMarkdown(newMd);

      // Verify before acting. If the markdown we located does not match what
      // the docx actually holds, we do not understand this paragraph well
      // enough to edit it — leave it exactly as the author wrote it. (locate
      // looks nearby first; see there.)
      const located = locate(entry, beforePlain);
      const verdict = located?.verdict ?? null;
      if (located) {
        paraIndex = located.at;
        paragraph = index.paragraphs[paraIndex];
      }
      const matches = verdict === "exact";

      // A list item is the one routine exception. Word renders its auto-number
      // into the text ("1.  Let relationships change") and turndown writes its
      // own when it re-emits the list ("3. Let relationships change"), so the
      // two disagree on the number while the prose is identical. Refusing
      // those left every numbered list in the source language — nine of them
      // in the manuscript this was found on, and a list is exactly the kind of
      // passage a reader notices is untranslated.
      //
      // The marker is matched on BOTH sides and then left alone: the docx's
      // own number stays, and only the prose after it is replaced. Writing
      // markdown's number into the document would renumber the author's list.
      const listMatches = verdict === "list";

      if (!matches && !listMatches && options.wholeParagraphs) {
        // Still no exact match. A translation goes in regardless: into the
        // most alike unclaimed paragraph nearby, with a comment to check it,
        // or — when nothing is alike — into a comment of its own on the
        // nearest paragraph, so not a word of it is lost.
        const expected = entry.docxParaIndex + drift;
        let best = -1;
        let bestScore = 0;
        for (let d = -REALIGN_REACH; d <= REALIGN_REACH; d++) {
          const i = expected + d;
          const candidate = index.paragraphs[i];
          if (!candidate || claimed.has(i) || !candidate.text.trim()) continue;
          const score = similarity(beforePlain, candidate.text);
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
        if (best >= 0 && bestScore >= PLACE_BY_SIMILARITY) {
          claimed.add(best);
          covers(best);
          const target = index.paragraphs[best];
          for (const e of editsFor(target.text, afterPlain)) {
            edits.push({ paragraphIndex: best, chapterIndex, ...e });
          }
          notes.push({
            paragraphIndex: best,
            text: `Betty placed this translation where the paragraph reads most like the original, but it did not match exactly. Check it belongs here. Original: “${beforePlain.slice(0, 300)}”`,
          });
        } else {
          const near = Math.min(Math.max(0, expected), index.paragraphs.length - 1);
          covers(near);
          notes.push({
            paragraphIndex: near,
            text: `Betty could not find this paragraph in your document, so its translation is here instead. Original: “${beforePlain.slice(0, 300)}” Translation: “${afterPlain}”`,
          });
        }
        continue;
      }

      if (!matches && !listMatches) {
        unmapped.push({
          reason: "paragraph-mismatch",
          detail: paragraph.text.slice(0, 60),
          paragraphIndex: paraIndex,
        });
        continue;
      }
      if (beforePlain === afterPlain) continue;

      if (listMatches) {
        // Replace only what follows the docx's own marker.
        const marker = paragraph.text.match(LIST_MARKER_RE)?.[0] ?? "";
        const afterProse = withoutListMarker(afterPlain);
        for (const e of editsFor(
          paragraph.text.slice(marker.length),
          afterProse,
        )) {
          edits.push({
            paragraphIndex: paraIndex,
            chapterIndex,
            start: e.start + marker.length,
            end: e.end + marker.length,
            replacement: e.replacement,
            wholeParagraph: e.wholeParagraph,
          });
        }
        continue;
      }

      // Diff against the docx's own text, so offsets are in its coordinates
      // even when whitespace differed from the markdown.
      for (const e of editsFor(paragraph.text, afterPlain)) {
        // Only a whole-paragraph replacement — a translation — can carry
        // emphasis across, and only it has a paragraph's worth of text to
        // distribute. A correction edits a span and leaves the rest alone.
        //
        // Read from newMd, not afterPlain: the markers are still in newMd and
        // are exactly what is being read. afterPlain has had them stripped.
        const segments = e.wholeParagraph
          ? (allocateEmphasis(
              foldSegments(paragraph.nodes),
              // Emphasis markers kept, images and links not: an image's
              // markdown reached the text of five paragraphs on a real book.
              splitEmphasis(withoutImagesAndLinks(newMd)),
            ) ?? undefined)
          : undefined;
        edits.push({ paragraphIndex: paraIndex, chapterIndex, ...e, segments });
      }
    }
  }

  if (first >= 0) scope.push([first, last]);

  // Chapters separated only by empty paragraphs are one stretch: those
  // paragraphs are the page breaks and spacing between them, and dropping
  // them ran one chapter straight on from the last.
  const merged: Array<[number, number]> = [];
  for (const [a, b] of [...scope].sort((x, y) => x[0] - y[0])) {
    const prev = merged[merged.length - 1];
    if (prev && (a <= prev[1] + 1 || index.paragraphs.slice(prev[1] + 1, a).every((q) => !q.text.trim()))) {
      prev[1] = Math.max(prev[1], b);
    } else merged.push([a, b]);
  }

  // A paragraph inside the translated stretch that no block accounted for —
  // a contents line or a text box the conversion did not pick up — has no
  // translation at all. It stays as it is, and says so.
  if (options.wholeParagraphs) {
    for (const [a, b] of merged) {
      for (let i = a; i <= b; i++) {
        if (seen.has(i) || !/\p{L}/u.test(index.paragraphs[i]?.text ?? "")) continue;
        notes.push({
          paragraphIndex: i,
          text: "Betty has no translation for this paragraph: it was not in the text she translated (the conversion of your Word file did not pick it up), so it is still in the original language. Translate it by hand.",
        });
      }
    }
  }
  // Partial when a block of the document with text sits in no chapter.
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (const chapter of chapters) {
    let at = docMd.indexOf(chapter.original, from);
    if (at < 0) at = docMd.indexOf(chapter.original);
    if (at < 0) continue;
    spans.push([at, at + chapter.original.length]);
    from = at + chapter.original.length;
  }
  const partial = paragraphMap.some(
    (e) =>
      stripMarkdown(docMd.slice(e.mdStart, e.mdEnd)).trim() !== "" &&
      !spans.some(([a, b]) => e.mdStart >= a && e.mdEnd <= b),
  );
  return { edits, unmapped, notes, scope: merged, partial };
}

/**
 * A paragraph map for a .docx this app generated from `docMd`, rather than
 * one the author uploaded.
 *
 * A manuscript imported from Markdown, PDF or EPUB has no original document
 * to mark up, so the tracked export builds one with markdownToDocx and marks
 * up that. Importing it again does not give `docMd` back — whitespace and
 * escaping differ — so the map is made directly: each block of `docMd` is
 * paired, in order, with the next paragraph holding the same text. A block
 * with no such paragraph is marked unmappable, so a change meant for it is
 * reported rather than lost.
 */
export function mapMarkdownOntoDocx(
  docMd: string,
  index: DocxTextIndex,
): ParagraphMapEntry[] {
  const LOOKAHEAD = 8;
  const map: ParagraphMapEntry[] = [];
  const same = (block: string, text: string) => {
    const a = loose(stripMarkdown(block));
    const b = loose(text);
    return a === b || (a !== "" && loose(withoutListMarker(a)) === b);
  };
  let cursor = 0;
  for (const [mdStart, spanEnd] of blockSpans(docMd)) {
    // End at the block's last character, not at trailing whitespace: the last
    // block of a manuscript ending in a newline would otherwise run one
    // character past its chapter, and the remap skips a paragraph that does
    // not fit inside its chapter without a word.
    const block = docMd.slice(mdStart, spanEnd).trimEnd();
    const mdEnd = mdStart + block.length;
    let found = -1;
    for (let i = cursor; i < Math.min(index.paragraphs.length, cursor + LOOKAHEAD); i++) {
      if (same(block, index.paragraphs[i].text)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      map.push({ docxParaIndex: found, mdStart, mdEnd, mappable: true });
      cursor = found + 1;
    } else if (index.paragraphs.length > 0) {
      map.push({
        docxParaIndex: Math.min(cursor, index.paragraphs.length - 1),
        mdStart,
        mdEnd,
        mappable: false,
      });
    }
  }
  return map;
}
