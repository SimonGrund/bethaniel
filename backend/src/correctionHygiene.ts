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
