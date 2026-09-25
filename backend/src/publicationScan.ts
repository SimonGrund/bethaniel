// ── Publication-readiness structural scan ──
//
// The quotation checks were scored against two real manuscripts (Rage of the
// Rule, Path of the Taker, 2026-09-23), and the numbers are the reason the
// rules below look the way they do.
//
//   BEFORE   Rage   5 findings, of 15 genuinely unbalanced paragraphs
//            Taker  0 findings, of 8
//            Every miss was a curly opener closed by a STRAIGHT mark, which
//            the family-only counting could not see at all.
//
//   AFTER    Rage   6 balance (2 "does not re-open", 1 never closed,
//                   3 genuinely unbalanced) + 5 style
//            Taker  0 balance + 15 style, including an entire Prologue
//                   typed in straight quotes that no run had ever mentioned
//
// Two cases keep the tolerances honest, and both must stay as they are:
//   - Taker, Chapter Four #83–#89: a story told aloud over seven paragraphs,
//     each re-opening, the last closing. Silent. A scan that reports this is
//     worse than the one this replaced.
//   - Rage, Frontmatter #35/#36 and #38/#39: a quotation closing on the next
//     paragraph without re-opening. Reported ONCE, in its own words — not as
//     an unclosed opener plus a stray closer, which is one fault read twice.
//
// Read the header of quoteMarks.ts before changing a rule here.
// Deterministic (no-LLM) whole-manuscript check for obvious assembly flaws:
// duplicate chapters/blocks, empty or dropped chapters, chapter-numbering gaps,
// and content cut off mid-sentence (a proxy for a missing page). Mirrors the
// philosophy of consistency.ts — fast, offline, no model required.

import { createHash } from "crypto";
import { splitIntoParagraphs } from "./chunking.js";
import { detectDialect } from "./dialect.js";
import {
  QUOTE_FAMILIES,
  readMarks,
  resolveConvention,
  type QuoteConvention,
  type QuoteStyle,
} from "./quoteMarks.js";
import {
  detectApostropheStyle,
  detectEllipsisStyle,
  findTypographyIssues,
} from "./typography.js";
import { STRUCTURAL_CHECKS } from "./types.js";
import type {
  CheckTally,
  FindingSeverity,
  StructuralCheck,
  StructuralFinding,
  StructuralScanReport,
} from "./types.js";
import { findPunctuationPairs, pairExcerpt } from "./punctuationPairs.js";

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

/**
 * A finding before the assembler stamps its publication verdict on it.
 *
 * `blocking` is optional and almost always absent: the assembler's default is
 * that a structural finding blocks publication. A check sets it explicitly
 * only to opt OUT — see the quotation convention in findTruncation.
 */
type DraftFinding = Omit<StructuralFinding, "blocking"> & {
  blocking?: boolean;
};

