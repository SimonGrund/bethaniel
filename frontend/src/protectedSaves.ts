// ── What the names & terms list kept out of the review ──
//
// A correction that would change a word the manuscript vouches for is never
// proposed. That is most of what the pipeline sets aside: counted across 98
// real tasks, 1,180 of 1,288 set-aside corrections — 92% — were this. The
// spell-checker tried to split `Worldsea` into "World sea" eighty-five times,
// `Blacksteel` two hundred and forty-seven times, and every one of them was
// refused before it reached the author.
//
// That list used to be shown, collapsed, as "39 skipped" beside a ⓘ. It read
// as work that got dropped and made its author stop and ask what had been
// thrown away — when in fact none of it could be accepted, acted on, or
// learned from. So the list is gone and this is what is left: one sentence
// saying how much work it saved, which is the only part of it anyone wanted.

import type { Correction } from "./types";

/**
 * How a save was recorded before `protectedTerm` existed: English prose, in
 * the `reason`. Runs already on disk when this shipped carry only that, and
 * an author looking at yesterday's run should not be told their list did
 * nothing. Preferred against, never preferred TO, the structured field — and
 * safe to delete once runs from before it have aged out of the database.
 */
const LEGACY_REASON = /^left alone: "(.+)" is in your names & terms$/;

function termOf(
  s: Pick<Correction, "protectedTerm"> & { reason?: string },
): string | null {
  if (s.protectedTerm) return s.protectedTerm;
  return s.reason?.match(LEGACY_REASON)?.[1] ?? null;
}

export interface ProtectedSaves {
  /** How many suggestions were never raised. */
  count: number;
  /** The distinct terms that did it, most-protected first. */
  terms: string[];
}

/**
 * Read from `protectedTerm`, never from `reason`. The reason is English prose
 * built for a human — `left alone: "Worldsea" is in your names & terms` — and
 * counting by a substring of it would break the moment it was reworded or
 * translated.
 */
export function protectedSaves(
  skipped: (Pick<Correction, "protectedTerm"> & { reason?: string })[],
): ProtectedSaves {
  const byTerm = new Map<string, number>();
  for (const s of skipped) {
    const term = termOf(s);
    if (!term) continue;
    byTerm.set(term, (byTerm.get(term) ?? 0) + 1);
  }
  const terms = [...byTerm.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term);
  let count = 0;
  for (const n of byTerm.values()) count += n;
  return { count, terms };
}

/** The same, summed over a job's tasks. */
export function protectedSavesAcross(
  results: ({
    skipped?: (Pick<Correction, "protectedTerm"> & { reason?: string })[];
  } | null | undefined)[],
): ProtectedSaves {
  return protectedSaves(results.flatMap((r) => r?.skipped ?? []));
}

/** How many terms to name in the sentence before saying "and N others". */
export const NAMED_TERMS = 3;
