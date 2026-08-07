// ── ModelIntroModal — "Betty needs a brain", shown after the first upload ──
//
// The model step is hidden for most users, so nobody is ever going to go
// looking for a model. Instead the app volunteers one, once, at the moment it
// first becomes relevant: the manuscript is in, and something has to edit it.
//
// The download runs in the background — the user carries on choosing tasks and
// a style guide while it lands.

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { useStartDownload } from "../useModelRuntime";
import { formatBytes, hardwareReason } from "../modelCopy";
import Modal from "./Modal";

export default function ModelIntroModal() {
  const lang = useStore((s) => s.lang);
  const open = useStore((s) => s.modelIntroOpen);
  const setOpen = useStore((s) => s.setModelIntroOpen);
  const setHasSeenModelIntro = useStore((s) => s.setHasSeenModelIntro);
  const setAwaitingFirstModel = useStore((s) => s.setAwaitingFirstModel);
  const setModelReadyOpen = useStore((s) => s.setModelReadyOpen);
  const setAdvancedMode = useStore((s) => s.setAdvancedMode);
  const setWizardStep = useStore((s) => s.setWizardStep);
  const setModel = useStore((s) => s.setModel);
  const recommendation = useStore((s) => s.recommendation);
  const t = useTranslation(lang);
  const startDownload = useStartDownload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!recommendation) return null;

  const close = () => {
    setOpen(false);
    setHasSeenModelIntro(true);
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    // The download endpoint keys off the catalog id, not the GGUF file name.
    const res = await startDownload(recommendation.modelId, recommendation.name);
    setBusy(false);
    if (!res.ok) {
      // Stay open and say what went wrong. Closing on failure would leave the
      // user with a greyed Run button and no idea why.
      setError(res.error);
      return;
    }
    // Select it now so the Run button and sidebar have something concrete to
    // refer to while the bytes are still arriving.
    setModel(recommendation.fileName);
    // Only arm the completion popup if bytes are actually going to move. When
    // the file was already on disk no socket event will ever arrive, and a
    // stuck flag would misfire on some unrelated download later.
    if (res.alreadyInstalled) setModelReadyOpen(true);
    else setAwaitingFirstModel(true);
    close();
  };

  const chooseInstead = () => {
    close();
    setAdvancedMode(true);
    setWizardStep("model");
  };

  return (
    <Modal open={open} onClose={close} labelledBy="model-intro-title" className="model-intro-dialog">
      <h2 id="model-intro-title" className="model-intro-title">
        {t("model_intro_title")}
      </h2>

      <p className="model-confirm-text">
        {hardwareReason(recommendation, t)}
      </p>

      {error && <p className="model-intro-error">{error}</p>}

      <div className="model-intro-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={accept}
          disabled={busy}
        >
          {busy
            ? t("model_intro_starting")
            : t("model_intro_download")
                .replace("{name}", recommendation.name)
                .replace("{size}", formatBytes(recommendation.sizeBytes))}
        </button>
        <button type="button" className="btn-secondary" onClick={chooseInstead}>
          {t("model_intro_choose")}
        </button>
      </div>

      {/* The one place a default-mode user learns the header button exists. */}
      <p className="model-intro-footnote">{t("model_intro_footnote")}</p>
    </Modal>
  );
}
