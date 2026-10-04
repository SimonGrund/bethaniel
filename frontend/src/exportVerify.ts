// ── Export-time correction application & spell verification ──
// The manuscript the user exports is assembled here by applying ACCEPTED
// corrections onto each chapter's original text. This path bypasses the
// backend pipeline's spell gates, so before export the assembled text is
// diffed against the original server-side (/verify-corrections) and any
// accepted correction that introduces a misspelling is un-accepted.

import { verifyCorrections } from "./api";
import { adjustSeamPunctuation, findAllOccurrences } from "./correctionApply";
import type { Correction, TaskResult } from "./types";

// The matching rules — where a correction may land, and how the punctuation
// at its seams is kept tidy — live in correctionApply.ts, which has no
// network dependency and so can be tested and shared.
export { findAllOccurrences } from "./correctionApply";

/** Apply only accepted corrections to the original text. */
export function applyAccepted(
  originalText: string,
  corrections: Correction[],
  acceptedIds: Set<string>,
): string {
  // Build a flat list of (position, correction) for every accepted occurrence.
  // Key format:
  //   - Bare "correctionId" in the set → all occurrences accepted
  //   - "correctionId:0", "correctionId:1" → individual occurrences accepted
  const positioned: { correction: Correction; index: number }[] = [];

  for (const c of corrections) {
    if (!c.id) continue;
    const allAccepted = acceptedIds.has(c.id);
    if (!allAccepted) {
      // Check if ANY individual occurrence key exists for this correction
      const hasAny = (() => {
        for (const key of acceptedIds) {
          if (key.startsWith(`${c.id}:`)) return true;
        }
        return false;
      })();
      if (!hasAny) continue; // skip entirely — nothing accepted for this correction
    }

    const occs = findAllOccurrences(originalText, c.original);
    for (let occIdx = 0; occIdx < occs.length; occIdx++) {
      const occKey = `${c.id}:${occIdx}`;
      if (allAccepted || acceptedIds.has(occKey)) {
        positioned.push({ correction: c, index: occs[occIdx] });
      }
    }
  }

  if (positioned.length === 0) return originalText;

  // Overlapping spans (two accepted corrections claiming the same region)
  // would corrupt each other when applied in sequence. The larger edit wins —
  // a sentence rewrite carries any word fix contained in it — matching the
  // backend's applyCorrections so the export reproduces the engine's text.
  positioned.sort(
    (a, b) => b.correction.original.length - a.correction.original.length,
  );
  const chosen: typeof positioned = [];
  for (const p of positioned) {
    const clashes = chosen.some(
      (k) =>
        p.index < k.index + k.correction.original.length &&
        k.index < p.index + p.correction.original.length,
    );
    if (!clashes) chosen.push(p);
  }

  // Sort all replacements from last to first so earlier indices don't shift
  chosen.sort((a, b) => b.index - a.index);

  let result = originalText;
  for (const { correction, index } of chosen) {
    const corrected = adjustSeamPunctuation(
      result,
      index,
      correction.original,
      correction.corrected,
    );
    result =
      result.slice(0, index) +
      corrected +
      result.slice(index + correction.original.length);
  }
  return result;
}

export interface ExcludedCorrection {
  taskId: string;
  original: string;
  corrected: string;
  word: string;
}

export interface VerifyOutcome {
  /** Corrections that were un-accepted because they introduce misspellings. */
  excluded: ExcludedCorrection[];
  /** Introduced errors the server repaired in place (reverted misspellings,
   *  collapsed doubled quotes) — informational. */
  autoFixed: string[];
  /** Straight quotation marks made curly to match the rest of the
   *  manuscript. A tidy-up, not a repair: usually the author typed them. */
  quotesCurled: number;
  /** Introduced misspellings that could not be fixed — check manually. */
  unattributed: string[];
  /** Per-task export text with the server's auto-repairs applied. Exports
   *  must prefer these over re-applying accepted corrections themselves. */
  fixedTexts: Record<string, string>;
  /** False when no dictionary was available or the check errored. */
  checked: boolean;
}

const MAX_VERIFY_ITERATIONS = 5;

/** True when a correction has anything accepted (bare id or occurrence key). */
function isAccepted(acceptedIds: Set<string>, id: string): boolean {
  if (acceptedIds.has(id)) return true;
  for (const key of acceptedIds) {
    if (key.startsWith(`${id}:`)) return true;
  }
  return false;
}

