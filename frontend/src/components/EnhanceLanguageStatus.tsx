// ── The enhanced analysis, while it runs or when it stopped short ──
//
// The enhanced analysis is bought where every run is bought — the launch
// row, as "Run in Cloud" on the language card. The report only has to say
// how that run is doing: a line in the toolbar while passages are being
// read, and a retry if it did not finish. When it has, the report itself
// carries the result and this renders nothing.

import { useTranslation } from "../i18n";
import type { Lang, TaskState } from "../types";

export default function EnhanceLanguageStatus({
  task,
  lang,
  onRetry,
}: {
  task?: TaskState;
  lang: Lang;
  onRetry: (taskId: string) => void;
}) {
  const t = useTranslation(lang);
  if (!task) return null;
  if (task.status === "queued" || task.status === "editing") {
    const pct = Math.round((task.progress ?? 0) * 100);
    return (
      <span className="la-enhance-status" role="status">
        <span className="step-card-spinner" aria-hidden="true" />
        {t("la_enhance_running")}
        {task.phase ? ` · ${task.phase}` : ""}
        {pct > 0 ? ` · ${pct}%` : ""}
      </span>
    );
  }
  if (task.status === "error" || task.status === "cancelled") {
    return (
      <span className="la-enhance-status la-enhance-failed" role="status">
        {t("la_enhance_failed")}{" "}
        <button type="button" className="link-button" onClick={() => onRetry(task.id)}>
          ↻ {t("retry")}
        </button>
      </span>
    );
  }
  return null;
}
