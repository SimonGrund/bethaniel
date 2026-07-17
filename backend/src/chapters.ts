// ── Chapter detection — ported from ui.py ──

import type { Chapter } from "./types.js";

const PAGEBREAK_MARKER = "<!-- PAGEBREAK -->";

const CHAPTER_WORDS = [
  "chapter",
  "part",
  "kapitel",
  "kapittel",
  "del",
  "capítulo",
  "capitulo",
  "parte",
  "chapitre",
  "partie",
  "capitolo",
  "hoofdstuk",
];

const SPECIAL_SECTIONS = [
  "prologue",
  "epilogue",
  "interlude",
  "afterword",
  "foreword",
  "preface",
  "introduction",
  "appendix",
  "prolog",
  "epilog",
  "forord",
  "efterord",
  "indledning",
  "appendiks",
  "vorwort",
  "nachwort",
  "einleitung",
  "prólogo",
  "epílogo",
  "prefacio",
  "introducción",
  "apéndice",
  "préface",
  "annexe",
  "prologo",
  "epilogo",
  "prefazione",
  "introduzione",
  "appendice",
  "proloog",
  "epiloog",
  "voorwoord",
  "nawoord",
  "inleiding",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const cwg = [...new Set(CHAPTER_WORDS)]
  .sort((a, b) => b.length - a.length)
  .join("|");
const ssg = [...new Set(SPECIAL_SECTIONS)]
  .sort((a, b) => b.length - a.length)
  .join("|");

const CHAPTER_PATTERNS: RegExp[] = [
  new RegExp(
    `(?:^|\\n)\\s*${escapeRegex(PAGEBREAK_MARKER)}\\s*(?:\\n|$)`,
    "gm",
  ),
  /(?:^|\n)(#{1,2})\s+(.+)$/gm,
  new RegExp(
    `(?:^|\\n)[ \\t]*[*_]{0,3}[ \\t]*((?:${cwg})[ \\t]+[\\dIVXLCivxlc]+[.:—–-]?[^\\n]*?)[ \\t]*[*_]{0,3}[ \\t]*(?:\\n|$)`,
    "gmi",
  ),
  new RegExp(
    `(?:^|\\n)[ \\t]*[*_]{0,3}[ \\t]*((?:${cwg})(?:[ \\t]+\\S[^\\n]*?)?)[ \\t]*[*_]{0,3}[ \\t]*(?:\\n|$)`,
    "gmi",
  ),
  new RegExp(`(?:^|\\n)\\s*((?:${ssg})\\s*[.:—–-]?\\s*.*?)(?:\\n|$)`, "gmi"),
  /(?:^|\n)\s*([A-ZÆØÅÄÖÜÉÈÊÁÀÂÍÓÚÑÇ][A-ZÆØÅÄÖÜÉÈÊÁÀÂÍÓÚÑÇ ]{6,})(?:\n|$)/gm,
  /(?:^|\n)\s*(?:\*\*|__)(.+?)(?:\*\*|__)[ \t]*(?:\n|$)/gm,
  /(?:^|\n)\s*(\d{1,3}[.)]\s+.+)$/gm,
];

function cleanTitle(s: string): string {
  s = s.trim();
  s = s.replace(/^[*_]{1,3}\s*/, "");
  s = s.replace(/\s*[*_]{1,3}$/, "");
  return s.replace(/^#+\s*/, "").trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function findChapters(text: string): Chapter[] {
  // ── Phase 1: targeted patterns (page-break, ATX heading, chapter-word, special section).
  // Run all of them and pick the one with the MOST matches. Otherwise a docx
  // with explicit "Chapter X" headings but only some chapters separated by
  // page breaks would only report the page-break count (e.g. 26 of 32).
  const TARGETED_END = 5; // patterns 0..4 (inclusive) are the targeted set
  type PatternHit = {
    index: number;
    groups: string[];
    full: string;
  };
  let bestMatches: PatternHit[] = [];

  for (let pi = 0; pi < TARGETED_END; pi++) {
    const pat = CHAPTER_PATTERNS[pi];
    pat.lastIndex = 0;
    const matches: PatternHit[] = [];
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      if (m[0].trim().length <= 120) {
        matches.push({
          index: m.index,
          groups: [...m].slice(1),
          full: m[0],
        });
      }
    }
    const valid =
      matches.length >= 2 || (matches.length === 1 && matches[0].index > 0);
    if (valid && matches.length > bestMatches.length) {
      bestMatches = matches;
    }
  }

  if (bestMatches.length > 0) {
    return buildChaptersFromMatches(text, bestMatches);
  }

  // ── Phase 2: looser fallback patterns (all-caps lines, bold, numbered lists).
  // First-match-wins because these are more likely to over-match.
  for (let pi = TARGETED_END; pi < CHAPTER_PATTERNS.length; pi++) {
    const pat = CHAPTER_PATTERNS[pi];
    pat.lastIndex = 0;
    const matches: PatternHit[] = [];
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      if (m[0].trim().length <= 120) {
        matches.push({
          index: m.index,
          groups: [...m].slice(1),
          full: m[0],
        });
      }
    }
    if (matches.length >= 2 || (matches.length === 1 && matches[0].index > 0)) {
      return buildChaptersFromMatches(text, matches);
    }
  }

  // Fallback: scene breaks
  const brk = /(?:^|\n)\s*(?:\*\s*\*\s*\*|---+|___+)\s*(?:\n|$)/gm;
  const breakMatches: { index: number; end: number }[] = [];
  let bm: RegExpExecArray | null;
  while ((bm = brk.exec(text)) !== null) {
    breakMatches.push({ index: bm.index, end: bm.index + bm[0].length });
  }

  if (breakMatches.length >= 2) {
    const bounds = [0, ...breakMatches.map((b) => b.end), text.length];
    const out: Chapter[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = bounds[i];
      const e = bounds[i + 1];
      const sec = text.slice(s, e).trim();
      if (!sec) continue;
      const title =
        sec.split("\n")[0].slice(0, 60).trim() || `Section ${i + 1}`;
      out.push({
        title,
        level: 1,
        start: s,
        end: e,
        wordCount: wordCount(sec),
      });
    }
    if (out.length > 0) return out;
  }

  return [];
}

