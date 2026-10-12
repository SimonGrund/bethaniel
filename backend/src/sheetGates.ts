// ── The author's style-sheet rules, enforced ──
//
// What the author confirmed on Betty's cards (styleSheetRules.ts) is
// enforced here, by code, on every source of suggestion at once — beside
// gateProtectedTerms and the noise gates in queue.ts. A rule a model was told
// is advice; these are rules.
//
//   casing    — the capital on these words is the author's. A suggestion
//               that only changes it, or that writes one of them into the
//               text where it was not ("bolt" → "Take"), is dropped.
//   dialogue  — speech in a paragraph that names one of these characters is
//               left alone. Approximate on purpose: a paragraph is the unit
//               the book itself uses for a turn of speech, and telling who
//               speaks a line is beyond what code can do reliably.
//   fixes     — the minority spellings the author ticked, applied.
//
// The author's own fixes (house style, ticked spellings) are never dropped by
// these gates — they are the rules.
//
// Pure; tested from backend/test/sheetGates.test.ts.

import type { Correction } from "./types.js";
import type { NoiseGateResult } from "./noiseGates.js";

const WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;
const words = (s: string) => s.match(WORD) ?? [];
const fold = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'");

/** Reasons that are the author's own decisions. */
const AUTHORS = new Set(["house-style", "style-sheet"]);

export function dropCasingChanges(cs: Correction[], terms: string[]): NoiseGateResult {
  if (terms.length === 0) return { kept: cs, dropped: [] };
  const family = new Set(terms.map(fold));
  const capitalised = (ws: string[]) =>
    ws.filter((w) => family.has(fold(w)) && w[0] !== w[0].toLowerCase()).length;
  const kept: Correction[] = [];
  const dropped: NoiseGateResult["dropped"] = [];
  for (const c of cs) {
    if (AUTHORS.has(c.reason ?? "")) {
      kept.push(c);
      continue;
    }
    const a = words(c.original);
    const b = words(c.corrected);
    const recased =
      a.length === b.length &&
      a.some((x, i) => x !== b[i] && fold(x) === fold(b[i]) && family.has(fold(x)));
    const written = capitalised(b) > capitalised(a);
    if (recased || written) {
      dropped.push({
        correction: c,
        why: recased
          ? "left alone: your style sheet says the capital on this word is yours"
          : "left alone: it would write one of your style sheet's words into the text",
      });
    } else kept.push(c);
  }
  return { kept, dropped };
}

/** Is `pos` inside quoted speech, within this paragraph? */
function inSpeech(paragraph: string, pos: number): boolean {
  let open = false;
  for (let i = 0; i < pos && i < paragraph.length; i++) {
    const ch = paragraph[i];
    if (ch === "“" || ch === "«" || ch === "„") open = true;
    else if (ch === "”" || ch === "»") open = false;
    else if (ch === '"') open = !open;
  }
  return open;
}

export function dropDialogueEdits(cs: Correction[], text: string, speakers: string[]): NoiseGateResult {
  if (speakers.length === 0) return { kept: cs, dropped: [] };
  const named = speakers.map(
    (n) =>
      new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u"),
  );
  const kept: Correction[] = [];
  const dropped: NoiseGateResult["dropped"] = [];
  for (const c of cs) {
    const at = AUTHORS.has(c.reason ?? "") ? -1 : text.indexOf(c.original);
    if (at < 0) {
      kept.push(c);
      continue;
    }
    const start = text.lastIndexOf("\n", at) + 1;
    const nl = text.indexOf("\n", at);
    const paragraph = text.slice(start, nl < 0 ? text.length : nl);
    // The speech itself, not the narration around it: the change must
    // start inside quotes.
    if (named.some((re) => re.test(paragraph)) && inSpeech(paragraph, at - start + 1)) {
      dropped.push({
        correction: c,
        why: "left alone: your style sheet says this character's speech is as intended",
      });
    } else kept.push(c);
  }
  return { kept, dropped };
}

/** The minority spellings the author ticked, as corrections for this text. */
export function sheetFixCorrections(
  text: string,
  fixes: { original: string; corrected: string }[],
): Correction[] {
  return fixes
    .filter((f) => f.original && f.original !== f.corrected && text.includes(f.original))
    .map(
      (f) =>
        ({
          original: f.original,
          corrected: f.corrected,
          reason: "style-sheet",
          kind: "copy",
          preApproved: true,
        }) as Correction,
    );
}
