// ── Tables and contents pages ──
//
// A Word table reaches the editors as prose: every cell is its own paragraph
// (conversion.ts walks the document paragraph by paragraph), so a contents
// table, a cast list or a timeline reads as a run of fragments — "Chapter 1",
// "5", "Mother" — and every check had something to say about each one. A
// Word contents page built from the TOC field is not a table but reads the
// same way: "[Chapter 17 5](#_Toc250118)", one line per chapter.
//
// None of it is the author's prose, and a table cell's correction could not
// be exported into the Word file anyway (its paragraph is unmappable, so
// surgical export keeps the original text). Suggestions inside either are
// left alone, beside the other gates in queue.ts.

import type { Correction } from "./types.js";
import type { ParagraphMapEntry } from "./conversion.js";
import type { NoiseGateResult } from "./noiseGates.js";

/** The text of every table-cell paragraph in an imported .docx, from the
 *  paragraph map saved with it (cells are the unmappable entries). */
export function tableParagraphTexts(md: string, map: ParagraphMapEntry[]): string[] {
  const out = new Set<string>();
  for (const e of map) {
    if (e.mappable) continue;
    const t = md.slice(e.mdStart, e.mdEnd).trim();
    if (t) out.add(t);
  }
  return [...out];
}

/** One line of a contents page: a whole internal link (Word's TOC field), or
 *  a short title ending in a page number after a tab, leader dots or a
 *  space. The last shape is ordinary prose too ("Room 101") — so a line only
 *  counts inside a run of them (CONTENTS_RUN). */
function looksLikeContentsLine(p: string): boolean {
  const t = p.trim();
  if (!t || t.includes("\n")) return false;
  if (/^(?:[-*]\s+|\d+\\?\.\s+)?\[[^\]]+\]\(#[^)]*\)$/.test(t)) return true;
  if (t.split(/\s+/).length > 12) return false;
  return /\p{L}/u.test(t) && /(?:\t|\.{3,}|…+|\s)\s*(?:\d{1,4}|[ivxlc]{1,7})$/iu.test(t);
}

/** Consecutive contents lines it takes to call them a contents page. */
const CONTENTS_RUN = 3;

/** Where the non-prose paragraphs of `text` are: table cells (by their text)
 *  and runs of contents lines. Offsets into `text`. */
export function nonProseRanges(text: string, tableTexts: Set<string>): [number, number][] {
  const paras: { s: number; e: number; t: string }[] = [];
  const re = /[^\n]+(?:\n(?![ \t]*\n)[^\n]*)*/g;
  for (let m; (m = re.exec(text)); ) {
    const t = m[0].trim();
    if (t) paras.push({ s: m.index, e: m.index + m[0].length, t });
  }
  const out: [number, number][] = [];
  let run: typeof paras = [];
  const flush = () => {
    if (run.length >= CONTENTS_RUN) for (const p of run) out.push([p.s, p.e]);
    run = [];
  };
  for (const p of paras) {
    if (looksLikeContentsLine(p.t)) run.push(p);
    else flush();
    if (tableTexts.has(p.t)) out.push([p.s, p.e]);
  }
  flush();
  return out;
}

/** `text` without its table cells and contents lines, paragraph breaks kept
 *  — what the publication scan's prose checks read. */
export function stripNonProse(text: string, tableTexts: Set<string>): string {
  const ranges = nonProseRanges(text, tableTexts);
  if (ranges.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [s, e] of ranges.sort((a, b) => a[0] - b[0])) {
    if (s < at) continue;
    out += text.slice(at, s);
    at = e;
  }
  out += text.slice(at);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Corrections the author made themselves (a style-sheet or house-style
 *  rule) are theirs to apply wherever they asked. */
const AUTHORS = new Set(["house-style", "style-sheet"]);

/** Drop a suggestion when every place it could apply is a table cell or a
 *  contents line. One that also occurs in prose is kept. */
export function dropNonProseEdits(
  cs: Correction[],
  text: string,
  tableTexts: Set<string>,
): NoiseGateResult {
  const ranges = nonProseRanges(text, tableTexts);
  if (ranges.length === 0) return { kept: cs, dropped: [] };
  const inside = (at: number, len: number) =>
    ranges.some(([s, e]) => at >= s && at + len <= e);
  const kept: Correction[] = [];
  const dropped: NoiseGateResult["dropped"] = [];
  for (const c of cs) {
    if (AUTHORS.has(c.reason ?? "") || !c.original) {
      kept.push(c);
      continue;
    }
    const at: number[] = [];
    for (let i = text.indexOf(c.original); i >= 0; i = text.indexOf(c.original, i + 1)) at.push(i);
    if (at.length > 0 && at.every((i) => inside(i, c.original.length))) {
      dropped.push({ correction: c, why: "left alone: in a table or a contents page, not prose" });
    } else kept.push(c);
  }
  return { kept, dropped };
}