// ── What a finding says ──
//
// Each message is a template with named slots, sent both ways: rendered here
// into English for `message` — what the PDF and results saved before this
// existed rely on — and as its key and values, which the interface renders
// from i18n.ts in the reader's language. One template per key, so the English
// cannot drift from the translations: publicationScanMessages.test.ts renders
// every finding back through the frontend's English and demands the same
// sentence. A count that changes the words has its own `_one` key, chosen
// here, because only here is the number known.
export const SCAN_MESSAGES = {
  scan_msg_duplicate_chapter: "Identical chapter content appears {n} times.",
  scan_msg_duplicate_block:
    "A large block of text (paragraph/section) is repeated verbatim across chapters.",
  scan_msg_empty:
    "Chapter is empty or nearly empty ({n} words) — content may have been dropped.",
  scan_msg_short: "Chapter is suspiciously short ({n} words).",
  scan_msg_number_reused: "Chapter number {num} is used {n} times.",
  scan_msg_number_gap:
    "Gap in chapter numbering: {missing} missing between {from} and {to}.",
  scan_msg_number_order: "Chapter numbers are out of order ({from} then {to}).",
  scan_msg_repetition:
    'Text is repeated verbatim inside one paragraph ("{span}") — usually a line of dialogue duplicated by a bad edit or import.',
  scan_msg_truncation:
    'Chapter ends without terminal punctuation ("…{ending}") — content may be cut off.',
  scan_msg_quote_no_reopen:
    'Quotation continues into the next paragraph without re-opening — standard style repeats the opening mark: "{excerpt}"',
  scan_msg_quote_unbalanced:
    'Unbalanced quotation marks — a line of dialogue may be unclosed: "{excerpt}"',
  scan_msg_quote_straight:
    'Straight quotation mark in a book that uses curly ones: "{excerpt}"',
  scan_msg_quote_curly:
    'Curly quotation mark in a book that uses straight ones: "{excerpt}"',
  scan_msg_apos_straight_one:
    '{n} straight apostrophe in a book that uses curly ones: "{example}"',
  scan_msg_apos_straight:
    '{n} straight apostrophes in a book that uses curly ones: "{example}"',
  scan_msg_apos_curly_one:
    '{n} curly apostrophe in a book that uses straight ones: "{example}"',
  scan_msg_apos_curly:
    '{n} curly apostrophes in a book that uses straight ones: "{example}"',
  scan_msg_ellipsis_dots_one:
    '{n} ellipsis typed as three dots in a book that uses the … character: "{example}"',
  scan_msg_ellipsis_dots:
    '{n} ellipses typed as three dots in a book that uses the … character: "{example}"',
  scan_msg_ellipsis_char_one:
    '{n} … character in a book that types three dots: "{example}"',
  scan_msg_ellipsis_char:
    '{n} … characters in a book that types three dots: "{example}"',
  scan_msg_invisible_one:
    '{n} invisible character (non-breaking or zero-width space) in the text: "{example}"',
  scan_msg_invisible:
    '{n} invisible characters (non-breaking or zero-width space) in the text: "{example}"',
  scan_msg_placeholder:
    'Drafting placeholder left in the manuscript ({markers}): "{example}"',
  scan_msg_dialect_tie:
    "Mixed English spelling: {british} word(s) use British spelling and {american} use American, in equal measure.",
  scan_msg_dialect_declared:
    "Mixed English spelling: {n} word(s) use {change} spelling, but this manuscript is set to {keep}.",
  scan_msg_dialect_majority:
    "Mixed English spelling: mostly {keep} ({keepN} word(s)) but {n} word(s) use {change} spelling.",
  scan_msg_punctuation_pair: 'Two punctuation marks side by side ("{marks}"): "{excerpt}"',
  scan_msg_punctuation_pair_many:
    '{n} places where two punctuation marks stand side by side — so many that the import itself may be damaged. The first: "{excerpt}"',
  scan_detail_copy_edit_normalises:
    "A copy edit normalises these; a scan only reports them.",
  scan_detail_invisible:
    "Nothing on screen shows these; they survive into the printed book.",
  scan_detail_pick_dialect:
    "Pick one dialect and apply it consistently before publishing.",
  scan_detail_convert_dialect:
    "Convert them to {keep} spelling, or change the dialect setting, before publishing.",
} as const;

type ScanMessageKey = keyof typeof SCAN_MESSAGES;
type Params = Record<string, string | number>;

/** English for the label params — the interface has its own, per language. */
export const SCAN_LABELS_EN: Record<string, string> = {
  scan_dialect_american: "American",
  scan_dialect_british: "British",
};

/** Fill a template's {slots}; label params are looked up, not inserted. */
export function fillScanTemplate(
  template: string,
  params: Params = {},
  labelParams: Record<string, string> = {},
  label: (key: string) => string = (k) => SCAN_LABELS_EN[k] ?? k,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in labelParams
      ? label(labelParams[name])
      : name in params
        ? String(params[name])
        : whole,
  );
}

/** A finding's message, both ways: English, and key + values. */
function say(
  key: ScanMessageKey,
  params?: Params,
  labelParams?: Record<string, string>,
): Pick<DraftFinding, "message" | "messageKey" | "params" | "labelParams"> {
  return {
    message: fillScanTemplate(SCAN_MESSAGES[key], params, labelParams),
    messageKey: key,
    ...(params ? { params } : {}),
    ...(labelParams ? { labelParams } : {}),
  };
}

/** A finding's explanatory line, both ways. It shares the message's values. */
function explain(
  key: ScanMessageKey,
  params?: Params,
  labelParams?: Record<string, string>,
): Pick<DraftFinding, "detail" | "detailKey"> {
  return {
    detail: fillScanTemplate(SCAN_MESSAGES[key], params, labelParams),
    detailKey: key,
  };
}

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

