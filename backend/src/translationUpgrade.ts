// ── Translation upgrade stage ──
// Monolingual target-language polish of an accuracy-validated draft
// translation, plus a fluency review that re-polishes flagged paragraphs.
// No imports from llm.ts/db.ts/queue.ts — model calls, logging, and phase
// updates are injected by the caller so the stage is unit-testable.

import type { Correction } from "./types.js";

export function splitIntoParas(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Below this polished/draft length ratio we assume the model ate content. */
const MIN_LENGTH_RATIO = 0.6;

export function upgradeGuard(
  draft: string,
  polished: string,
): { ok: true } | { ok: false; reason: string } {
  if (!polished.trim()) return { ok: false, reason: "empty upgrade output" };
  const d = splitIntoParas(draft);
  const p = splitIntoParas(polished);
  if (d.length !== p.length)
    return {
      ok: false,
      reason: `paragraph count changed (${d.length} → ${p.length})`,
    };
  if (polished.length < draft.length * MIN_LENGTH_RATIO)
    return {
      ok: false,
      reason: `output too short (${polished.length}/${draft.length} chars)`,
    };
  return { ok: true };
}

export interface FluencyScore {
  confidence: number;
  reason: string;
}

export interface UpgradeDeps {
  /** Accumulate a full completion for `text` under `systemPrompt`. */
  editStream: (text: string, systemPrompt: string) => Promise<string>;
  /** Run one fluency-reviewer agent; resolves to its raw JSONL output. */
  runReviewer: (draftChunk: string, pairs: Correction[]) => Promise<string>;
  parseScores: (raw: string) => Map<number, FluencyScore>;
  log: (level: "info" | "warn", message: string) => void;
  setPhase: (phase: string) => void;
}

export interface UpgradeOptions {
  draft: string;
  upgradePrompt: string;
  reviewMode: boolean;
  reviewerCount: number;
  reviewerThreshold: number;
  chunkLabel: string;
  signal: AbortSignal;
}

/**
 * Stages 3–4 of the translate pipeline: polish the accuracy-validated draft
 * in the target language, then (reviewMode) score each draft↔polished
 * paragraph pair and re-polish flagged paragraphs once from the draft.
 * The draft is the fallback at every level: guard rejection, upgrade
 * failure, or a failed re-polish never produce anything worse than the
 * input. Abort always re-throws so the chunk-level handler sees it.
 */
export async function runTranslationUpgrade(
  opts: UpgradeOptions,
  deps: UpgradeDeps,
): Promise<string> {
  const { draft, chunkLabel } = opts;
  try {
    deps.setPhase(`upgrading chunk ${chunkLabel}`);
    const polished = (await deps.editStream(draft, opts.upgradePrompt)).trim();

    const guard = upgradeGuard(draft, polished);
    if (!guard.ok) {
      deps.log(
        "warn",
        `Upgrade of chunk ${chunkLabel} rejected: ${guard.reason}. Keeping draft.`,
      );
      return draft;
    }

    if (!opts.reviewMode) return polished;

    const draftParas = splitIntoParas(draft);
    const polishedParas = splitIntoParas(polished);
    const n = draftParas.length; // == polishedParas.length (guard passed)

    deps.setPhase(`reviewing fluency for chunk ${chunkLabel}`);
    const pairs: Correction[] = draftParas.map((d, i) => ({
      original: d,
      corrected: polishedParas[i],
    }));

    const results = await Promise.allSettled(
      Array.from({ length: opts.reviewerCount }, () =>
        deps.runReviewer(draft, pairs),
      ),
    );
    const outputs: string[] = [];
    for (const r of results)
      if (r.status === "fulfilled" && r.value) outputs.push(r.value);

    if (outputs.length === 0) {
      deps.log(
        "warn",
        `No fluency reviewer survived for chunk ${chunkLabel}; accepting polish unreviewed.`,
      );
      return polished;
    }
    if (outputs.length < opts.reviewerCount)
      deps.log(
        "warn",
        `Only ${outputs.length}/${opts.reviewerCount} fluency reviewers contributed for chunk ${chunkLabel}; scoring on survivors.`,
      );

    const allScores = outputs.map((o) => deps.parseScores(o));
    const flagged: { idx: number; conf: number; reason: string }[] = [];
    for (let i = 0; i < n; i++) {
      let minConf = 5;
      let minReason = "";
      for (const scores of allScores) {
        const s = scores.get(i);
        if (s && s.confidence < minConf) {
          minConf = s.confidence;
          minReason = s.reason;
        }
      }
      if (minConf < opts.reviewerThreshold)
        flagged.push({ idx: i, conf: minConf, reason: minReason });
    }

    if (flagged.length === 0) {
      deps.log(
        "info",
        `Fluency reviewer passed all ${n} paragraphs in chunk ${chunkLabel}.`,
      );
      return polished;
    }

    deps.log(
      "info",
      `Fluency reviewer flagged ${flagged.length}/${n} paragraphs in chunk ${chunkLabel}. Re-polishing…`,
    );
    const revised = [...polishedParas];
    for (const f of flagged) {
      try {
        const rePrompt =
          opts.upgradePrompt +
          `\n\nCRITICAL: Your previous edit of this paragraph was flagged: "${f.reason}". Rewrite it so it reads naturally while preserving the meaning exactly.`;
        const rePolished = (
          await deps.editStream(draftParas[f.idx], rePrompt)
        ).trim();
        if (rePolished) {
          revised[f.idx] = rePolished;
          deps.log(
            "info",
            `Re-polished paragraph ${f.idx + 1}/${n} (was confidence ${f.conf}).`,
          );
        } else {
          revised[f.idx] = draftParas[f.idx];
          deps.log(
            "warn",
            `Re-polish of paragraph ${f.idx + 1} came back empty; keeping draft paragraph.`,
          );
        }
      } catch (err) {
        if (opts.signal.aborted) throw err;
        revised[f.idx] = draftParas[f.idx];
        deps.log(
          "warn",
          `Re-polish of paragraph ${f.idx + 1} failed: ${err instanceof Error ? err.message : String(err)}. Keeping draft paragraph.`,
        );
      }
    }
    return revised.join("\n\n");
  } catch (err) {
    if (opts.signal.aborted) throw err;
    deps.log(
      "warn",
      `Translation upgrade failed for chunk ${chunkLabel}: ${err instanceof Error ? err.message : String(err)}. Keeping draft.`,
    );
    return draft;
  }
}
