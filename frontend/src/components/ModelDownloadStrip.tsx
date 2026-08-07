// ── ModelDownloadStrip — "Betty is on her way" ──
//
// A first-run user accepts the recommended download and then spends several
// minutes configuring tasks and a style guide. Without this the only sign
// anything is happening is a greyed-out Run button, which reads as broken.
//
// Sits directly above Run, next to what it explains.

import { useStore } from "../store";
import { useTranslation } from "../i18n";

export default function ModelDownloadStrip() {
  const lang = useStore((s) => s.lang);
  const downloads = useStore((s) => s.downloads);
  const t = useTranslation(lang);

  const active = Object.values(downloads);
  if (active.length === 0) return null;

  return (
    <div className="model-download-strip">
      {active.map((dl) => (
        <div key={dl.modelId} className="model-download-row">
          <span className="model-download-label">
            {t("downloading_model").replace("{name}", dl.name ?? "Betty")}
            {" · "}
            {dl.percent}%
          </span>
          <span
            className="model-download-bar"
            role="progressbar"
            aria-valuenow={dl.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className="model-download-fill"
              style={{ width: `${dl.percent}%` }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}
