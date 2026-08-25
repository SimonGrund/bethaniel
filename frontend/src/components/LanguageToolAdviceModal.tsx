// ── LanguageToolAdviceModal — offer to fetch grammar checking ──
//
// LanguageTool (jar + a matching JRE) is normally bundled by the release
// build, but a build can ship without it and the backend degrades silently —
// grammar checks just don't run, with no obvious sign why. Rather than leave
// the user to notice something's missing, App checks on mount and this offers
// to fetch it (a one-time ~150-250MB download, tracked server-side so it
// survives a reload) right from here.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { downloadLanguageTool } from "../api";
import Modal from "./Modal";

const DISMISS_KEY = "languagetool-missing";

export default function LanguageToolAdviceModal() {
  const lang = useStore((s) => s.lang);
  const open = useStore((s) => s.languageToolAdvice);
  const setOpen = useStore((s) => s.setLanguageToolAdvice);
  const download = useStore((s) => s.languageToolDownload);
  const setDownload = useStore((s) => s.setLanguageToolDownload);
  const dismissAdvice = useStore((s) => s.dismissAdvice);
  const t = useTranslation(lang);

  if (!open) return null;

  const notNow = () => {
    setOpen(false);
    dismissAdvice(DISMISS_KEY);
  };

  const startDownload = async () => {
    setDownload({ status: "starting" });
    try {
      const res = await downloadLanguageTool();
      if (res.status === "already_installed") {
        setDownload({ status: "done" });
      }
      // Otherwise the `languagetool:download` socket event (wired in App)
      // drives `download` from here on.
    } catch (err) {
      setDownload({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const busy = download?.status === "starting" || download?.status === "downloading";
  const done = download?.status === "done";

  return (
    <Modal
      open
      onClose={busy ? undefined : notNow}
      labelledBy="languagetool-advice-title"
    >
      <h2 id="languagetool-advice-title" className="model-intro-title">
        {t("languagetool_advice_title")}
      </h2>
      <p className="model-confirm-text">{t("languagetool_advice_body")}</p>

      {done ? (
        <p className="model-confirm-text">{t("languagetool_advice_done")}</p>
      ) : busy ? (
        <div className="model-download-row">
          <span className="model-download-label">
            {t(
              download?.status === "starting"
                ? "languagetool_advice_starting"
                : "languagetool_advice_downloading",
            )}
          </span>
          <span className="model-download-bar" role="progressbar" aria-label={t("languagetool_advice_downloading")}>
            <span className="model-download-fill model-download-fill-indeterminate" />
          </span>
        </div>
      ) : download?.status === "error" ? (
        <p className="model-confirm-text model-confirm-text-error">
          {t("languagetool_advice_error").replace(
            "{error}",
            download.error ?? "",
          )}
        </p>
      ) : null}

      <div className="model-intro-actions">
        {done ? (
          <button type="button" className="btn-primary" onClick={notNow}>
            {t("perf_advice_got_it")}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn-primary"
              onClick={startDownload}
              disabled={busy}
            >
              {t("languagetool_advice_download")}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={notNow}
              disabled={busy}
            >
              {t("languagetool_advice_not_now")}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
