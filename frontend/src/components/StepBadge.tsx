// ── The order of events ──
//
// Three blocks on the setup page — the manuscript, the task, the run — and
// nothing on them said which to do first. Side by side and both open, the two
// columns read as a choice between two things rather than two halves of one
// sequence; the run row below them is the conclusion of both.
//
// A numbered seal on the top-left corner of each, straddling its edge the way
// a tab straddles the edge of a page, says it without adding a line of prose
// to any of the three.

import { useStore } from "../store";
import { useTranslation } from "../i18n";

export default function StepBadge({ n }: { n: number }) {
  const lang = useStore((s) => s.lang);
  const t = useTranslation(lang);

  return (
    <span className="step-badge">
      <span className="step-badge-word">{t("step_word")}</span>
      <span className="step-badge-n">{n}</span>
    </span>
  );
}
