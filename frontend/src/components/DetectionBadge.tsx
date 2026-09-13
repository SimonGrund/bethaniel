// ── The "Betty read this from your book" marker ──
//
// Sits beside a setting the manuscript answered for itself. Two states, and
// the second one matters as much as the first:
//
//   detected — the manuscript was clear, and the control has been set to match.
//   unsure   — Betty looked and could not tell. The control is left at its
//              existing value and the badge asks the author to decide, which
//              is the only honest thing to do when both answers are defensible.
//
// The detected badge disappears the moment the author changes the control,
// because it is then no longer describing what Betty found. That needs no
// "user touched this" bookkeeping: the badge is shown exactly while the
// current value still equals the detected one.

import type { Detection, Lang } from "../types";
import { useTranslation } from "../i18n";

interface Props {
  /** Absent when the question does not apply to this manuscript at all. */
  detection?: Detection<unknown>;
  /** The control's current value, so an overridden setting drops its badge. */
  current: unknown;
  lang: Lang;
}

function fill(template: string, counts: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in counts ? String(counts[key]) : whole,
  );
}

export default function DetectionBadge({ detection, current, lang }: Props) {
  const t = useTranslation(lang);
  if (!detection) return null;

  const counts = {
    support: detection.support,
    against: detection.against,
    sample: detection.sample,
  };

  if (detection.status === "unsure") {
    // No examples at all reads very differently from "your book does both",
    // and an author can act on the second one.
    const tip =
      detection.sample === 0
        ? t("detect_tip_none")
        : fill(t("detect_tip_mixed"), counts);
    return (
      <span className="detect-badge detect-badge-unsure" title={tip}>
        {t("detect_badge_unsure")}
      </span>
    );
  }

  // Overridden by hand — Betty's reading is no longer what the control says.
  if (detection.value !== current) return null;

  return (
    <span
      className="detect-badge detect-badge-found"
      title={fill(t("detect_tip_detected"), counts)}
    >
      {t("detect_badge_detected")}
    </span>
  );
}
