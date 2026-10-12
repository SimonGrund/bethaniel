// ── Two kinds of suggestion that are never right ──
//
// Measured on a real 85,000-word fantasy novel (Local Betty, combined edit,
// October 2026): 834 cards reached the author, and two shapes among them
// were wrong every time they were looked at.
//
// 1. A capital taken off the first word of a sentence. "We → we",
//    "She → she", "I → i", "“And → “and" — 38 cards, 36 of them scored 4 or
//    5 by the reviewer, which reads the change and not the sentence it sits
//    in. Lowercasing a word mid-sentence can be a real fix ("the King" when
//    the book writes "the king"); at the start of a sentence it cannot.
//
// 2. "No dictionary recognises this word", for a word the book itself uses
//    three times or more — colosseum (14 cards), outsail, chokehold,
//    unclenched. A word written the same way again and again is the
//    author's, and the finding proposes no fix, so it can only be dismissed.
//    The lexicon (lexicon.ts) protects coinages from five uses up; these are
//    the ones under that bar and the ones it never saw. A repeated typo is
//    not lost by this: the dictionary's guesses (reason "spell-check") are
//    untouched — only the no-guess finding is withheld.
//
// Both run where gateProtectedTerms runs (queue.ts), on every source at once,
// and hand back what they drop so it is listed as left alone, not lost.
//
// Pure; tested from backend/test/noiseGates.test.ts.

import type { Correction } from "./types.js";
import { isSentenceInitial } from "./spellcheck.js";

export interface NoiseGateResult {
  kept: Correction[];
  dropped: { correction: Correction; why: string }[];
}

const WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;

function words(s: string): { w: string; at: number }[] {
  return [...s.matchAll(WORD)].map((m) => ({ w: m[0], at: m.index! }));
}

const isUpper = (ch: string) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();

/** Does this correction take the capital off a word that opens a sentence? */
export function lowercasesSentenceStart(c: Correction, text: string): boolean {
  const at = text.indexOf(c.original);
  if (at < 0) return false;
  const a = words(c.original);
  const b = words(c.corrected);
  // Word for word when the shapes agree; otherwise only the first word, which
  // is where a rewrite that also lowercases tends to do it.
  const pairs = a.length === b.length ? a.map((x, i) => [x, b[i]] as const) : a.length && b.length ? [[a[0], b[0]] as const] : [];
  for (const [x, y] of pairs) {
    if (x.w === y.w || x.w.toLowerCase() !== y.w.toLowerCase()) continue;
    if (!isUpper(x.w[0]) || isUpper(y.w[0])) continue;
    if (isSentenceInitial(text, at + x.at)) return true;
  }
  return false;
}

export function dropSentenceStartLowercasing(cs: Correction[], text: string): NoiseGateResult {
  const kept: Correction[] = [];
  const dropped: NoiseGateResult["dropped"] = [];
  for (const c of cs) {
    if (lowercasesSentenceStart(c, text)) {
      dropped.push({ correction: c, why: "left alone: it would lowercase the start of a sentence" });
    } else kept.push(c);
  }
  return { kept, dropped };
}

const bare = (s: string) => s.trim().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase();

/**
 * The unknown words the manuscript uses at least `min` times, lower-cased:
 * the words a no-guess finding should not be raised for. `isWord` must be
 * the speller's own question — the declared dialect's dictionary
 * (spellcheck.ts getWordValidator), not "known in either English": the
 * speller raises a no-guess finding for a word only the other dialect knows
 * (colosseum, amongst), and those are exactly the cards to spare. With no
 * dictionary there is nothing to compute.
 */
export function recurringUnknownWords(
  texts: string[],
  isWord: ((w: string) => boolean) | null,
  min = 3,
): string[] {
  if (!isWord) return [];
  const counts = new Map<string, { n: number; form: string }>();
  for (const t of texts) {
    for (const { w } of words(t)) {
      const k = w.toLowerCase();
      const e = counts.get(k);
      if (e) e.n++;
      else counts.set(k, { n: 1, form: w.replace(/’/g, "'") });
    }
  }
  const out: string[] = [];
  for (const [k, { n, form }] of counts) {
    if (n < min || k.length < 3) continue;
    // Asked of the form as written as well as lower-cased: "Aaron" is a
    // word, "aaron" is not.
    if (isWord(form) || isWord(k.replace(/’/g, "'"))) continue;
    out.push(k);
  }
  return out.sort();
}

export function dropRecurringUnknowns(cs: Correction[], recurring: ReadonlySet<string>): NoiseGateResult {
  if (recurring.size === 0) return { kept: cs, dropped: [] };
  const kept: Correction[] = [];
  const dropped: NoiseGateResult["dropped"] = [];
  for (const c of cs) {
    if (c.reason === "spell-check-unknown" && recurring.has(bare(c.original))) {
      dropped.push({ correction: c, why: "left alone: the manuscript uses this word three times or more" });
    } else kept.push(c);
  }
  return { kept, dropped };
}
