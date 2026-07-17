// ── Translation upgrade stage ──
// Monolingual target-language polish of an accuracy-validated draft
// translation, plus a fluency review that re-polishes flagged paragraphs.
// No imports from llm.ts/db.ts/queue.ts — model calls, logging, and phase
// updates are injected by the caller so the stage is unit-testable.

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
