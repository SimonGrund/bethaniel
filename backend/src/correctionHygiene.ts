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

function boundaryOccurrences(text: string, needle: string): number[] {
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
