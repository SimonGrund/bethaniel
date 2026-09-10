// ── ModelIntroModal — everything Betty needs before the first run ──
//
// The model step is hidden for most users, so nobody is ever going to go
// looking for a model. Instead the app volunteers one at the moment it first
// becomes relevant — the Run click, where the reason for the download is on
// screen and the user has already decided what they want done.
//
// It covers the grammar layer too. LanguageTool used to ask for itself, on
// launch, in a dialog of its own; on a build shipping neither, that meant one
// download demanded before the user had done anything and a second one later.
// Two asks at two moments read as an app that keeps wanting things. One ask,
// listing what is missing and what each part is for, reads as a setup step.
//
// The downloads run in the background — the user carries on choosing tasks and
// a style guide while they land.

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { useStartDownload } from "../useModelRuntime";
import { downloadLanguageTool } from "../api";
import { formatBytes, hardwareReason } from "../modelCopy";
import Modal from "./Modal";

const LT_DISMISS_KEY = "languagetool-missing";

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
  const installed = useStore((s) => s.installed);
  const languageToolAvailable = useStore((s) => s.languageToolAvailable);
  const setLanguageToolDownload = useStore((s) => s.setLanguageToolDownload);
  const dismissAdvice = useStore((s) => s.dismissAdvice);
  const dismissedAdvice = useStore((s) => s.dismissedAdvice);
  const t = useTranslation(lang);
  const startDownload = useStartDownload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!recommendation) return null;

  // What this machine is actually missing. Either can be false — a user may
  // have a model but no grammar layer, or the reverse.
  const needsModel = installed.length === 0;
  const needsGrammar =
    languageToolAvailable === false && !dismissedAdvice.includes(LT_DISMISS_KEY);
  if (!needsModel && !needsGrammar) return null;

  const close = () => {
    setOpen(false);
    setHasSeenModelIntro(true);
  };

  const accept = async () => {
    setBusy(true);
    setError(null);

    // Grammar first and without blocking: it is the smaller download, it has
    // no follow-up popup of its own, and a failure there must not cost the
    // user the model.
    if (needsGrammar) {
      setLanguageToolDownload({ status: "starting" });
      try {
        const res = await downloadLanguageTool();
        if (res.status === "already_installed") {
          setLanguageToolDownload({ status: "done" });
        }
        // Otherwise the `languagetool:download` socket event (wired in App)
        // drives it from here on.
      } catch (err) {
        setLanguageToolDownload({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (needsModel) {
      // The download endpoint keys off the catalog id, not the GGUF file name.
      const res = await startDownload(
        recommendation.modelId,
        recommendation.name,
      );
      setBusy(false);
      if (!res.ok) {
        // Stay open and say what went wrong. Closing on failure would leave
        // the user with a greyed Run button and no idea why.
        setError(res.error);
        return;
      }
      // Select it now so the Run button and sidebar have something concrete to
      // refer to while the bytes are still arriving.
      setModel(recommendation.fileName);
      // Only arm the completion popup if bytes are actually going to move.
      // When the file was already on disk no socket event will ever arrive,
      // and a stuck flag would misfire on some unrelated download later.
      if (res.alreadyInstalled) setModelReadyOpen(true);
      else setAwaitingFirstModel(true);
    } else {
      setBusy(false);
    }
    close();
  };

  const notNow = () => {
    // Declining declines the grammar layer too, so it does not come back on
    // its own later — that resurrects the second interruption this replaced.
    if (needsGrammar) dismissAdvice(LT_DISMISS_KEY);
    close();
  };

  const chooseInstead = () => {
    close();
    setAdvancedMode(true);
    setWizardStep("model");
  };

  const both = needsModel && needsGrammar;

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : notNow}
      labelledBy="model-intro-title"
      className="model-intro-dialog"
    >
      <h2 id="model-intro-title" className="model-intro-title">
        {both
          ? t("setup_needs_title", "Two things before Betty can start")
          : needsModel
            ? t("model_intro_title")
            : t("languagetool_advice_title")}
      </h2>

      {needsModel && (
        <div className="setup-need">
          <p className="setup-need-head">
            <strong>{recommendation.name}</strong>
            <span className="setup-need-size">
              {formatBytes(recommendation.sizeBytes)}
            </span>
          </p>
          <p className="model-confirm-text">{hardwareReason(recommendation, t)}</p>
        </div>
      )}

      {needsGrammar && (
        <div className="setup-need">
          <p className="setup-need-head">
            <strong>{t("setup_need_grammar", "Grammar checks")}</strong>
            <span className="setup-need-size">150–250 MB</span>
          </p>
          <p className="model-confirm-text">{t("languagetool_advice_body")}</p>
        </div>
      )}

      <p className="model-confirm-text setup-need-reassure">
        {t(
          "setup_needs_reassure",
          "Downloaded once, kept on your computer, and used offline from then on. Nothing about your writing is sent anywhere.",
        )}
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
            : both
              ? t("setup_needs_download_both", "Download both and continue")
              : needsModel
                ? t("model_intro_download")
                    .replace("{name}", recommendation.name)
                    .replace("{size}", formatBytes(recommendation.sizeBytes))
                : t("languagetool_advice_download")}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={needsModel ? chooseInstead : notNow}
          disabled={busy}
        >
          {needsModel
            ? t("model_intro_choose")
            : t("languagetool_advice_not_now")}
        </button>
      </div>

      {/* The one place a default-mode user learns the header button exists. */}
      <p className="model-intro-footnote">{t("model_intro_footnote")}</p>
    </Modal>
  );
}
