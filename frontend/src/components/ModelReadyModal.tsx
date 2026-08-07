// ── ModelReadyModal — "Betty is ready" ──
//
// Closes the loop opened by ModelIntroModal. Only fires for the download that
// popup started (App gates it on `awaitingFirstModel`), so a power user pulling
// a second model in the selector is never interrupted.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import Modal from "./Modal";

export default function ModelReadyModal() {
  const lang = useStore((s) => s.lang);
  const open = useStore((s) => s.modelReadyOpen);
  const setOpen = useStore((s) => s.setModelReadyOpen);
  const model = useStore((s) => s.model);
  const installed = useStore((s) => s.installed);
  const t = useTranslation(lang);

  const name = installed.find((m) => m.fileName === model)?.name ?? "Betty";

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      labelledBy="model-ready-title"
    >
      <h2 id="model-ready-title" className="model-intro-title">
        {t("model_ready_title").replace("{name}", name)}
      </h2>
      <p className="model-confirm-text">{t("model_ready_body")}</p>
      <div className="model-confirm-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => setOpen(false)}
        >
          {t("model_ready_ok")}
        </button>
      </div>
    </Modal>
  );
}
