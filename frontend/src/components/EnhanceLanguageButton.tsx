// ── "Run enhanced analysis in the cloud" ──
//
// The language report is counted on the author's machine and costs nothing.
// This button sells the one thing a count cannot do — notes on showing and
// telling, and a paragraph of advice — as a small cloud run that folds its
// result into the report already on screen. It sits in the report's toolbar
// beside Export, and carries the whole purchase: price, what is bought, what
// leaves the machine, payment, and the run itself.

import { useEffect, useState } from "react";
import CloudCheckoutModal from "./CloudCheckoutModal";
import CloudCodeClaim from "./CloudCodeClaim";
import { useTranslation } from "../i18n";
import { spawnLanguageEnhance } from "../api";
import { useCloudPurchase } from "../cloudPurchase";
import { refreshModelEnvironment } from "../useModelRuntime";
import type { Lang, TaskState } from "../types";

export default function EnhanceLanguageButton({
  jobId,
  wordCount,
  manuscriptLang,
  lang,
  task,
  onRetry,
}: {
  jobId: string;
  /** Words in the analysis — the sample size, and so the price, follow it. */
  wordCount: number;
  manuscriptLang?: string;
  lang: Lang;
  /** The enhance task on this job, once one exists. */
  task?: TaskState;
  onRetry: (taskId: string) => void;
}) {
  const t = useTranslation(lang);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  const {
    estimate,
    estimateError,
    requestEstimate,
    pending,
    claimError,
    startCheckout,
    claimCode,
    cancelWait,
  } = useCloudPurchase(`enhance:${jobId}`, async () => {
    // The credential is saved; the run it paid for starts now, on the cloud
    // model, without touching the model the author picked for their edits.
    await refreshModelEnvironment();
    try {
      await spawnLanguageEnhance(jobId, "custom:bethaniel-cloud");
      setSpawnError(null);
    } catch (err) {
      setSpawnError(
        err instanceof Error ? err.message : "Could not start the enhanced analysis",
      );
    }
  });

  // A price as soon as the button exists, so it can say what it costs. A
  // finished run has no button, so nothing is priced for it.
  const settled = task?.status === "done";
  useEffect(() => {
    if (settled || wordCount <= 0) return;
    void requestEstimate({
      units: [{ wordCount }],
      modes: ["language_enhance"],
      wordsPerChunk: 2500,
      runMode: "speed",
      reviewMode: false,
      styleComplianceAgent: false,
      extraPass: false,
      manuscriptLang,
    });
  }, [jobId, wordCount, manuscriptLang, settled, requestEstimate]);

  if (settled) return null;

  // Running, or stopped short: the toolbar says so, in the button's place.
  if (task && (task.status === "queued" || task.status === "editing")) {
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
  if (task && (task.status === "error" || task.status === "cancelled")) {
    return (
      <span className="la-enhance-status la-enhance-failed" role="status">
        {t("la_enhance_failed")}{" "}
        <button type="button" className="link-button" onClick={() => onRetry(task.id)}>
          ↻ {t("retry")}
        </button>
      </span>
    );
  }

  const price =
    estimate === null
      ? null
      : estimate.priceCents === 0
        ? t("cloud_free", "Free")
        : `€${(estimate.priceCents / 100).toFixed(2)}`;

  return (
    <div className="la-enhance">
      <div className="la-enhance-row">
        <button
          type="button"
          className="btn-secondary btn-small la-enhance-cta"
          disabled={!estimate || pending}
          onClick={() => {
            setSpawnError(null);
            setConfirmOpen(true);
          }}
        >
          {pending ? t("cloud_waiting_payment") : t("la_enhance_cta")}
          {price && !pending && <span className="la-enhance-price">{price}</span>}
        </button>
        {estimateError && !estimate && (
          <span className="la-enhance-status la-enhance-failed">
            {t("cloud_estimate_error")}
          </span>
        )}
      </div>

      {/* What is bought and what leaves the machine, one toggle away. The
          modal repeats the privacy line before payment; this is for the
          author deciding whether to open it at all. */}
      <details className="la-enhance-info">
        <summary>{t("la_enhance_info")}</summary>
        <ul>
          <li>{t("la_enhance_get_1")}</li>
          <li>{t("la_enhance_get_2")}</li>
          <li>{t("la_enhance_get_3")}</li>
        </ul>
        <p>{t("la_enhance_privacy")}</p>
      </details>

      {pending && (
        <p className="cloud-wait-note">
          {t("cloud_wait_hint")}{" "}
          <button type="button" className="link-button" onClick={cancelWait}>
            {t("cloud_wait_cancel")}
          </button>
        </p>
      )}
      <CloudCodeClaim pending={pending} onClaim={claimCode} lang={lang} />
      {(claimError || spawnError) && (
        <div className="api-error">{claimError ?? spawnError}</div>
      )}

      <CloudCheckoutModal
        open={confirmOpen}
        estimate={estimate}
        chapters={0}
        modes={["language_enhance"]}
        title={t("la_enhance_buy_title")}
        privacyNote={t("la_enhance_privacy")}
        keepOpenNote={t("la_enhance_keep_open")}
        lang={lang}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          if (!estimate) return;
          setConfirmOpen(false);
          void startCheckout(estimate.quoteId);
        }}
      />
    </div>
  );
}
