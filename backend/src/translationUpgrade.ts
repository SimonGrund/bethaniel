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

/** Below this draft/source length ratio we assume the chunk was truncated.
 *  Looser than MIN_LENGTH_RATIO: that compares a polish against its own
 *  draft, where the text should barely move, while a translation legitimately
 *  changes length — Danish and German run long, English runs short. This is
 *  only meant to catch a chunk that stopped a paragraph in. */
const MIN_DRAFT_RATIO = 0.4;

/** Short enough that the length ratio says nothing. A heading or a line of
 *  dialogue can halve in translation without anything being wrong. */
const LENGTH_CHECK_MIN_CHARS = 80;

/**
 * The draft translation's own guard, run before the polish pass ever sees it.
 *
 * Until this existed nothing checked the draft: `upgradeGuard` vets the polish
 * against the draft, but the draft itself was taken on trust, and the chunk
 * loop's only failure path pushes the SOURCE text into the output. So a chunk
 * that came back empty produced an empty chapter, and one that came back in
 * the source language produced an untranslated chapter — both on a task that
 * finished "done" with no errors recorded, which is how a book gets downloaded
 * with its first chapter translated and the rest still in English.
 *
 * Deterministic and conservative on purpose: it answers "this is certainly not
 * a translation", never "this is a good one". Judging the quality is the
 * fluency reviewer's job, and judging the language is not something a
 * five-language word-frequency detector should be trusted to veto a paid run
 * over.
 */
export function draftGuard(
  source: string,
  draft: string,
): { ok: true } | { ok: false; reason: string } {
  const d = draft.trim();
  if (!d) return { ok: false, reason: "empty translation output" };

  const normalize = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalize(d) === normalize(source))
    return { ok: false, reason: "untranslated — the source text came back unchanged" };

  const src = source.trim();
  if (src.length >= LENGTH_CHECK_MIN_CHARS && d.length < src.length * MIN_DRAFT_RATIO)
    return {
      ok: false,
      reason: `translation too short (${d.length}/${src.length} chars) — the chunk was probably truncated`,
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
  /** Returns each reviewer's verdicts keyed by paragraph index. The runner
   *  batches internally, so a dense chunk is covered rather than truncated. */
  runReviewer: (
    draftChunk: string,
    pairs: Correction[],
  ) => Promise<Map<number, { confidence: number; reason: string }>>;
  log: (level: "info" | "warn", message: string) => void;
  setPhase: (phase: string) => void;
}

export interface UpgradeOptions {
  draft: string;
  upgradePrompt: string;
  reviewMode: boolean;
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

    // One reviewer. Running N of them issued the same prompt with the same
    // seed at temperature 0, so they could only ever return identical scores.
    const results = await Promise.allSettled([deps.runReviewer(draft, pairs)]);
    const outputs: Map<number, { confidence: number; reason: string }>[] = [];
    for (const r of results)
      if (r.status === "fulfilled" && r.value.size > 0) outputs.push(r.value);

    if (outputs.length === 0) {
      deps.log(
        "warn",
        `No fluency reviewer survived for chunk ${chunkLabel}; accepting polish unreviewed.`,
      );
      return polished;
    }

    const allScores = outputs;
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
