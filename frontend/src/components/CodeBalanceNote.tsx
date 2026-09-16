// ── "2 free runs left on this task, up to 200,000 words" ──
//
// One component for both places it appears: on each task card, and under the
// code box where the code was typed (so a code entered on the run step gives
// feedback there, rather than only lighting up cards the author has walked
// past). Rendering it once keeps the two from drifting apart.
//
// Renders nothing far more often than it renders something — no code, a
// balance that has not arrived, a Worker too old to answer, a code that only
// discounts, a card with nothing left on it. That silence is the design: the
// price beside it is still right, and a code that does not apply is still
// explained by the quote.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { noteFor, BALANCE_CAP_KEY } from "../codeBalanceNote";
import type { FrontCard } from "../types";

export default function CodeBalanceNote({ card }: { card: FrontCard }) {
  const lang = useStore((s) => s.lang);
  const balance = useStore((s) => s.codeBalance);
  const t = useTranslation(lang);

  const note = noteFor(balance, card);
  if (!note) return null;

  const runs = t(note.key).replace("{n}", String(note.runs));
  const cap =
    note.maxWords != null
      ? t(BALANCE_CAP_KEY).replace("{words}", note.maxWords.toLocaleString())
      : "";

  return (
    <span className="cloud-code-runs">
      🎟 {runs}
      {cap}
    </span>
  );
}
