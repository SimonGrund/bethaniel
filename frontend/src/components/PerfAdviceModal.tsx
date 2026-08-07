// ── PerfAdviceModal — what the measurements say ──
//
// The hardware table is a guess. Once a job has run, the backend knows the real
// decode rate on this machine and says so. Two things it can say:
//
//   downgrade — a smaller Betty would serve you better; here's the offer.
//   slow      — nothing smaller exists. Here's honestly how long this takes,
//               and what to do about it.
//
// The "slow" branch deliberately does not mention External Betty. Bethaniel's
// promise is that manuscripts never leave the machine, and a slow afternoon is
// not a reason to walk that back.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { useStartDownload } from "../useModelRuntime";
import { estimateRuntime, formatBytes, formatWordRate } from "../modelCopy";
import Modal from "./Modal";

export default function PerfAdviceModal() {
  const lang = useStore((s) => s.lang);
  const advice = useStore((s) => s.perfAdvice);
  const dismissAdvice = useStore((s) => s.dismissAdvice);
  const setPerfAdvice = useStore((s) => s.setPerfAdvice);
  const setModel = useStore((s) => s.setModel);
  const doc = useStore((s) => s.document);
  const installed = useStore((s) => s.installed);
  const t = useTranslation(lang);
  const startDownload = useStartDownload();

  if (!advice) return null;

  // Only quote a speed when we have a real words/second measurement; the raw
  // token rate is not the same number and must not be labelled as words.
  const rate = formatWordRate(advice, t);

  const key = `${advice.from}:${advice.kind}`;
  const alreadyInstalled = installed.some(
    (m) => m.fileName === advice.recommendedFileName,
  );

  const switchModel = async () => {
    setModel(advice.recommendedFileName);
    // Dismiss rather than merely close: having acted on the advice, the user
    // should not be asked again.
    dismissAdvice(key);
    if (!alreadyInstalled) {
      await startDownload(advice.recommendedModelId, advice.recommendedName);
    }
  };

  if (advice.kind === "downgrade") {
    return (
      <Modal
        open
        onClose={() => setPerfAdvice(null)}
        labelledBy="perf-advice-title"
      >
        <h2 id="perf-advice-title" className="model-intro-title">
          {t("perf_advice_slow_title")}
        </h2>
        <p className="model-confirm-text">
          {(rate
            ? t("perf_advice_downgrade_body").replace("{rate}", rate)
            : t("perf_advice_downgrade_body_norate")
          ).replace("{name}", advice.recommendedName)}
        </p>
        <div className="model-intro-actions">
          <button type="button" className="btn-primary" onClick={switchModel}>
            {alreadyInstalled
              ? t("perf_advice_switch").replace("{name}", advice.recommendedName)
              : t("perf_advice_download")
                  .replace("{name}", advice.recommendedName)
                  .replace("{size}", formatBytes(advice.recommendedSizeBytes))}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => dismissAdvice(key)}
          >
            {t("perf_advice_keep_going")}
          </button>
        </div>
      </Modal>
    );
  }

  // "slow": no smaller model to fall back to. Give a real number and practical
  // advice instead of an apology.
  const eta = estimateRuntime(advice, doc?.wordCount ?? 0, t);
  return (
    <Modal open onClose={() => dismissAdvice(key)} labelledBy="perf-advice-title">
      <h2 id="perf-advice-title" className="model-intro-title">
        {t("perf_advice_slow_title")}
      </h2>
      <p className="model-confirm-text">
        {rate
          ? t("perf_advice_slow_body").replace("{rate}", rate)
          : t("perf_advice_slow_body_norate")}
        {eta && (
          <>
            {" "}
            {t("perf_advice_slow_eta")
              .replace("{words}", (doc?.wordCount ?? 0).toLocaleString())
              .replace("{duration}", eta)}
          </>
        )}
      </p>
      <p className="model-confirm-text">{t("perf_advice_slow_tip")}</p>
      <div className="model-confirm-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => dismissAdvice(key)}
        >
          {t("perf_advice_got_it")}
        </button>
      </div>
    </Modal>
  );
}