// A chapter may close on the quotation mark of its last line of dialogue, and
// which mark that is depends on the manuscript's convention — » in French,
// “ in German, ” in English. All of them are here, because a closing mark is
// the one thing this check must never read as a cut-off chapter.
const TERMINAL_END_RE = /[.!?…"'”’»«“)\]]$/;

function findDuplicates(units: ScanUnit[]): {
  findings: DraftFinding[];
  chapterDupGroup: Map<number, number>;
} {
  const findings: DraftFinding[] = [];

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
      ...say("scan_msg_duplicate_chapter", { n: idxs.length }),
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
      ...say("scan_msg_duplicate_block"),
      detail: snippet.slice(0, 140) + (snippet.length > 140 ? "…" : ""),
    });
  }

  return { findings, chapterDupGroup };
}

function findEmptyChapters(units: ScanUnit[]): DraftFinding[] {
  const findings: DraftFinding[] = [];
  for (const u of units) {
    const wc = wordCount(u.original);
    if (wc < EMPTY_THRESHOLD) {
      findings.push({
        check: "empty_chapter",
        severity: "error",
        location: u.name,
        ...say("scan_msg_empty", { n: wc }),
      });
    } else if (wc < SHORT_THRESHOLD && !SPECIAL_SECTION_RE.test(u.name)) {
      findings.push({
        check: "empty_chapter",
        severity: "warning",
        location: u.name,
        ...say("scan_msg_short", { n: wc }),
      });
    }
  }
  return findings;
}

