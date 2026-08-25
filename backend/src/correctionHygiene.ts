// ── Quote hygiene & export-time auto-repair for corrections ──
//
// The editor model regularly emits corrections that add quotation marks the
// manuscript already has — usually in the other style (manuscript “…”, model
// adds "…"). Applying such a correction splices a duplicate quote next to the
// existing one (“"Watch it,"”). Two layers deal with this:
//
//  1. `sanitizeQuoteCorrections` — at ingestion, right after the model's
//     corrections are parsed: strips edge quotes that duplicate an adjacent
//     quote in the source text, converts net-new quotes to the manuscript's
//     dominant style, and drops corrections that become no-ops.
//  2. `collapseIntroducedQuotePairs` / `revertSuspectRuns` — at export, in
//     /verify-corrections: repairs artifacts already baked into stored
//     results (doubled quote pairs, introduced misspellings that no single
//     accepted correction can be blamed for).

import { diffWordsWithSpace } from "diff";
import type { Correction } from "./types.js";

const DOUBLE_QUOTES = new Set(['"', "“", "”"]);
const OPEN_CONTEXT_RE = /[\s([{—–-]/;

function isDoubleQuote(ch: string | undefined): boolean {
  return ch !== undefined && DOUBLE_QUOTES.has(ch);
}

/** The manuscript's prevailing double-quote style. Ties default to curly. */
export function dominantQuoteStyle(text: string): "curly" | "straight" {
  let curly = 0;
  let straight = 0;
  for (const ch of text) {
    if (ch === "“" || ch === "”") curly++;
    else if (ch === '"') straight++;
  }
  return curly >= straight ? "curly" : "straight";
}

/** Curly quote for a position, chosen by what precedes it. */
function curlyFor(prev: string): string {
  return prev === "" || OPEN_CONTEXT_RE.test(prev) ? "“" : "”";
}

export interface QuoteSanitizeResult {
  kept: Correction[];
  /** Corrections that became no-ops once their duplicate quotes were stripped. */
  dropped: Correction[];
  /** How many kept corrections had their `corrected` text adjusted. */
  adjusted: number;
}

/**
 * Clean the quote handling of freshly parsed editor corrections against the
 * chunk text they anchor to:
 *
 *  - a quote the correction adds at its edge while the character adjacent to
 *    the match in the text is already a double quote is stripped (the model
 *    re-quoted dialogue whose quotes sit just outside its "original" span);
 *  - double quotes the correction introduces (none in `original`) are
 *    converted to the manuscript's dominant style;
 *  - corrections reduced to `original` by the above are dropped.
 */
export function sanitizeQuoteCorrections(
  contextText: string,
  corrections: Correction[],
): QuoteSanitizeResult {
  const style = dominantQuoteStyle(contextText);
  const kept: Correction[] = [];
  const dropped: Correction[] = [];
  let adjusted = 0;

  for (const c of corrections) {
    let corrected = c.corrected;
    const pos = contextText.indexOf(c.original);
    if (pos !== -1 && c.original.length > 0) {
      const prev = pos > 0 ? contextText[pos - 1] : "";
      const next = contextText[pos + c.original.length] ?? "";
      if (
        isDoubleQuote(corrected[0]) &&
        !isDoubleQuote(c.original[0]) &&
        isDoubleQuote(prev)
      ) {
        corrected = corrected.slice(1);
      }
      if (
        isDoubleQuote(corrected[corrected.length - 1]) &&
        !isDoubleQuote(c.original[c.original.length - 1]) &&
        isDoubleQuote(next)
      ) {
        corrected = corrected.slice(0, -1);
      }
    }

    // Net-new quotes → dominant style. Only when `original` carries none of
    // the foreign style, so we never touch quotes the author already had.
    if (style === "curly" && corrected.includes('"') && !c.original.includes('"')) {
      let out = "";
      for (let i = 0; i < corrected.length; i++) {
        const ch = corrected[i];
        if (ch === '"') {
          const prev =
            i > 0
              ? corrected[i - 1]
              : pos > 0
                ? contextText[pos - 1]
                : "";
          out += curlyFor(prev);
        } else {
          out += ch;
        }
      }
      corrected = out;
    } else if (
      style === "straight" &&
      /[“”]/.test(corrected) &&
      !/[“”]/.test(c.original)
    ) {
      corrected = corrected.replace(/[“”]/g, '"');
    }

    if (corrected === c.original) {
      dropped.push({
        ...c,
        reason: "re-quotes dialogue whose quotation marks already exist",
      });
      continue;
    }
    if (corrected !== c.corrected) {
      adjusted++;
      kept.push({ ...c, corrected });
    } else {
      kept.push(c);
    }
  }

  return { kept, dropped, adjusted };
}

/** Context fingerprint so pre-existing doubled quotes aren't "repaired". */
function pairContextKey(text: string, idx: number): string {
  return `${text.slice(Math.max(0, idx - 12), idx)}|${text.slice(idx + 2, idx + 14)}`;
}

export interface QuotePairFixResult {
  text: string;
  /** The doubled pairs that were collapsed, e.g. ['"”', '“"']. */
  fixes: string[];
}

/**
 * Collapse doubled double-quote pairs that `after` has but `before` doesn't:
 * mixed pairs ("” / “") and same-character pairs ("" / ““ / ””) — both are
 * splice artifacts of quote-adding corrections. Directional pairs (“” / ”“)
 * are left alone: an empty quote or back-to-back dialogue is the author's.
 * The surviving quote takes the manuscript's dominant style.
 */
export function collapseIntroducedQuotePairs(
  before: string,
  after: string,
  style: "curly" | "straight" = dominantQuoteStyle(before),
): QuotePairFixResult {
  const collapsible = (a: string, b: string): boolean => {
    if (!isDoubleQuote(a) || !isDoubleQuote(b)) return false;
    if (a === b) return true;
    return a === '"' || b === '"'; // exactly one straight → mixed-style splice
  };

  const preexisting = new Set<string>();
  for (let i = 0; i + 1 < before.length; i++) {
    if (collapsible(before[i], before[i + 1])) {
      preexisting.add(pairContextKey(before, i));
    }
  }

  const fixes: string[] = [];
  let out = "";
  let i = 0;
  while (i < after.length) {
    const a = after[i];
    const b = i + 1 < after.length ? after[i + 1] : "";
    if (collapsible(a, b) && !preexisting.has(pairContextKey(after, i))) {
      let dir: "open" | "close";
      if (a === b) {
        if (a === "“") dir = "open";
        else if (a === "”") dir = "close";
        else {
          const prev = out[out.length - 1] ?? "";
          dir = prev === "" || OPEN_CONTEXT_RE.test(prev) ? "open" : "close";
        }
      } else {
        const curly = a === '"' ? b : a;
        dir = curly === "“" ? "open" : "close";
      }
      out += style === "straight" ? '"' : dir === "open" ? "“" : "”";
      fixes.push(a + b);
      i += 2;
    } else {
      out += a;
      i++;
    }
  }
  return { text: out, fixes };
}

// ── Introduced doubled punctuation ──

const SEAM_PUNCT_RE = /[.,;:!?]/;
const SEAM_PUNCT_ALL_RE = /[.,;:!?]/g;

/**
 * Like pairContextKey, but blind to other seam punctuation in the context:
 * an introduced ",," must not shift a nearby author pair ("Run!!") out of
 * its fingerprint and get it "repaired" along with the real artifact.
 */
function punctPairContextKey(text: string, idx: number): string {
  const pre = text
    .slice(Math.max(0, idx - 16), idx)
    .replace(SEAM_PUNCT_ALL_RE, "")
    .slice(-12);
  const post = text
    .slice(idx + 2, idx + 18)
    .replace(SEAM_PUNCT_ALL_RE, "")
    .slice(0, 12);
  return `${pre}|${post}`;
}

export interface PunctuationPairFixResult {
  text: string;
  /** The doubled pairs that were collapsed, e.g. ['..', ',,']. */
  fixes: string[];
}

/**
 * Collapse same-character punctuation pairs ("..", ",,", "!!", …) that
 * `after` has but `before` doesn't — splice artifacts of corrections whose
 * `original` snippet stops just short of a sentence-final mark the manuscript
 * already has. Pairs at the same context in `before` are the author's and are
 * kept; runs of three or more (ellipses, "?!?!" flourishes) are never touched.
 */
export function collapseIntroducedPunctuationPairs(
  before: string,
  after: string,
): PunctuationPairFixResult {
  const runLength = (text: string, idx: number): number => {
    let n = 1;
    while (idx - n >= 0 && text[idx - n] === text[idx]) n++;
    const back = n - 1;
    n = 1;
    while (idx + n < text.length && text[idx + n] === text[idx]) n++;
    return back + n;
  };

  const preexisting = new Set<string>();
  for (let i = 0; i + 1 < before.length; i++) {
    if (
      SEAM_PUNCT_RE.test(before[i]) &&
      before[i] === before[i + 1] &&
      runLength(before, i) === 2
    ) {
      preexisting.add(before[i] + punctPairContextKey(before, i));
    }
  }

  const fixes: string[] = [];
  let out = "";
  let i = 0;
  while (i < after.length) {
    const ch = after[i];
    if (
      SEAM_PUNCT_RE.test(ch) &&
      after[i + 1] === ch &&
      runLength(after, i) === 2 &&
      !preexisting.has(ch + punctPairContextKey(after, i))
    ) {
      out += ch;
      fixes.push(ch + ch);
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return { text: out, fixes };
}

// ── Contained-correction folding ──
//
// combined_edit regularly produces a sentence-level rewrite AND a smaller
// fix inside the same sentence (rewrite of "…her two knifes and…" plus
// "knifes"→"knives"). At apply time the corrections are spliced end→start,
// so the inner fix mutates the sentence first and the rewrite is skipped as
// "not found (collision with nearby edit)". Folding resolves this at
// ingestion: the small fix is merged into every containing rewrite's
// `corrected`, and dropped as a separate correction when it occurs nowhere
// else in the chunk.

const FOLD_WORD_CHAR_RE = /[\p{L}\p{N}'’ʼ-]/u;
const FOLD_EDGE_ALNUM_RE = /[\p{L}\p{N}]/u;

function cleanWordEdgesAt(text: string, pos: number, match: string): boolean {
  if (match.length === 0) return false;
  if (
    FOLD_EDGE_ALNUM_RE.test(match[0]) &&
    pos > 0 &&
    FOLD_WORD_CHAR_RE.test(text[pos - 1])
  ) {
    return false;
  }
  const after = pos + match.length;
  if (
    FOLD_EDGE_ALNUM_RE.test(match[match.length - 1]) &&
    after < text.length &&
    FOLD_WORD_CHAR_RE.test(text[after])
  ) {
    return false;
  }
  return true;
}

export function boundaryOccurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  let idx = -1;
  while ((idx = text.indexOf(needle, idx + 1)) !== -1) {
    if (cleanWordEdgesAt(text, idx, needle)) out.push(idx);
  }
  return out;
}

/** Replace every boundary-checked occurrence of `needle` in `text`. */
function replaceWholeWordish(
  text: string,
  needle: string,
  replacement: string,
): string {
  const positions = boundaryOccurrences(text, needle);
  let out = text;
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    out = out.slice(0, pos) + replacement + out.slice(pos + needle.length);
  }
  return out;
}

export interface FoldResult {
  kept: Correction[];
  /** Contained corrections removed because every occurrence of their
   *  `original` lies inside a containing rewrite (which now carries the fix). */
  dropped: Correction[];
  /** Number of rewrites whose `corrected` absorbed a contained fix. */
  folded: number;
}

/**
 * Merge corrections whose `original` span lies inside a larger correction's
 * span into that larger correction. Processing is smallest-first so chains
 * (word fix ⊂ clause fix ⊂ sentence rewrite) propagate outward.
 */
export function foldContainedCorrections(
  contextText: string,
  corrections: Correction[],
): FoldResult {
  interface Entry {
    c: Correction;
    corrected: string;
    spans: [number, number][];
  }
  const entries: Entry[] = corrections.map((c) => ({
    c,
    corrected: c.corrected,
    spans: boundaryOccurrences(contextText, c.original).map(
      (p) => [p, p + c.original.length] as [number, number],
    ),
  }));

  const bySize = [...entries].sort(
    (a, b) => a.c.original.length - b.c.original.length,
  );

  let folded = 0;
  const droppedSet = new Set<Entry>();

  for (const inner of bySize) {
    if (inner.spans.length === 0 || inner.c.original === inner.c.corrected)
      continue;
    const containers = entries.filter(
      (outer) =>
        outer !== inner &&
        !droppedSet.has(outer) &&
        outer.c.original.length > inner.c.original.length &&
        outer.c.original.includes(inner.c.original),
    );
    if (containers.length === 0) continue;

    // Fold the fix into every containing rewrite that still shows the flaw.
    for (const outer of containers) {
      const next = replaceWholeWordish(
        outer.corrected,
        inner.c.original,
        inner.corrected,
      );
      if (next !== outer.corrected) {
        outer.corrected = next;
        folded++;
      }
    }

    // Drop the inner correction only when every occurrence in the chunk is
    // covered by a container span — elsewhere it must still apply on its own.
    const containerSpans = containers.flatMap((o) => o.spans);
    const allCovered = inner.spans.every(([s, e]) =>
      containerSpans.some(([cs, ce]) => s >= cs && e <= ce),
    );
    if (allCovered) droppedSet.add(inner);
  }

  const kept: Correction[] = [];
  const dropped: Correction[] = [];
  for (const entry of entries) {
    if (droppedSet.has(entry)) {
      dropped.push({
        ...entry.c,
        reason: "merged into an overlapping rewrite",
      });
    } else if (entry.corrected !== entry.c.corrected) {
      kept.push({ ...entry.c, corrected: entry.corrected });
    } else {
      kept.push(entry.c);
    }
  }
  return { kept, dropped, folded };
}

// Word tokens — matches spellcheck.ts WORD_RE (2+ letters, apostrophes join).
const WORD_RE = /\p{L}[\p{L}'’ʼ-]*[\p{L}]/gu;

function normalizeWord(w: string): string {
  return w.replace(/[’ʼ]/g, "'").toLowerCase();
}

export interface SuspectRevertResult {
  text: string;
  /** The suspect words whose surrounding edit was reverted. */
  reverted: string[];
}

/**
 * Revert the edits that introduced the given suspect words. `before`/`after`
 * are word-diffed; any inserted run containing a suspect (as a whole word) is
 * replaced by the run it displaced — restoring the author's original wording
 * at exactly that spot. Used for misspellings the export check cannot pin on
 * a single accepted correction (e.g. two overlapping corrections splicing
 * "Studentss"), where un-accepting is not an option.
 */
export function revertSuspectRuns(
  before: string,
  after: string,
  suspects: string[],
): SuspectRevertResult {
  if (suspects.length === 0) return { text: after, reverted: [] };
  const suspectSet = new Set(suspects.map(normalizeWord));
  const findSuspect = (s: string): string | null => {
    for (const m of s.match(WORD_RE) ?? []) {
      if (suspectSet.has(normalizeWord(m))) return m;
    }
    return null;
  };

  const changes = diffWordsWithSpace(before, after);
  const reverted: string[] = [];
  let out = "";
  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i];
    if (ch.removed) {
      const next = changes[i + 1];
      if (next?.added) {
        const hit = findSuspect(next.value);
        if (hit) {
          out += ch.value; // restore the original run…
          reverted.push(hit);
          i++; // …and skip the inserted one
        }
        // otherwise: normal replacement — drop removed, added appended next.
      }
      continue;
    }
    if (ch.added) {
      const hit = findSuspect(ch.value);
      if (hit) {
        reverted.push(hit); // pure insertion of a bad word — drop it
        continue;
      }
    }
    out += ch.value;
  }
  return { text: out, reverted };
}

/**
 * Pre-approve deterministic spell fixes that an LLM editor independently
 * confirmed, so they bypass the skeptical reviewer that otherwise withholds
 * obvious spelling corrections.
 *
 * The Hunspell spell-checker reliably DETECTS misspellings but its top
 * suggestion is often wrong ("teh"→"ten", "Alot"→"Allot"), so a deterministic
 * fix is trusted only when an editor produced the IDENTICAL original→corrected
 * pair. Agreement is a strong signal the change is both needed and right.
 *
 * Mutates the matching `spellCorrections` in place (sets `preApproved`) and
 * returns the editor corrections with the now-redundant duplicates removed, so
 * each agreed fix is listed and applied exactly once.
 */
export function reconcileSpellWithEditor(
  spellCorrections: Correction[],
  editorCorrections: Correction[],
): Correction[] {
  if (spellCorrections.length === 0) return editorCorrections;

  const key = (c: Correction) => JSON.stringify([c.original, c.corrected]);
  const editorKeys = new Set(editorCorrections.map(key));

  const agreedKeys = new Set<string>();
  for (const sc of spellCorrections) {
    const k = key(sc);
    if (editorKeys.has(k)) {
      sc.preApproved = true;
      agreedKeys.add(k);
    }
  }

  if (agreedKeys.size === 0) return editorCorrections;
  return editorCorrections.filter((c) => !agreedKeys.has(key(c)));
}

/**
 * Drop corrections that are no-ops after whitespace normalization — e.g. an
 * editor "fixing" a period by replacing it with another period. These
 * occasionally slip through the editor/reviewer pipeline and would otherwise
 * surface as an inexplicable suggestion with no visible change.
 */
// Zero-width and other invisible "format" characters a model can slip into
// a "fix" — invisible to a human, but different bytes, so a plain
// trim+collapse-whitespace check still sees two strings as distinct (reads
// to a user as "replacing a dot with a dot"). Regular whitespace, including
// NBSP, is already covered by \s below. Built from numeric code points
// rather than typed as literal characters — these are invisible/bidi-control
// code points that must never appear as literal source bytes.
const INVISIBLE_CODE_POINTS = [
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width space/joiners, direction marks
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embedding/override
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner, invisible operators
  0xfeff, // BOM / zero-width no-break space
  0x00ad, // soft hyphen
];
const INVISIBLE_RE = new RegExp(
  `[${INVISIBLE_CODE_POINTS.map((c) => String.fromCharCode(c)).join("")}]`,
  "g",
);

function normalizeForComparison(s: string): string {
  return s.replace(INVISIBLE_RE, "").trim().replace(/\s+/g, " ");
}

export function dropNoOpCorrections(corrections: Correction[]): Correction[] {
  return corrections.filter(
    (c) =>
      normalizeForComparison(c.original) !== normalizeForComparison(c.corrected),
  );
}

const TRAILING_PUNCT_RE = /^[.!?,:;…]+$/;

/**
 * Drop corrections that only APPEND terminal punctuation (e.g. adding a
 * period) when that exact punctuation already exists as the very next
 * character(s) in the source, right after the correction's own span. This is
 * an editor "fixing" a sentence that already properly ends — its local
 * context window just cuts off before the real punctuation — and applying
 * the correction as given would double it up ("..").
 */
export function dropRedundantPunctuationAppends(
  chapterText: string,
  corrections: Correction[],
): Correction[] {
  return corrections.filter((c) => {
    if (!c.corrected.startsWith(c.original)) return true;
    const added = c.corrected.slice(c.original.length);
    if (!added || !TRAILING_PUNCT_RE.test(added)) return true;
    const positions = boundaryOccurrences(chapterText, c.original);
    const redundant = positions.some(
      (pos) =>
        chapterText.slice(
          pos + c.original.length,
          pos + c.original.length + added.length,
        ) === added,
    );
    return !redundant;
  });
}

/**
 * Chapter-level correction dedup, run once all of a chapter's chunk
 * corrections are assembled. Overlapping chunks and chunk boundaries can
 * produce the same correction multiple times, sometimes with extra context.
 *
 * Pass 0: drop no-op corrections (e.g. an editor "fixing" a period by
 * replacing it with another period) before they can subsume real fixes.
 *
 * Pass 0b: drop corrections that only append terminal punctuation already
 * present right after their own span (an editor's context window ending
 * just short of a sentence that already properly closes).
 *
 * Pass 1: exact dedup by (original, corrected) with whitespace normalisation.
 *
 * Pass 2: remove corrections whose (original, corrected) pair is fully
 * contained within a shorter correction AND anchored at the same spot in the
 * chapter — i.e. the shorter one already captures the same fix with less
 * context, making the longer one redundant. The position check matters: two
 * distinct, unrelated fixes can have strings that are lexical substrings of
 * each other without being the same edit, and a pure string-containment
 * check would silently drop the real one.
 */
export function dedupeChapterCorrections(
  chapterText: string,
  corrections: Correction[],
): Correction[] {
  const noOpFree = dropRedundantPunctuationAppends(
    chapterText,
    dropNoOpCorrections(corrections),
  );

  const seen = new Set<string>();
  const deduped: Correction[] = [];
  for (const c of noOpFree) {
    const k = JSON.stringify([
      normalizeForComparison(c.original),
      normalizeForComparison(c.corrected),
    ]);
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(c);
    }
  }

  const spanCache = new Map<string, [number, number][]>();
  const spansFor = (s: string): [number, number][] => {
    let spans = spanCache.get(s);
    if (!spans) {
      spans = boundaryOccurrences(chapterText, s).map(
        (p) => [p, p + s.length] as [number, number],
      );
      spanCache.set(s, spans);
    }
    return spans;
  };
  const subsumeFree: Correction[] = [];
  for (const c of deduped) {
    const cSpans = spansFor(c.original);
    const subsumed = deduped.some((other) => {
      if (
        other === c ||
        other.original.length >= c.original.length ||
        !c.original.includes(other.original) ||
        !c.corrected.includes(other.corrected)
      )
        return false;
      const otherSpans = spansFor(other.original);
      if (cSpans.length === 0 || otherSpans.length === 0) return false;
      return otherSpans.some(([os, oe]) =>
        cSpans.some(([cs, ce]) => os >= cs && oe <= ce),
      );
    });
    if (!subsumed) subsumeFree.push(c);
  }

  return subsumeFree;
}
