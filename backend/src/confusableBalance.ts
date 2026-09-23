// ── The rare member of a live confusable set ──
//
// Confusable words are 1 in every 20 words of a real novel: 4,251 occurrences
// in one test manuscript and 5,776 in the other, to/too alone accounting for
// 2,413 and 3,478. So reporting every occurrence is not an option — it would
// be some five thousand findings a book.
//
// What IS possible: where a book uses one member of a set overwhelmingly and
// another barely at all, the rare one is worth a look. Measured at 1:20 that
// is 5 occurrences in one book and 3 in the other —
//
//   write:3 vs right:72     breathe:2 vs breath:54     reign:1 vs rain:23
//
// At 1:10 it is 177 and 250, which is why the ratio is not a knob.
//
// This deliberately does NOT serve their/there (313 vs 191) or to/too.
// Nothing frequency-based can; those need confusablePatterns.ts.
//
// Nothing is proposed. Both words are real words, and which one belongs is a
// question only the author can answer — so this is a listing to inspect, and
// it never produces a Correction. A Correction would be pre-approved and
// APPLIED, which is exactly wrong for a judgement that is not ours to make.

import { CONFUSABLE_SETS, CONFUSABLE_SETS_BY_LANG } from "./confusables.js";

/** How much more common the other member must be before the rare one is
 *  worth asking about. 1:10 produced 177 and 250 findings; 1:20 produced 5
 *  and 3. */
const RARE_RATIO = 20;

export interface RareMember {
  set: string[];
  /** The member the book barely uses. */
  word: string;
  count: number;
  /** The member it uses instead. */
  leader: string;
  leaderCount: number;
}

function setsFor(lang?: string): readonly (readonly string[])[] {
  const key = (lang ?? "en").toLowerCase().split(/[-_]/)[0];
  if (key === "en") return CONFUSABLE_SETS;
  return (
    (CONFUSABLE_SETS_BY_LANG as Record<
      string,
      readonly (readonly string[])[]
    >)[key] ?? []
  );
}

export function findRareConfusableMembers(
  text: string,
  lang?: string,
): RareMember[] {
  const sets = setsFor(lang);
  if (sets.length === 0) return [];

  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  const out: RareMember[] = [];
  for (const set of sets) {
    const counts = set.map((w) => freq.get(w.toLowerCase()) ?? 0);
    const max = Math.max(...counts);
    if (max === 0) continue;
    // A set the book uses only one member of has nothing to confuse.
    if (counts.filter((c) => c > 0).length < 2) continue;
    const leader = set[counts.indexOf(max)];
    for (let i = 0; i < set.length; i++) {
      const n = counts[i];
      if (n === 0 || set[i] === leader) continue;
      if (n * RARE_RATIO > max) continue;
      out.push({
        set: [...set],
        word: set[i],
        count: n,
        leader,
        leaderCount: max,
      });
    }
  }
  return out;
}