function findNumberingIssues(units: ScanUnit[]): DraftFinding[] {
  const findings: DraftFinding[] = [];
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
        ...say("scan_msg_number_reused", { num, n: names.length }),
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
        ...say("scan_msg_number_gap", {
          missing: missing.join(", "),
          from: prev.num,
          to: cur.num,
        }),
      });
    } else if (cur.num <= prev.num && cur.num !== prev.num) {
      findings.push({
        check: "numbering",
        severity: "warning",
        location: `${prev.name} → ${cur.name}`,
        ...say("scan_msg_number_order", { from: prev.num, to: cur.num }),
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

/** A short, readable excerpt of the paragraph a finding refers to. */
function excerptOf(paragraph: string): string {
  const flat = paragraph.replace(/\s+/g, " ").trim();
  return flat.length <= 110 ? flat : `${flat.slice(0, 107)}…`;
}

/**
 * Text repeated back-to-back inside one paragraph.
 *
 * What this catches is a dialogue tag duplicated by a botched edit or a bad
 * import — “And us? We just escape?” Bria asked.” Bria asked. — which the
 * quote check below sees only as a stray ”, and so reports as a punctuation
 * note at `info` rather than as the assembly flaw it is. On the book this
 * came from, the author read six such notes and skipped the one that mattered.
 *
 * What separates it from rhetoric is the speech mark. Prose repeats words for
 * effect — “This isn’t real, it isn’t real, it isn’t real” — but it does not
 * repeat the mark that closes a line of speech: that mark belongs to one line
 * and one only, so two of them in a doubled span means the text was assembled
 * wrong rather than written that way. Measured over 387,000 words of real
 * manuscripts, requiring the mark takes the check from nineteen hits to two,
 * and both survivors are genuine defects — the rest are refrains, a diary
 * entry and a thought repeating in a character’s head.
 *
 * Lower bounds matter as much: two words, so retext’s “the the” stays a copy
 * edit rather than a publication blocker.
 */
const REPEATED_SPAN_RE = /(.{5,60}?)\1/g;
const SPEECH_MARK_RE = /[“”"]/;

/** Tokens that are actually words — a lone ” is punctuation, not a word. */
const spanWordCount = (s: string): number =>
  s.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;

function repeatedSpan(paragraph: string): string | null {
  for (const m of paragraph.matchAll(REPEATED_SPAN_RE)) {
    const span = m[1];
    if (!SPEECH_MARK_RE.test(span)) continue;
    if (spanWordCount(span) < 2) continue;
    return span.trim();
  }
  return null;
}

function findRepetitions(units: ScanUnit[]): {
  findings: DraftFinding[];
  /** Excerpts explained here, so the quote check does not report them twice. */
  reported: Set<string>;
} {
  const findings: DraftFinding[] = [];
  const reported = new Set<string>();
  for (const u of units) {
    for (const para of u.original.split(/\n\n+/)) {
      const span = repeatedSpan(para);
      if (!span) continue;
      const excerpt = excerptOf(para);
      findings.push({
        check: "repetition",
        severity: "error",
        location: u.name,
        ...say("scan_msg_repetition", { span }),
        detail: excerpt,
      });
      reported.add(excerpt);
    }
  }
  return { findings, reported };
}

/**
 * How a paragraph reads on its own, for the run-tracking below.
 */
interface ParagraphShape {
  opens: number;
  closes: number;
  balance: number;
  marks: number;
  startsWithOpen: boolean;
}

function shapeOf(
  paragraph: string,
  convention: QuoteConvention,
): ParagraphShape {
  const text = paragraph.trim();
  const marks = readMarks(text, convention);
  const opens = marks.filter((m) => m.role === "open").length;
  const closes = marks.filter((m) => m.role === "close").length;
  // Emphasis markers can sit between the paragraph's start and its mark:
  // _"Share your knowledge…"_ opens with an underscore.
  const first = marks[0];
  const startsWithOpen =
    first !== undefined &&
    first.role === "open" &&
    /^[_*]*$/.test(text.slice(0, first.index));
  return {
    opens,
    closes,
    balance: opens - closes,
    marks: marks.length,
    startsWithOpen,
  };
}

/**
 * What became of a multi-paragraph quotation that started at `opener`.
 *
 * `closed` carries the index to resume at — the paragraph after the closer.
 * `broken` carries the index of the paragraph that broke the run, which is
 * where the caller resumes: everything between the opener and the break
 * belongs to the one quotation that was never closed, and reporting each of
 * its paragraphs separately would turn a single missing mark into six
 * findings on a six-paragraph legend.
 */
type RunOutcome =
  | { kind: "closed"; resumeAt: number }
  | { kind: "no-reopen"; resumeAt: number }
  | { kind: "broken"; brokeAt: number };

function runEnd(
  paragraphs: string[],
  opener: number,
  convention: QuoteConvention,
  openerShape: ParagraphShape,
  nextShape: ParagraphShape,
): RunOutcome {
  // Continued speech: every paragraph re-opens with the mark, and the one
  // that balances is the last. The OPENER has to have opened that way too —
  // "Aaron shrugged. “We can try." is a quotation opened mid-paragraph, and
  // the line of dialogue after it is a new speaker rather than the rest of
  // Aaron's speech. Without this the two are indistinguishable and a real
  // missing mark is forgiven.
  if (openerShape.startsWithOpen && nextShape.startsWithOpen) {
    for (let j = opener + 1; j < paragraphs.length; j++) {
      const s = shapeOf(paragraphs[j], convention);
      if (!s.startsWithOpen) return { kind: "broken", brokeAt: j };
      if (s.balance === 0) return { kind: "closed", resumeAt: j + 1 };
      if (s.balance !== 1) return { kind: "broken", brokeAt: j };
    }
    // Ran off the end of the chapter, never closed.
    return { kind: "broken", brokeAt: paragraphs.length };
  }
  // A quotation that runs into the very next paragraph and closes there
  // without re-opening. Standard style repeats the opening mark; this does
  // not, and Rage of the Rule's frontmatter legend does it twice —
  //
  //   “This era we call the Old Wars, …
  //   As a last act, … letting the sea separate the land into islands.”
  //
  // Recognised as a run rather than left to the broken path, because that
  // reported ONE quotation twice: the opener as unclosed and the closer as a
  // stray. The closer is not independently wrong. It is still reported, once
  // and in its own words — the shape is non-standard, and an author who does
  // it by accident should hear so.
  if (nextShape.opens === 0 && nextShape.closes === 1) {
    return { kind: "no-reopen", resumeAt: opener + 2 };
  }
  // Block quotation: one opening mark where it starts — which may sit
  // mid-paragraph, "The page read: “This era…" — nothing on the paragraphs
  // between, and one closing mark where it ends.
  if (nextShape.marks === 0) {
    for (let j = opener + 1; j < paragraphs.length; j++) {
      const s = shapeOf(paragraphs[j], convention);
      if (s.marks === 0) continue;
      if (s.opens === 0 && s.closes === 1) {
        return { kind: "closed", resumeAt: j + 1 };
      }
      return { kind: "broken", brokeAt: j };
    }
    return { kind: "broken", brokeAt: paragraphs.length };
  }
  // The next paragraph carries marks but opens no run this opener could
  // legitimately have started.
  return { kind: "broken", brokeAt: opener + 1 };
}

/**
 * Paragraphs whose quotes do not balance.
 *
 * A quotation that runs across paragraphs is legitimate in two conventions:
 *
 *   - continued speech: every paragraph re-opens with the opening mark and
 *     only the last one closes;
 *   - a block quotation (a letter, a legend read aloud, a page of lore):
 *     one opening mark where it starts, one closing mark where it ends, and
 *     nothing on the paragraphs between.
 *
 * Judging each paragraph on its own reported the second kind twice — the
 * opener as unclosed, the closer as a stray — on a manuscript that was right.
 *
 * But the first version of that tolerance re-decided WHICH convention it was
 * looking at on every paragraph, so a run could be opened as continued
 * speech, carried by a block-quotation rule, and cleared by a continued-speech
 * rule. Almost nothing survived it: an unclosed line followed by any
 * quote-free paragraph and then any ordinary line of dialogue was forgiven
 * entirely. Measured on two real books, 5 of 15 unbalanced paragraphs were
 * reported in one and 0 of 8 in the other.
 *
 * So the reading is COMMITTED at the first paragraph after the opener, and
 * the rest of the run must conform to it. When a run breaks, the paragraph
 * that OPENED it is reported — that is where the fix goes — and the scan
 * resumes at the paragraph that BROKE it, so one defect never hides the next
 * and a run that never closed is one finding rather than one per paragraph.
 */
/** A paragraph the balance check wants to say something about, and which of
 *  the two things it has to say. */
interface QuoteRunFinding {
  excerpt: string;
  kind: "unbalanced" | "no-reopen";
}

function unbalancedParagraphs(
  body: string,
  convention: QuoteConvention,
): QuoteRunFinding[] {
  const paragraphs = body.split(/\n\n+/);
  const out: QuoteRunFinding[] = [];
  let i = 0;
  while (i < paragraphs.length) {
    const shape = shapeOf(paragraphs[i], convention);
    // Balanced and self-contained: nothing to carry.
    if (shape.balance === 0) {
      i++;
      continue;
    }
    // More than one unmatched mark, or an unmatched CLOSING mark: a defect
    // that no multi-paragraph convention explains. Report and move on.
    if (shape.balance !== 1) {
      out.push({ excerpt: excerptOf(paragraphs[i]), kind: "unbalanced" });
      i++;
      continue;
    }
    // One unmatched opening mark: a run starts here. Which convention it is
    // is decided by the very next paragraph, and never revisited.
    const opener = i;
    const next = paragraphs[i + 1];
    if (next === undefined) {
      out.push({ excerpt: excerptOf(paragraphs[opener]), kind: "unbalanced" });
      break;
    }
    const outcome = runEnd(
      paragraphs,
      opener,
      convention,
      shape,
      shapeOf(next, convention),
    );
    if (outcome.kind === "no-reopen") {
      out.push({ excerpt: excerptOf(paragraphs[opener]), kind: "no-reopen" });
      i = outcome.resumeAt;
      continue;
    }
    if (outcome.kind === "broken") {
      out.push({ excerpt: excerptOf(paragraphs[opener]), kind: "unbalanced" });
      // Resume at the paragraph that broke the run, not at the one after the
      // opener: everything in between belonged to the quotation that was
      // never closed, and reading it again would report one missing mark
      // once per paragraph.
      i = outcome.brokeAt;
      continue;
    }
    i = outcome.resumeAt;
  }
  return out;
}

function findTruncation(
  units: ScanUnit[],
  explained: Set<string> = new Set(),
  convention: QuoteConvention = { family: QUOTE_FAMILIES[0], style: null },
): DraftFinding[] {
  const findings: DraftFinding[] = [];
  for (const u of units) {
    const body = u.original.trim();
    if (wordCount(body) < EMPTY_THRESHOLD) continue; // empty handled elsewhere
    // Emphasis markers and trailing whitespace are not the end of the sentence.
    const forEnding = body.replace(TRAILING_MARKUP_RE, "");
    const last = forEnding[forEnding.length - 1] ?? "";
    // The synthetic "Frontmatter" unit (chapters.ts) is title/copyright-page
    // material — a list of credits and edition info, not prose — so it has
    // no reason to end in sentence punctuation.
    if (u.name !== "Frontmatter" && !TERMINAL_END_RE.test(last)) {
      findings.push({
        check: "truncation",
        severity: "warning",
        location: u.name,
        ...say("scan_msg_truncation", { ending: forEnding.slice(-40).trim() }),
      });
      continue;
    }
    // Unbalanced quotes hint at a mid-scene cut or a mistyped closing mark.
    // Reported WITH the passage: the chapter name alone gives the author no way
    // to check whether the finding is real.
    for (const { excerpt, kind } of unbalancedParagraphs(body, convention)) {
      // A duplicated tag drags a stray ” along with it. findRepetitions has
      // already named that paragraph, and named it correctly; reporting the
      // symptom underneath is what buried the real finding.
      if (explained.has(excerpt)) continue;
      findings.push({
        check: "truncation",
        severity: "info",
        location: u.name,
        ...say(
          kind === "no-reopen" ? "scan_msg_quote_no_reopen" : "scan_msg_quote_unbalanced",
          { excerpt },
        ),
        // A house style, not a defect: applied consistently, corrupting
        // nothing, and the convention some houses use throughout. It is worth
        // saying once; it is not worth counting in "N things to check before
        // publishing", which is what blocking feeds. The genuinely unclosed
        // quotation beside it still blocks.
        ...(kind === "no-reopen" ? { blocking: false } : {}),
      });
    }
  }
  return findings;
}

/**
 * Marks that are not in the manuscript's own quotation-mark style.
 *
 * Curly or straight is the author's choice and both are correct; only
 * inconsistency is an error. So this reports nothing at all unless there is a
 * style to conform to — declared in the settings panel, or a clear majority
 * in the text. An evenly mixed manuscript with no declared style is exactly
 * the book this would do most damage to, and is left alone: the panel asks
 * its author instead.
 *
 * Its own check rather than another truncation finding. A straight mark among
 * curly ones is a house-style inconsistency, and on two real books every one
 * of them was BALANCED — `“But—"` has two marks — which is why no balance
 * check, however strict, could ever have found them.
 *
 * One finding per paragraph, not per mark. A line like `"We can try,"` has two
 * off-style marks and is one thing to fix.
 */
function findQuoteStyle(
  units: ScanUnit[],
  convention: QuoteConvention,
): DraftFinding[] {
  if (!convention.style) return [];
  const wanted = convention.style;
  const findings: DraftFinding[] = [];
  for (const u of units) {
    for (const paragraph of u.original.split(/\n\n+/)) {
      const text = paragraph.trim();
      if (!text) continue;
      const offStyle = readMarks(text, convention).filter((m) =>
        wanted === "curly" ? m.char === '"' : m.char !== '"',
      );
      if (offStyle.length === 0) continue;
      findings.push({
        check: "quote_style",
        severity: "info",
        location: u.name,
        ...say(
          wanted === "curly" ? "scan_msg_quote_straight" : "scan_msg_quote_curly",
          { excerpt: excerptOf(paragraph) },
        ),
      });
    }
  }
  return findings;
}

/**
 * The typographic marks that are not quotation marks — apostrophes, ellipses,
 * characters that cannot be seen, and drafting placeholders left in.
 *
 * Read off the WHOLE manuscript rather than per chapter. An apostrophe
 * convention is a property of the book, and a chapter of pure narration has
 * too few to judge by; counting per chapter also turned one decision into one
 * finding per chapter, which is the opposite of what this reports.
 *
 * One finding per kind, carrying its count. Ninety-three straight apostrophes
 * in a curly book is one thing to fix, not ninety-three, and listing them
 * separately would bury every other finding on the page.
 */
function findTypography(
  units: ScanUnit[],
  declared?: QuoteStyle | null,
): DraftFinding[] {
  const whole = units.map((u) => u.original).join("\n\n");
  // The key with `_one` when the count is one: "1 straight apostrophe".
  const counted = (n: number, key: string): ScanMessageKey =>
    (n === 1 ? `${key}_one` : key) as ScanMessageKey;
  return findTypographyIssues(whole, declared).map((issue): DraftFinding => {
    switch (issue.kind) {
      case "apostrophe-style":
        return {
          check: "apostrophe_style",
          // A house-style slip, like the quotation-mark one it sits beside:
          // consistently wrong is a choice, and this is neither consistent
          // nor corrupting. It is also the single commonest thing wrong with
          // a finished manuscript, which is why it is reported at all.
          severity: "info",
          location: "Manuscript",
          wholeManuscript: true,
          ...say(
            counted(
              issue.count,
              issue.expected === "curly" ? "scan_msg_apos_straight" : "scan_msg_apos_curly",
            ),
            { n: issue.count, example: issue.example },
          ),
          ...explain("scan_detail_copy_edit_normalises"),
        };
      case "ellipsis-style":
        return {
          check: "ellipsis_style",
          severity: "info",
          location: "Manuscript",
          wholeManuscript: true,
          ...say(
            counted(
              issue.count,
              issue.expected === "character" ? "scan_msg_ellipsis_dots" : "scan_msg_ellipsis_char",
            ),
            { n: issue.count, example: issue.example },
          ),
          ...explain("scan_detail_copy_edit_normalises"),
        };
      case "invisible-character":
        return {
          check: "invisible_character",
          // Worse than a style slip and not visible anywhere: a non-breaking
          // space survives every export and opens a river down a justified
          // page, and a zero-width character breaks search inside a word.
          severity: "warning",
          location: "Manuscript",
          wholeManuscript: true,
          ...say(counted(issue.count, "scan_msg_invisible"), {
            n: issue.count,
            example: issue.example,
          }),
          ...explain("scan_detail_invisible"),
        };
      case "placeholder":
        return {
          check: "placeholder",
          // The one thing here a reader would call a mistake in the book
          // rather than in its typesetting.
          severity: "error",
          location: "Manuscript",
          wholeManuscript: true,
          ...say("scan_msg_placeholder", {
            markers: issue.markers?.join(", ") ?? "",
            example: issue.example,
          }),
        };
    }
  });
}

/**
 * Two punctuation marks side by side: ".,", ",,", "?.", ".?". What counts, and
 * the exceptions that make it safe to block on, are in punctuationPairs.ts.
 *
 * One finding per pair, each with its sentence, because each is a thing to
 * go and fix — until there are so many that the list would bury everything
 * else on the page. Past that the book is damaged rather than mistyped (an
 * OCR'd import on the author's machine had 138), and one finding saying so
 * is worth more than the list.
 */
const PAIR_LIST_LIMIT = 25;

function findDoubledPunctuation(units: ScanUnit[], manuscriptLang?: string): DraftFinding[] {
  const hits = units.flatMap((u) =>
    findPunctuationPairs(u.original, manuscriptLang).map((pair) => ({
      unit: u,
      excerpt: pairExcerpt(u.original, pair),
      marks: pair.marks,
    })),
  );
  if (hits.length > PAIR_LIST_LIMIT) {
    return [
      {
        check: "punctuation_pair",
        severity: "warning",
        location: "Manuscript",
        wholeManuscript: true,
        ...say("scan_msg_punctuation_pair_many", { n: hits.length, excerpt: hits[0].excerpt }),
      },
    ];
  }
  return hits.map(({ unit, excerpt, marks }) => ({
    check: "punctuation_pair",
    severity: "warning",
    location: unit.name,
    ...say("scan_msg_punctuation_pair", { marks, excerpt }),
  }));
}

/**
 * Manuscript-wide English dialect consistency. A professionally edited
 * manuscript uses one dialect throughout; genuinely mixed usage (not one stray
 * outlier) is worth catching before publication.
 *
 * `declared` is the dialect the author chose in the copy-edit panel, when the
 * scan runs as part of a job that has one. It matters because the expected
 * dialect used to be decided by majority vote inside this function, with the
 * author's choice never reaching it at all — so a manuscript set to British
 * but still mostly American was advised to standardise on American, the exact
 * opposite of what the copy-edit pass would do to the same text. The author's
 * stated intent outranks a head-count of the draft.
 */
function findDialectConsistency(
  units: ScanUnit[],
  declared?: "american" | "british",
  manuscriptLang?: string,
): DraftFinding[] {
  // A French or German novel has no English dialect to be inconsistent about.
  // The evidence table would score it near zero and stay quiet in practice,
  // but one quoted English letter in a French book is all it takes to advise
  // a French author to standardise their spelling on American.
  if (manuscriptLang && !manuscriptLang.toLowerCase().startsWith("en")) return [];
  const combined = units.map((u) => u.original).join("\n\n");
  const { dialect, americanHits, britishHits, mixed } = detectDialect(combined);
  if (!mixed) return [];

  const finding = (
    message: ReturnType<typeof say>,
    detail: ReturnType<typeof explain>,
  ): DraftFinding[] => [
    {
      check: "dialect",
      severity: "warning",
      location: "Manuscript",
      wholeManuscript: true,
      ...message,
      ...detail,
    },
  ];

  // The author's choice first; the draft's own majority only as a fallback.
  const reference = declared ?? dialect;
  if (!reference) {
    // An exact tie. detectDialect reports dialect:null here, and bailing on
    // null used to drop the finding entirely — so the most inconsistent
    // manuscript possible passed the scan in silence. Report it, without
    // pretending either side is the house style.
    return finding(
      say("scan_msg_dialect_tie", { british: britishHits, american: americanHits }),
      explain("scan_detail_pick_dialect"),
    );
  }

  const labels = {
    keep: reference === "american" ? "scan_dialect_american" : "scan_dialect_british",
    change: reference === "american" ? "scan_dialect_british" : "scan_dialect_american",
  };
  const keepCount = reference === "american" ? americanHits : britishHits;
  const changeCount = reference === "american" ? britishHits : americanHits;

  if (declared) {
    return finding(
      say("scan_msg_dialect_declared", { n: changeCount }, labels),
      explain("scan_detail_convert_dialect", undefined, labels),
    );
  }
  return finding(
    say("scan_msg_dialect_majority", { n: changeCount, keepN: keepCount }, labels),
    explain("scan_detail_pick_dialect"),
  );
}

/** Settings from the job the scan belongs to, when it has one. */
export interface PublicationScanOptions {
  /** The dialect the author declared in the copy-edit panel. */
  englishDialect?: "american" | "british";
  /**
   * The manuscript's language, when the job knows it. Only the English
   * dialect check consults it — the quote check reads the manuscript's own
   * convention off the page instead, which is the honest source for a
   * question the language does not settle.
   */
  manuscriptLang?: string;
  /**
   * The quotation-mark style the author declared, when the scan belongs to a
   * job that has one. Falls back to the manuscript's own majority, which on a
   * 60/40 book is a guess.
   */
  quoteStyle?: QuoteStyle;
}

export function buildPublicationScan(
  units: ScanUnit[],
  options?: PublicationScanOptions,
): StructuralScanReport {
  const { findings: dupFindings } = findDuplicates(units);
  const { findings: repFindings, reported } = findRepetitions(units);
  // Read once, off the whole book: a chapter of pure narration has no quotes
  // to judge by, and would otherwise be read against a different convention
  // from the chapter before it.
  // The author's declared style wins over the manuscript's own majority —
  // see resolveConvention.
  const convention = resolveConvention(
    units.map((u) => u.original).join("\n\n"),
    options?.quoteStyle,
  );
  // The default is stated here rather than at each push site: a structural
  // finding blocks publication, and saying it once keeps that true as checks
  // are added. These are deterministic — on a real book all six were genuine
  // defects — unlike the LLM's comma suggestions, which are not findings.
  //
  // A check may opt OUT by setting blocking itself, and exactly one does: a
  // quotation that closes without re-opening is a house style rather than a
  // defect, and counting a convention among "things to check before
  // publishing" overstates it.
  const findings: StructuralFinding[] = [
    ...dupFindings,
    ...repFindings,
    ...findEmptyChapters(units),
    ...findNumberingIssues(units),
    ...findTruncation(units, reported, convention),
    ...findQuoteStyle(units, convention),
    ...findTypography(units, convention.style),
    ...findDoubledPunctuation(units, options?.manuscriptLang),
    ...findDialectConsistency(units, options?.englishDialect, options?.manuscriptLang),
  ].map((f): StructuralFinding => ({ ...f, blocking: f.blocking ?? true }));

  const summary: Record<FindingSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const f of findings) summary[f.severity]++;

  // ── What was checked, passes included ──
  //
  // A verdict of "9 issues" leaves an author unable to tell a check that
  // passed from a check that never ran, and "no duplicated chapters" is
  // something they wanted to hear rather than the absence of something.
  //
  // `skipped` is not a pass. A book with four quotation marks has no
  // convention to be measured against and a French novel has no English
  // dialect; saying "none found" there would claim a clearance the scan
  // never gave. The conditions are the ones the checks themselves use —
  // read from the same values, a line apart, so they cannot drift.
  const whole = units.map((u) => u.original).join("\n\n");
  const isEnglish =
    !options?.manuscriptLang ||
    options.manuscriptLang.toLowerCase().startsWith("en");
  const skipped = new Set<StructuralCheck>();
  if (!convention.style) skipped.add("quote_style");
  if (!isEnglish) skipped.add("dialect");
  if (!(options?.quoteStyle ?? detectApostropheStyle(whole))) {
    skipped.add("apostrophe_style");
  }
  if (!detectEllipsisStyle(whole)) skipped.add("ellipsis_style");

  const checks: CheckTally[] = STRUCTURAL_CHECKS.map((check) => {
    const found = findings.filter((f) => f.check === check).length;
    return skipped.has(check) ? { check, found, skipped: true } : { check, found };
  });

  return {
    title: "Publication readiness scan",
    chaptersScanned: units.length,
    summary,
    findings,
    checks,
  };
}
