// ── Publication-readiness structural scan ──
// Deterministic (no-LLM) whole-manuscript check for obvious assembly flaws:
// duplicate chapters/blocks, empty or dropped chapters, chapter-numbering gaps,
// and content cut off mid-sentence (a proxy for a missing page). Mirrors the
// philosophy of consistency.ts — fast, offline, no model required.

import { createHash } from "crypto";
import { splitIntoParagraphs } from "./chunking.js";
import { detectDialect } from "./dialect.js";
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

/** A finding before the assembler stamps its publication verdict on it. */
type DraftFinding = Omit<StructuralFinding, "blocking">;

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

function findEmptyChapters(units: ScanUnit[]): DraftFinding[] {
  const findings: DraftFinding[] = [];
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

/**
 * The pair of marks a manuscript opens and closes speech with.
 *
 * English curly quotes were hard-coded here, which on a French novel meant the
 * check found no quotation marks at all and passed every chapter in silence —
 * the dialogue was in guillemets. The convention is the manuscript's, not the
 * language's (a French author may well use “ ”, a German one » «), so it is
 * counted off the text rather than looked up from a language code.
 */
const QUOTE_FAMILIES = [
  { open: "\u201C", close: "\u201D" }, // “ ”  English, and French houses that follow it
  { open: "\u00AB", close: "\u00BB" }, // « »  French, and the continental default
  { open: "\u201E", close: "\u201C" }, // „ “  German
  { open: "\u00BB", close: "\u00AB" }, // » «  German reversed guillemets
] as const;

type QuoteFamily = (typeof QUOTE_FAMILIES)[number];

function countOf(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * Which family this manuscript speaks in: whichever opener it uses most.
 *
 * „ “ is decided before “ ”, because a German manuscript contains both — its
 * closer IS the English opener — and counting openers alone would call it
 * English and then report every closed line as unbalanced.
 */
export function detectQuoteFamily(text: string): QuoteFamily {
  const german = countOf(text, "\u201E");
  if (german > 0 && german >= countOf(text, "\u201C") - german) return QUOTE_FAMILIES[2];
  let best: QuoteFamily = QUOTE_FAMILIES[0];
  let bestCount = -1;
  for (const f of QUOTE_FAMILIES) {
    // » « is only ever the right reading when « is not itself the opener.
    if (f.open === "\u00BB" && countOf(text, "\u00AB") >= countOf(text, "\u00BB")) continue;
    const n = countOf(text, f.open);
    if (n > bestCount) {
      best = f;
      bestCount = n;
    }
  }
  return best;
}

function quoteBalance(paragraph: string, family: QuoteFamily): QuoteBalance {
  const text = paragraph.trim();
  return {
    opens: countOf(text, family.open),
    closes: countOf(text, family.close),
    startsWithOpen: new RegExp(`^[_*]*${family.open}`).test(text),
  };
}

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
        message: `Text is repeated verbatim inside one paragraph ("${span}") — usually a line of dialogue duplicated by a bad edit or import.`,
        detail: excerpt,
      });
      reported.add(excerpt);
    }
  }
  return { findings, reported };
}

/**
 * Paragraphs whose quotes do not balance.
 *
 * A quotation that runs across paragraphs is legitimate in two conventions,
 * and the check carries the open quote from one paragraph to the next so
 * that both pass:
 *
 *   - continued speech: every paragraph re-opens with “ and only the last
 *     one closes;
 *   - a block quotation (a letter, a legend read aloud, a page of lore):
 *     one “ where it starts, one ” where it ends, and nothing on the
 *     paragraphs between.
 *
 * Judging each paragraph on its own reported the second kind twice — the
 * opener as unclosed, the closer as a stray — on a manuscript that was right.
 *
 * What still counts as wrong: two opens in one paragraph, a close with
 * nothing open, a quote left open when other speech begins, and one left
 * open at the end of the chapter. Each is reported with the paragraph that
 * opened it, since that is where the fix goes.
 */
