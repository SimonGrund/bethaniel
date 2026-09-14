// ── The model download, with the controls a download should have ──
//
// It used to be a line of text on the Run button: "Downloading Local Betty —
// 88%". When the 88% stopped moving there was nothing to press. This is the
// same download with a bar, a Pause that keeps what has arrived, a Resume
// that picks it back up, and a Cancel that throws it away — and a word for
// the state where the backend has noticed a stall and is reconnecting on
// its own, so a still bar is not mistaken for a dead one.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { formatBytes } from "../modelCopy";
import { cancelModelDownload, pauseModelDownload } from "../api";
import { useStartDownload } from "../useModelRuntime";
import type { DownloadProgress } from "../types";

export default function DownloadBar({ download }: { download: DownloadProgress }) {
  const lang = useStore((s) => s.lang);
  const clearDownload = useStore((s) => s.clearDownload);
  const setDownloadProgress = useStore((s) => s.setDownloadProgress);
  const startDownload = useStartDownload();
  const t = useTranslation(lang);

  const paused = download.status === "paused";
  const stalled = download.status === "stalled";
  const pct = Math.max(0, Math.min(100, download.percent ?? 0));
  const name = download.name ?? "Betty";
  const size =
    download.totalBytes > 0
      ? `${formatBytes(download.bytesDownloaded)} / ${formatBytes(download.totalBytes)}`
      : "";

  const label = paused
    ? t("dl_paused").replace("{name}", name).replace("{percent}", String(pct))
    : stalled
      ? t("dl_reconnecting").replace("{name}", name).replace("{percent}", String(pct))
      : t("run_blocked_downloading").replace("{name}", name).replace("{percent}", String(pct));

  const pause = async () => {
    // Shown as paused at once; the backend confirms with the byte it kept.
    setDownloadProgress({ ...download, status: "paused" });
    await pauseModelDownload(download.modelId).catch(() => {});
  };
  const resume = () => startDownload(download.modelId, download.name);
  const cancel = async () => {
    await cancelModelDownload(download.modelId).catch(() => {});
    clearDownload(download.modelId);
  };

  return (
    <div className={`download-bar${paused ? " download-bar-paused" : ""}${stalled ? " download-bar-stalled" : ""}`}>
      <div className="download-bar-head">
        <span className="download-bar-label">{label}</span>
        {size && <span className="download-bar-size">{size}</span>}
      </div>
      <div className="download-bar-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="download-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="download-bar-actions">
        {paused ? (
          <button type="button" className="btn-secondary btn-small" onClick={resume}>
            {t("dl_resume")}
          </button>
        ) : (
          <button type="button" className="btn-secondary btn-small" onClick={pause}>
            {t("dl_pause")}
          </button>
        )}
        <button type="button" className="btn-secondary btn-small download-bar-cancel" onClick={cancel}>
          {t("model_cancel_download")}
        </button>
      </div>
    </div>
  );
}
