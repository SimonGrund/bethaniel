// ── Publication-readiness structural scan ──
// Deterministic (no-LLM) whole-manuscript check for obvious assembly flaws:
// duplicate chapters/blocks, empty or dropped chapters, chapter-numbering gaps,
// and content cut off mid-sentence (a proxy for a missing page). Mirrors the
// philosophy of consistency.ts — fast, offline, no model required.

import { createHash } from "crypto";
import { splitIntoParagraphs } from "./chunking.js";
import type {
  FindingSeverity,
  StructuralFinding,
  StructuralScanReport,
} from "./types.js";

export interface ScanUnit {
  name: string;
  original: string;
}

// Below this many words a chapter is treated as effectively empty (dropped).
const EMPTY_THRESHOLD = 5;
// Below this a chapter is suspiciously short (possible truncation/omission).
const SHORT_THRESHOLD = 30;
// Only paragraphs this long are considered for cross-chapter block duplication,
// so shared short lines (chapter epigraphs, refrains) aren't false positives.
const BLOCK_MIN_WORDS = 40;

const normalize = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, " ").trim();

const wordCount = (s: string): number =>
  s.trim().split(/\s+/).filter(Boolean).length;

const hash = (s: string): string =>
  createHash("sha1").update(s).digest("hex");

// Special sections that legitimately fall outside the numbered chapter run and
// may be short by nature.
const SPECIAL_SECTION_RE =
  /\b(prologue|epilogue|foreword|preface|afterword|introduction|appendix|acknowledge?ments?|dedication|glossary|about the author)\b/i;

const ROMAN_RE = /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

function romanToInt(s: string): number {
  const map: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  };
  const cs = s.toLowerCase();
  let total = 0;
  for (let i = 0; i < cs.length; i++) {
    const cur = map[cs[i]];
    const next = map[cs[i + 1]];
    total += next && cur < next ? -cur : cur;
  }
  return total;
}