function unbalancedParagraphs(body: string, family: QuoteFamily): string[] {
  const paragraphs = body.split(/\n\n+/);
  const out: string[] = [];
  // The paragraph whose quote is still open, if any, and how it opened.
  let carried: { excerpt: string; startsWithOpen: boolean } | null = null;
  for (const p of paragraphs) {
    const { opens, closes, startsWithOpen } = quoteBalance(p, family);
    const balance = opens - closes;
    if (carried) {
      // No quotes at all: the middle of a block quotation.
      if (opens === 0 && closes === 0) continue;
      // One close and nothing opened: the block quotation ends here.
      if (opens === 0 && closes === 1) {
        carried = null;
        continue;
      }
      // Continued speech, paragraph by paragraph — only when the speech
      // was opened that way too.
      if (carried.startsWithOpen && startsWithOpen && (balance === 0 || balance === 1)) {
        if (balance === 0) carried = null;
        continue;
      }
      // Anything else while a quote is open means the open one was never
      // closed: report it, and read this paragraph on its own.
      out.push(carried.excerpt);
      carried = null;
    }
    if (balance === 0) continue;
    if (balance === 1) {
      carried = { excerpt: excerptOf(p), startsWithOpen };
      continue;
    }
    out.push(excerptOf(p));
  }
  if (carried) out.push(carried.excerpt);
  return out;
}

function findTruncation(
  units: ScanUnit[],
  explained: Set<string> = new Set(),
  family: QuoteFamily = QUOTE_FAMILIES[0],
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
        message: `Chapter ends without terminal punctuation ("…${forEnding.slice(-40).trim()}") — content may be cut off.`,
      });
      continue;
    }
    // Unbalanced quotes hint at a mid-scene cut or a mistyped closing mark.
    // Reported WITH the passage: the chapter name alone gives the author no way
    // to check whether the finding is real.
    for (const excerpt of unbalancedParagraphs(body, family)) {
      // A duplicated tag drags a stray ” along with it. findRepetitions has
      // already named that paragraph, and named it correctly; reporting the
      // symptom underneath is what buried the real finding.
      if (explained.has(excerpt)) continue;
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

  const finding = (message: string, detail: string): DraftFinding[] => [
    { check: "dialect", severity: "warning", location: "Manuscript", message, detail },
  ];

  // The author's choice first; the draft's own majority only as a fallback.
  const reference = declared ?? dialect;
  if (!reference) {
    // An exact tie. detectDialect reports dialect:null here, and bailing on
    // null used to drop the finding entirely — so the most inconsistent
    // manuscript possible passed the scan in silence. Report it, without
    // pretending either side is the house style.
    return finding(
      `Mixed English spelling: ${britishHits} word(s) use British spelling and ${americanHits} use American, in equal measure.`,
      "Pick one dialect and apply it consistently before publishing.",
    );
  }

  const keepLabel = reference === "american" ? "American" : "British";
  const changeLabel = reference === "american" ? "British" : "American";
  const keepCount = reference === "american" ? americanHits : britishHits;
  const changeCount = reference === "american" ? britishHits : americanHits;

  if (declared) {
    return finding(
      `Mixed English spelling: ${changeCount} word(s) use ${changeLabel} spelling, but this manuscript is set to ${keepLabel}.`,
      `Convert them to ${keepLabel} spelling, or change the dialect setting, before publishing.`,
    );
  }
  return finding(
    `Mixed English spelling: mostly ${keepLabel} (${keepCount} word(s)) but ${changeCount} word(s) use ${changeLabel} spelling.`,
    "Pick one dialect and apply it consistently before publishing.",
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
  const family = detectQuoteFamily(units.map((u) => u.original).join("\n\n"));
  // Marked here rather than at each push site: every structural finding is a
  // publication blocker, and stating it once keeps that true as checks are
  // added. These are deterministic — on a real book all six were genuine
  // defects — unlike the LLM's comma suggestions, which are not findings.
  const findings: StructuralFinding[] = [
    ...dupFindings,
    ...repFindings,
    ...findEmptyChapters(units),
    ...findNumberingIssues(units),
    ...findTruncation(units, reported, family),
    ...findDialectConsistency(units, options?.englishDialect, options?.manuscriptLang),
  ].map((f): StructuralFinding => ({ ...f, blocking: true }));

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
