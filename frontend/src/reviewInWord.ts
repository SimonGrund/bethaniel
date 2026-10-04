// ── Review in Word ──
//
// The export that hands the review itself to Word: every suggestion the author
// has not dismissed, as a tracked change credited to Betty, with a comment
// saying how sure she is and why. Accepting or rejecting then happens in Word,
// with Word's own buttons, for an author who would rather work there.
//
// The server marks up whatever differs between each chapter's original and
// the text built here, so this builds a chapter with every open suggestion
// applied. Two suggestions can claim the same words — a fix to one word inside
// a rewrite of its sentence — and Word can show only one revision there. The
// last one wins, "last" being the order the deck deals them in, which is the
// order the author meets them. The ones it displaced are not lost: the
// winner's comment lists them as "Betty also suggested".
//
// Pure, and tested from backend/test/reviewInWord.test.ts because the frontend
// has no test runner.

import { adjustSeamPunctuation, findAllOccurrences } from "./correctionApply";
import { certaintyPercent, isReliable } from "./types";
import type { Correction } from "./types";

/**
 * Apply every correction at each of its places; where two overlap, the later
 * wins. `beaten` records, per winner, the suggestions it pushed out — so the
 * winner's comment can still show them. A winner later pushed out itself
 * hands its list on, so nothing drops out along a chain.
 */
export function resolveLastWins(
  text: string,
  corrections: Correction[],
): { text: string; beaten: Map<Correction, Correction[]> } {
  const chosen: { c: Correction; index: number }[] = [];
  const beaten = new Map<Correction, Correction[]>();
  const record = (winner: Correction, loser: Correction) => {
    if (loser === winner) return;
    const list = beaten.get(winner) ?? [];
    for (const x of [loser, ...(beaten.get(loser) ?? [])]) {
      if (x !== winner && !list.includes(x)) list.push(x);
    }
    beaten.set(winner, list);
  };
  for (const c of corrections) {
    if (!c.original || c.original === c.corrected) continue;
    for (const index of findAllOccurrences(text, c.original)) {
      const end = index + c.original.length;
      for (let i = chosen.length - 1; i >= 0; i--) {
        const k = chosen[i];
        if (index < k.index + k.c.original.length && k.index < end) {
          chosen.splice(i, 1);
          record(c, k.c);
        }
      }
      chosen.push({ c, index });
    }
  }
  // End to start, so earlier offsets stay valid.
  chosen.sort((a, b) => b.index - a.index);
  let out = text;
  for (const { c, index } of chosen) {
    const corrected = adjustSeamPunctuation(out, index, c.original, c.corrected);
    out = out.slice(0, index) + corrected + out.slice(index + c.original.length);
  }
  return { text: out, beaten };
}

/** Apply every correction at each of its places; where two overlap, the later wins. */
export function applyLastWins(text: string, corrections: Correction[]): string {
  return resolveLastWins(text, corrections).text;
}

/** The words a comment is made of, in the reader's language. */
export interface NoteStrings {
  wouldAccept: string;
  unsure: string;
  wouldLeave: string;
  /** "{pct}% sure" */
  sure: string;
  /** Said on a suggestion the author already accepted in Betty. */
  accepted: string;
  /** "Betty also suggested: {change}" — a suggestion that lost an overlap. */
  also: string;
}

/** Below this, Betty is unsure — the deck's own line (ReviewDeck.tsx). */
const UNSURE_BELOW = 70;

/**
 * The comment on one suggestion: how sure Betty is, why she proposed it, and
 * what else she proposed for the same words — the suggestions this one
 * displaced, which Word has no other way to show.
 */
export function noteFor(
  c: Correction,
  accepted: boolean,
  s: NoteStrings,
  alsoSuggested: Correction[] = [],
): string {
  const pct = certaintyPercent(c);
  const hint = !isReliable(c)
    ? s.wouldLeave
    : pct !== null && pct < UNSURE_BELOW
      ? s.unsure
      : s.wouldAccept;
  const lines = [pct !== null ? `${hint} (${s.sure.replace("{pct}", String(pct))})` : hint];
  if (c.reviewReason?.trim()) lines.push(c.reviewReason.trim());
  if (accepted) lines.push(s.accepted);
  for (const other of alsoSuggested) {
    lines.push(s.also.replace("{change}", `“${other.original}” → “${other.corrected}”`));
  }
  return lines.join("\n");
}

export interface ReviewChapter {
  originalText: string;
  /** The suggestions to put in Word, in deck order. */
  items: { correction: Correction; accepted: boolean }[];
}

/** The chapter pairs and the comments for the tracked export. */
export function buildReviewExport(
  chapters: ReviewChapter[],
  strings: NoteStrings,
): {
  pairs: { original: string; edited: string }[];
  notes: { original: string; text: string }[][];
} {
  const resolved = chapters.map((ch) =>
    resolveLastWins(
      ch.originalText,
      ch.items.map((i) => i.correction),
    ),
  );
  return {
    pairs: chapters.map((ch, n) => ({
      original: ch.originalText,
      edited: resolved[n].text,
    })),
    notes: chapters.map((ch, n) =>
      ch.items.map((i) => ({
        original: i.correction.original,
        text: noteFor(i.correction, i.accepted, strings, resolved[n].beaten.get(i.correction)),
      })),
    ),
  };
}