/** Extract a chapter number from a heading, or null if it isn't numbered. */
function parseChapterNumber(name: string): number | null {
  // Strip markdown heading markers / list bullets.
  const t = name.replace(/^[\s#>*_-]+/, "").trim();
  // "Chapter 5", "Part VI", "Section 3"
  const kw = t.match(/^(?:chapter|part|section|book)\s+([0-9]+|[ivxlcdm]+)\b/i);
  if (kw) {
    const tok = kw[1];
    return /^[0-9]+$/.test(tok) ? parseInt(tok, 10) : romanToInt(tok);
  }
  // Bare leading number: "5.", "5:", "5 —"
  const bare = t.match(/^([0-9]+)\b/);
  if (bare) return parseInt(bare[1], 10);
  return null;
}

const TERMINAL_END_RE = /[.!?…"'”’)\]]$/;

function findDuplicates(units: ScanUnit[]): {
  findings: StructuralFinding[];
  chapterDupGroup: Map<number, number>;
} {
  const findings: StructuralFinding[] = [];

  // 1) Whole-chapter duplicates: group non-trivial chapters by body hash.
  const byBody = new Map<string, number[]>();
  units.forEach((u, i) => {
    if (wordCount(u.original) < EMPTY_THRESHOLD) return;
    const h = hash(normalize(u.original));
    (byBody.get(h) ?? byBody.set(h, []).get(h)!).push(i);
  });
  const chapterDupGroup = new Map<number, number>();
  let groupId = 0;
  for (const idxs of byBody.values()) {
    if (idxs.length < 2) continue;
    for (const i of idxs) chapterDupGroup.set(i, groupId);
    findings.push({
      check: "duplicate",
      severity: "error",
      location: idxs.map((i) => units[i].name).join(" ↔ "),
      message: `Identical chapter content appears ${idxs.length} times.`,
    });
    groupId++;
  }

  // 2) Large duplicated blocks across otherwise-distinct chapters.
  const byBlock = new Map<string, { chapters: Set<number>; snippet: string }>();
  units.forEach((u, i) => {
    for (const para of splitIntoParagraphs(u.original)) {
      if (wordCount(para) < BLOCK_MIN_WORDS) continue;
      const h = hash(normalize(para));
      const entry =
        byBlock.get(h) ?? byBlock.set(h, { chapters: new Set(), snippet: para.trim() }).get(h)!;
      entry.chapters.add(i);
    }
  });
  for (const { chapters, snippet } of byBlock.values()) {
    if (chapters.size < 2) continue;
    // Skip if this block is duplicated only because the whole chapters are
    // already flagged as identical (same duplicate group).
    const groups = [...chapters].map((i) => chapterDupGroup.get(i));
    const allSameGroup =
      groups[0] !== undefined && groups.every((g) => g === groups[0]);
    if (allSameGroup) continue;
    findings.push({
      check: "duplicate",
      severity: "error",
      location: [...chapters].map((i) => units[i].name).join(" ↔ "),
      message: `A large block of text (paragraph/section) is repeated verbatim across chapters.`,
      detail: snippet.slice(0, 140) + (snippet.length > 140 ? "…" : ""),
    });
  }

  return { findings, chapterDupGroup };
}

function findEmptyChapters(units: ScanUnit[]): StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  for (const u of units) {
    const wc = wordCount(u.original);
    if (wc < EMPTY_THRESHOLD) {
      findings.push({
        check: "empty_chapter",
        severity: "error",
        location: u.name,
        message: `Chapter is empty or nearly empty (${wc} words) — content may have been dropped.`,
      });
    } else if (wc < SHORT_THRESHOLD && !SPECIAL_SECTION_RE.test(u.name)) {
      findings.push({
        check: "empty_chapter",
        severity: "warning",
        location: u.name,
        message: `Chapter is suspiciously short (${wc} words).`,
      });
    }
  }
  return findings;
}

function findNumberingIssues(units: ScanUnit[]): StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  const numbered = units
    .map((u) => ({ name: u.name, num: parseChapterNumber(u.name) }))
    .filter((x): x is { name: string; num: number } => x.num !== null);

  const seen = new Map<number, string[]>();
  for (const { name, num } of numbered) {
    (seen.get(num) ?? seen.set(num, []).get(num)!).push(name);
  }
  for (const [num, names] of seen) {
    if (names.length > 1) {
      findings.push({
        check: "numbering",
        severity: "warning",
        location: names.join(" ↔ "),
        message: `Chapter number ${num} is used ${names.length} times.`,
      });
    }
  }

  for (let i = 1; i < numbered.length; i++) {
    const prev = numbered[i - 1];
    const cur = numbered[i];
    if (cur.num > prev.num + 1) {
      const missing: number[] = [];
      for (let n = prev.num + 1; n < cur.num; n++) missing.push(n);
      findings.push({
        check: "numbering",
        severity: "warning",
        location: `${prev.name} → ${cur.name}`,
        message: `Gap in chapter numbering: ${missing.join(", ")} missing between ${prev.num} and ${cur.num}.`,
      });
    } else if (cur.num <= prev.num && cur.num !== prev.num) {
      findings.push({
        check: "numbering",
        severity: "warning",
        location: `${prev.name} → ${cur.name}`,
        message: `Chapter numbers are out of order (${prev.num} then ${cur.num}).`,
      });
    }
  }
  return findings;
}

/**
 * Trailing markup that is not the end of the sentence.
 *
 * A chapter closing on "…_This doesn't make any sense…_" ends, as a string, in
 * an underscore. Judging the last character alone reported a perfectly finished
 * chapter as cut off.
 */
const TRAILING_MARKUP_RE = /[_*`\s]+$/;

/** One paragraph's quote balance, and whether it opens a continued speech. */
interface QuoteBalance {
  opens: number;
  closes: number;
  startsWithOpen: boolean;
}

function quoteBalance(paragraph: string): QuoteBalance {
  const text = paragraph.trim();
  return {
    opens: (text.match(/“/g) ?? []).length,
    closes: (text.match(/”/g) ?? []).length,
    startsWithOpen: /^[_*]*“/.test(text),
  };
}

/** A short, readable excerpt of the paragraph a finding refers to. */
function excerptOf(paragraph: string): string {
  const flat = paragraph.replace(/\s+/g, " ").trim();
  return flat.length <= 110 ? flat : `${flat.slice(0, 107)}…`;
}

/**
 * Paragraphs whose quotes do not balance, excluding the standard convention for
 * speech continued across paragraphs — each such paragraph opens with a quote
 * and only the last one closes. Without that exception this fires on every
 * novel containing a long speech.
 */
function unbalancedParagraphs(body: string): string[] {
  const paragraphs = body.split(/\n\n+/);
  const out: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const { opens, closes, startsWithOpen } = quoteBalance(p);
    if (opens === closes) continue;
    // One unclosed opening quote, and the next paragraph opens one too: this is
    // continued speech, not an error.
    const next = paragraphs[i + 1];
    if (
      opens === closes + 1 &&
      startsWithOpen &&
      next &&
      quoteBalance(next).startsWithOpen
    ) {
      continue;
    }
    out.push(excerptOf(p));
  }
  return out;
}

function findTruncation(units: ScanUnit[]): StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  for (const u of units) {
    const body = u.original.trim();
    if (wordCount(body) < EMPTY_THRESHOLD) continue; // empty handled elsewhere
    // Emphasis markers and trailing whitespace are not the end of the sentence.
    const forEnding = body.replace(TRAILING_MARKUP_RE, "");
    const last = forEnding[forEnding.length - 1] ?? "";
    if (!TERMINAL_END_RE.test(last)) {
      findings.push({
        check: "truncation",
        severity: "warning",
        location: u.name,
        message: `Chapter ends without terminal punctuation ("…${forEnding.slice(-40).trim()}") — content may be cut off.`,
      });
      continue;
    }
    // Unbalanced quotes hint at a mid-scene cut or a mistyped closing mark.
    // Reported WITH the passage: the chapter name alone gives the author no way
    // to check whether the finding is real.
    for (const excerpt of unbalancedParagraphs(body)) {
      findings.push({
        check: "truncation",
        severity: "info",
        location: u.name,
        message: `Unbalanced quotation marks — a line of dialogue may be unclosed: "${excerpt}"`,
      });
    }
  }
  return findings;
}

export function buildPublicationScan(units: ScanUnit[]): StructuralScanReport {
  const { findings: dupFindings } = findDuplicates(units);
  const findings: StructuralFinding[] = [
    ...dupFindings,
    ...findEmptyChapters(units),
    ...findNumberingIssues(units),
    ...findTruncation(units),
  ];

  const summary: Record<FindingSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const f of findings) summary[f.severity]++;

  return {
    title: "Publication readiness scan",
    chaptersScanned: units.length,
    summary,
    findings,
  };
}