/**
 * Verify that the accepted corrections of the given tasks don't introduce
 * misspellings into the assembled text. Offending corrections are un-accepted
 * via `unaccept` (mutating the caller's store) and the check repeats on the
 * rebuilt text until clean. Never throws: on API failure the export proceeds
 * unverified (`checked: false`).
 */
export async function verifyAcceptedCorrections(
  entries: { taskId: string; result: TaskResult }[],
  acceptedCorrections: Record<string, Set<string> | undefined>,
  unaccept: (taskId: string, ids: string[]) => void,
  opts: {
    englishDialect?: string;
    styleGuide?: string;
    manuscriptLang?: string;
    docId?: string;
  },
): Promise<VerifyOutcome> {
  const excluded: ExcludedCorrection[] = [];
  const autoFixed = new Set<string>();
  let quotesCurled = 0;
  const unattributed = new Set<string>();
  const fixedTexts: Record<string, string> = {};

  // Local working copies of the accepted sets so the rebuild inside the loop
  // reflects un-acceptances immediately (the store is updated via `unaccept`).
  const working = new Map<string, Set<string>>(
    entries.map((e) => [
      e.taskId,
      new Set(acceptedCorrections[e.taskId] ?? []),
    ]),
  );

  try {
    for (let iteration = 0; iteration < MAX_VERIFY_ITERATIONS; iteration++) {
      const payload = entries.map((e) => {
        const accepted = working.get(e.taskId)!;
        return {
          before: e.result.originalText,
          after: applyAccepted(
            e.result.originalText,
            e.result.corrections,
            accepted,
          ),
          corrections: e.result.corrections
            .filter((c) => c.id && isAccepted(accepted, c.id))
            .map((c) => ({ id: c.id!, corrected: c.corrected })),
        };
      });

      const res = await verifyCorrections(payload, opts);
      if (!res.checked) {
        return {
          excluded,
          autoFixed: [...autoFixed],
          quotesCurled,
          unattributed: [...unattributed],
          fixedTexts,
          checked: false,
        };
      }

      let anyOffenders = false;
      res.chapters.forEach((ch, i) => {
        const entry = entries[i];
        if (ch.offenders.length === 0) return;
        anyOffenders = true;
        const ids = ch.offenders.map((o) => o.id);
        const accepted = working.get(entry.taskId)!;
        for (const id of ids) {
          accepted.delete(id);
          for (const key of [...accepted]) {
            if (key.startsWith(`${id}:`)) accepted.delete(key);
          }
        }
        unaccept(entry.taskId, ids);
        for (const o of ch.offenders) {
          const c = entry.result.corrections.find((x) => x.id === o.id);
          if (c) {
            excluded.push({
              taskId: entry.taskId,
              original: c.original,
              corrected: c.corrected,
              word: o.word,
            });
          }
        }
      });

      if (!anyOffenders) {
        // Clean pass: adopt the server's in-place repairs (reverted
        // misspellings, collapsed quote pairs) and its manual-check leftovers.
        res.chapters.forEach((ch, i) => {
          const entry = entries[i];
          for (const w of ch.suspects) unattributed.add(w);
          for (const f of ch.autoFixes ?? []) {
            if (f.kind === "typography") {
              quotesCurled += Number(f.detail) || 0;
              continue;
            }
            autoFixed.add(
              f.kind === "quotes"
                ? `${f.detail} → quote`
                : f.kind === "punctuation"
                  ? `${f.detail} → ${f.detail[0]}`
                  : // spelling reverts and formatting fixes (already "x → y")
                    // render their detail verbatim.
                    f.detail,
            );
          }
          if (typeof ch.fixedAfter === "string") {
            fixedTexts[entry.taskId] = ch.fixedAfter;
          }
        });
        break;
      }
    }
    return {
      excluded,
      autoFixed: [...autoFixed],
      quotesCurled,
      unattributed: [...unattributed],
      fixedTexts,
      checked: true,
    };
  } catch (err) {
    console.warn("[exportVerify] verification failed, exporting unverified:", err);
    return {
      excluded,
      autoFixed: [...autoFixed],
      quotesCurled,
      unattributed: [...unattributed],
      fixedTexts,
      checked: false,
    };
  }
}
