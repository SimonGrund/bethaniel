// ── UpdateStrip — "a new Bethaniel is on its way" ──
//
// Replaces the native dialog that used to fire on update-downloaded. That
// dialog interrupted, and its "Restart now" called quitAndInstall() — which
// kills a running job, possibly a paid cloud one, while saying nothing about
// it. This says the same things without interrupting, and withholds the button
// entirely while tasks are running.
//
// Modelled on ModelDownloadStrip, which solves the same problem for models.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { bannerFor, isQueueBusy } from "../updateStatus";
import { getUpdateBridge } from "../updateBridge";

export default function UpdateStrip() {
  const lang = useStore((s) => s.lang);
  const status = useStore((s) => s.updateStatus);
  const tasks = useStore((s) => s.tasks);
  const t = useTranslation(lang);

  const busy = isQueueBusy(Object.values(tasks).map((x) => x.status));
  const view = bannerFor(status, busy);
  if (!view) return null;

  const text = t(view.key)
    .replace("{v}", view.version ?? "")
    .replace("{p}", String(view.percent ?? 0));

  return (
    <div className="update-strip" role="status">
      <span className="update-strip-label">{text}</span>
      {view.percent != null && (
        <span className="update-strip-bar">
          <span
            className="update-strip-fill"
            style={{ width: `${view.percent}%` }}
          />
        </span>
      )}
      {view.showRestart && (
        <button
          type="button"
          className="btn-small update-strip-restart"
          onClick={() => void getUpdateBridge()?.restartToUpdate()}
        >
          {t("update_restart")}
        </button>
      )}
    </div>
  );
}