function buildChaptersFromMatches(
  text: string,
  matches: { index: number; groups: string[]; full: string }[],
): Chapter[] {
  const out: Chapter[] = [];
  const firstStart = matches[0]?.index ?? 0;
  if (firstStart > 0) {
    const pre = text.slice(0, firstStart);
    if (pre.trim()) {
      out.push({
        title: "Frontmatter",
        level: 1,
        start: 0,
        end: firstStart,
        wordCount: wordCount(pre),
      });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const raw =
      [...matches[i].groups].reverse().find((g) => g && g.trim()) ??
      matches[i].full;

    let title: string;
    if (
      raw.includes(PAGEBREAK_MARKER) ||
      matches[i].full.includes(PAGEBREAK_MARKER)
    ) {
      const sec = text.slice(start + matches[i].full.length, end);
      const firstLine =
        sec.split("\n").find((ln) => ln.trim()) ?? `Section ${i + 1}`;
      title = cleanTitle(firstLine.slice(0, 80));
    } else {
      title = cleanTitle(raw);
    }

    out.push({
      title,
      level: 1,
      start,
      end,
      wordCount: wordCount(text.slice(start, end)),
    });
  }
  return out;
}

export { PAGEBREAK_MARKER };

// ── Single-line chapter-heading detector (used by DOCX export to promote
// plain-text titles like "Chapter One" / "CHAPTER ONE" / "Prologue" to real
// <h1> headings with a preceding page break). Mirrors the patterns used by
// findChapters() but evaluates a single trimmed line at a time.
const CHAPTER_LINE_PATTERNS: RegExp[] = [
  // "Chapter 12", "Kapitel IV — The Storm", optionally wrapped in */_ marks
  new RegExp(`^[*_]{0,3}\\s*(?:${cwg})\\s+[\\dIVXLCivxlc]+[.:—–-]?.*$`, "i"),
  // "Chapter One", "Part Two: Reunion" — chapter word followed by anything
  new RegExp(`^[*_]{0,3}\\s*(?:${cwg})(?:\\s+\\S.*)?[*_]{0,3}\\s*$`, "i"),
  // "Prologue", "Epilogue: Aftermath"
  new RegExp(`^(?:${ssg})\\s*[.:—–-]?.*$`, "i"),
  // All-caps line (≥7 chars, letters/spaces only) — "CHAPTER ONE", "THE END"
  /^[A-ZÆØÅÄÖÜÉÈÊÁÀÂÍÓÚÑÇ][A-ZÆØÅÄÖÜÉÈÊÁÀÂÍÓÚÑÇ ]{6,}$/,
];

export function isChapterHeadingLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 120) return false;
  return CHAPTER_LINE_PATTERNS.some((re) => re.test(t));
}

// ── Part grouping (story-analysis hierarchy middle tier) ──
//
// Explicit "Part One" / "Book Two" / "Del 2" headings define the groups; a
// heading unit and everything up to the next heading form one part, with any
// leading units (prologue, frontmatter) attached to the first part. Without
// explicit structure, chapters are auto-grouped into runs of 4-6; books under
// 8 chapters get a single implicit part (the part tier is skipped upstream).

export interface PartGroup {
  title: string;
  unitIndices: number[];
}

const PART_WORDS = [
  "part",
  "book",
  "del",
  "parte",
  "partie",
  "libro",
  "livre",
  "teil",
  "bog",
  "bok",
  "boek",
];

const PART_HEADING_RE = new RegExp(
  `^[*_#\\s]*(?:${PART_WORDS.join("|")})\\s+(?:[\\dIVXLCivxlc]+|\\p{L}+)\\b`,
  "iu",
);

export function isPartHeading(name: string): boolean {
  const t = name.trim();
  return !!t && t.length <= 120 && PART_HEADING_RE.test(t);
}

export function groupIntoParts(unitNames: string[]): PartGroup[] {
  const n = unitNames.length;
  const headingIdx = unitNames
    .map((name, i) => (isPartHeading(name) ? i : -1))
    .filter((i) => i >= 0);

  // Explicit structure needs at least two part headings.
  if (headingIdx.length >= 2) {
    const parts: PartGroup[] = [];
    for (let h = 0; h < headingIdx.length; h++) {
      const start = h === 0 ? 0 : headingIdx[h]; // leading units join part 1
      const end = h + 1 < headingIdx.length ? headingIdx[h + 1] : n;
      parts.push({
        title: unitNames[headingIdx[h]].trim(),
        unitIndices: Array.from({ length: end - start }, (_, k) => start + k),
      });
    }
    return parts;
  }

  // Short book: single implicit part.
  if (n < 8) {
    return [
      {
        title: "",
        unitIndices: Array.from({ length: n }, (_, i) => i),
      },
    ];
  }

  // Auto-group into runs of 4-6, distributed evenly.
  const groups = Math.ceil(n / 6);
  const base = Math.floor(n / groups);
  const extra = n % groups;
  const parts: PartGroup[] = [];
  let cursor = 0;
  for (let g = 0; g < groups; g++) {
    const size = base + (g < extra ? 1 : 0);
    parts.push({
      title: `Chapters ${cursor + 1}–${cursor + size}`,
      unitIndices: Array.from({ length: size }, (_, k) => cursor + k),
    });
    cursor += size;
  }
  return parts;
}
