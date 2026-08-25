// ── Edit trigger — wizard step 5: Run ──

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import {
  addToQueue,
  getCloudEstimate,
  createCloudCheckout,
  type CloudEstimateResponse,
} from "../api";
import { buildUnits } from "./ScopeSelection";
import { refreshModelEnvironment } from "../useModelRuntime";

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Bridge to the Electron main process — undefined outside the desktop app
 *  (e.g. a browser preview), in which case the cloud button is hidden. */
function getElectronBridge(): {
  openCloudCheckout: (url: string) => Promise<void>;
  onCloudCredentialClaimed: (
    listener: (result: { ok: boolean; error?: string }) => void,
  ) => () => void;
} | null {
  const win = window as unknown as {
    bethaniel?: {
      openCloudCheckout?: (url: string) => Promise<void>;
      onCloudCredentialClaimed?: (
        listener: (result: { ok: boolean; error?: string }) => void,
      ) => () => void;
    };
  };
  if (win.bethaniel?.openCloudCheckout && win.bethaniel?.onCloudCredentialClaimed) {
    return {
      openCloudCheckout: win.bethaniel.openCloudCheckout,
      onCloudCredentialClaimed: win.bethaniel.onCloudCredentialClaimed,
    };
  }
  return null;
}

export default function EditTrigger() {
  const {
    lang,
    document: doc,
    documentMd,
    scopeMode,
    selectedChapters,
    firstNWords,
    model,
    selectedModes,
    copyEditOptions,
    lineEditOptions,
    targetLang,
    manuscriptLang,
    reviewMode,
    reviewerThreshold,
    reviewerCount,
    spellCheck,
    retextCheck,
    grammarCheck,
    dualEditor,
    dualCount,
    characterDedup,
    styleComplianceAgent,
    extraPass,
    runMode,
    wordsPerChunk,
    overlapParagraphs,
    parallel,
    styleGuide,
    submitting,
    setSubmitting,
    tasks,
    setWizardStep,
    markStepComplete,
    completedSteps,
    sessionStartedAt,
    setSessionStartedAt,
    installed,
    downloads,
    modelEnvLoaded,
  } = useStore();
  const t = useTranslation(lang);

  const isWorking = Object.values(tasks).some(
    (task) => task.status === "queued" || task.status === "editing",
  );

  // A run belongs to the current session once at least one of its tasks was
  // submitted after the session boundary. "New run" bumps that boundary so the
  // prior run drops into Former Runs.
  const hasCurrentRun = Object.values(tasks).some(
    (task) => (task.submittedAt ?? 0) >= sessionStartedAt,
  );

  const units = doc
    ? buildUnits(
        documentMd,
        doc.chapters,
        scopeMode,
        selectedChapters,
        firstNWords,
      )
    : [];
  // ── Is Betty actually available to run? ──
  // With the model step hidden, the selected model may be one the app picked
  // and started downloading a moment ago. Launching then would fail deep in the
  // engine, so the button waits instead — and says what it is waiting for.
  const activeDownload = Object.values(downloads)[0];
  const isApiModel =
    model.startsWith("custom:") && !model.startsWith("custom:gguf");
  const isCustomGguf = model.startsWith("custom:gguf");
  // API and custom-GGUF models are configured, not downloaded; the selector
  // won't let you select them without a key or a path, so they are never gated.
  // Wait for the first environment fetch: an empty `installed` list before it
  // lands is "we don't know yet", not "nothing is installed", and gating on it
  // would flash a false warning on every page load.
  const modelPending =
    modelEnvLoaded &&
    !!model &&
    !isApiModel &&
    !isCustomGguf &&
    !installed.some((m) => m.fileName === model);

  // Until the first environment fetch lands we do not know what is installed,
  // so hold the button rather than let it through. Returning null here left a
  // window on startup where nothing gated the run at all: clicking inside it
  // submitted a job against a model that was still downloading, which failed
  // deep in the engine with "Model file not found". "Preparing" is honest about
  // the state and avoids the false "not installed" warning that gating on an
  // empty `installed` list would flash.
  const notReadyReason = !modelEnvLoaded
    ? t("run_blocked_preparing")
    : !model
    ? t("run_blocked_no_model")
    : activeDownload
      ? t("run_blocked_downloading")
          .replace("{name}", activeDownload.name ?? "Betty")
          .replace("{percent}", String(activeDownload.percent))
      : modelPending
        ? t("run_blocked_preparing")
        : isApiModel && !installed.some((m) => m.fileName === model)
          ? t("run_blocked_no_api_key")
          : null;

  const disabled =
    !doc ||
    units.length === 0 ||
    selectedModes.length === 0 ||
    submitting ||
    notReadyReason !== null;

  // ── Betty in the Cloud: pre-run estimate + pay-to-run ──

  const [cloudEstimate, setCloudEstimate] = useState<CloudEstimateResponse | null>(
    null,
  );
  const [cloudEstimateError, setCloudEstimateError] = useState<string | null>(null);
  const [cloudCheckoutPending, setCloudCheckoutPending] = useState(false);
  const [cloudClaimError, setCloudClaimError] = useState<string | null>(null);
  const estimateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Looked up once — the bridge itself never changes across a session, and a
  // stable reference lets the credential-claimed subscription below mount
  // exactly once instead of resubscribing on every render.
  const [electronBridge] = useState(() => getElectronBridge());
  // Always resolves to the current render's handleClick, so the credential
  // handler (subscribed once, fired much later after payment) submits with
  // up-to-date doc/units/settings instead of whatever they were on mount.
  const handleClickRef = useRef<() => Promise<void>>(async () => {});

  // Refetch whenever anything that changes the job's shape changes. `units`
  // is recomputed fresh every render, so its content (not identity) drives
  // the dependency list via the chapter-selection/scope inputs it's built
  // from — same inputs the run button's own chapter count already uses.
  useEffect(() => {
    if (estimateDebounceRef.current) clearTimeout(estimateDebounceRef.current);
    if (!doc || units.length === 0 || selectedModes.length === 0) {
      setCloudEstimate(null);
      return;
    }
    estimateDebounceRef.current = setTimeout(() => {
      getCloudEstimate({
        units: units.map((u) => ({ wordCount: countWords(u.original) })),
        modes: selectedModes,
        wordsPerChunk,
        runMode,
        reviewMode,
        reviewerCount,
        dualEditor,
        dualCount,
        styleComplianceAgent,
        extraPass,
        styleGuide: styleGuide || undefined,
        manuscriptLang,
      })
        .then((est) => {
          setCloudEstimate(est);
          setCloudEstimateError(null);
        })
        .catch((err) => {
          setCloudEstimate(null);
          setCloudEstimateError(
            err instanceof Error ? err.message : "Could not price this job",
          );
        });
    }, 500);
    return () => {
      if (estimateDebounceRef.current) clearTimeout(estimateDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    doc?.id,
    scopeMode,
    selectedChapters.join(","),
    firstNWords,
    selectedModes.join(","),
    wordsPerChunk,
    runMode,
    reviewMode,
    reviewerCount,
    dualEditor,
    dualCount,
    styleComplianceAgent,
    extraPass,
    styleGuide,
    manuscriptLang,
  ]);

  // Once a credential is claimed (paid + saved via the bethaniel:// deep
  // link), point the run at Betty in the Cloud and submit immediately — the
  // user already committed to running this exact job by paying for it.
  useEffect(() => {
    if (!electronBridge) return;
    return electronBridge.onCloudCredentialClaimed((result) => {
      setCloudCheckoutPending(false);
      if (!result.ok) {
        setCloudClaimError(result.error ?? "Could not activate your cloud credit");
        return;
      }
      setCloudClaimError(null);
      void (async () => {
        await refreshModelEnvironment();
        useStore.getState().setModel("custom:bethaniel-cloud");
        await handleClickRef.current();
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [electronBridge]);

  const handleRunInCloud = async () => {
    if (!cloudEstimate) return;
    setCloudClaimError(null);
    try {
      const { checkoutUrl } = await createCloudCheckout(cloudEstimate.quoteId);
      setCloudCheckoutPending(true);
      if (electronBridge) {
        await electronBridge.openCloudCheckout(checkoutUrl);
      } else {
        window.open(checkoutUrl, "_blank");
      }
    } catch (err) {
      setCloudClaimError(
        err instanceof Error ? err.message : "Could not start checkout",
      );
    }
  };

  const buildEditOptions = () => {
    const opts: Record<string, boolean | string> = {};
    if (selectedModes.includes("copy_edit")) {
      Object.assign(opts, copyEditOptions);
    }
    if (selectedModes.includes("line_edit")) {
      Object.assign(opts, lineEditOptions);
    }
    // The deterministic spell-checker (queue.ts) needs the manuscript's own
    // dialect regardless of which edit modes are selected — Publication
    // Scan's proofread pass runs it too, with no copy-edit panel to set the
    // dialect from. Without this it silently defaults to American English
    // and flags every British spelling ("grey", "ambience") as a typo.
    const usesSpellCheck = selectedModes.some(
      (m) =>
        m === "proofread" ||
        m === "copy_edit" ||
        m === "line_edit" ||
        m === "combined_edit",
    );
    if (usesSpellCheck && opts.englishDialect === undefined) {
      opts.englishDialect = copyEditOptions.englishDialect;
    }
    return Object.keys(opts).length > 0 ? opts : undefined;
  };

  const handleClick = async () => {
    if (!doc) return;
    setSubmitting(true);
    try {
      const taskIds = await addToQueue({
        docId: doc.id,
        units,
        model,
        modes: selectedModes,
        wordsPerChunk,
        overlapParagraphs,
        parallel,
        styleGuide: styleGuide || undefined,
        editOptions: buildEditOptions(),
        targetLang: selectedModes.includes("translate")
          ? targetLang
          : undefined,
        // Always sent — every corrections mode's prompt is built around it
        // (copy, line, combined, and the proofread half of a final
        // readthrough). The server drops it for translate tasks, where the
        // target language is what matters.
        manuscriptLang,
        reviewMode,
        reviewerThreshold,
        reviewerCount,
        spellCheck,
        retextCheck,
        grammarCheck,
        dualEditor,
        dualCount,
        characterDedup,
        styleComplianceAgent,
        extraPass,
        runMode,
      });
      if (taskIds.warnings.length > 0) {
        alert(`⚠️ Performance warning:\n\n${taskIds.warnings.join("\n\n")}`);
      }
      useStore.getState().setPendingTaskIds(taskIds.taskIds);
      setTimeout(() => {
        const s = useStore.getState();
        if (s.submitting && s.pendingTaskIds.length > 0) {
          s.setSubmitting(false);
          s.setPendingTaskIds([]);
        }
      }, 10000);
      setWizardStep("folded");
      markStepComplete("run");
    } catch (err) {
      console.error("Failed to add to queue:", err);
      alert(
        `Failed to add to queue: ${err instanceof Error ? err.message : err}`,
      );
      setSubmitting(false);
    }
  };

  useEffect(() => {
    handleClickRef.current = handleClick;
  });

  // Reveal the latest-run results (hidden while a setup menu is open) and jump
  // to the run header.
  const viewLatestRun = () => {
    setWizardStep("folded");
    setTimeout(() => {
      window.document
        .getElementById("current-run-header")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  // Archive the current run into Former Runs and return to setup so the user
  // can reconfigure before launching the next run.
  const newRun = () => {
    setSessionStartedAt(Date.now());
    setWizardStep("folded");
  };

  const hasRun = completedSteps.includes("run");

  if (submitting) {
    return (
      <button className="btn-run btn-run-launching" disabled>
        <div className="btn-run-spinner" />
        <span className="btn-run-label">Launching…</span>
      </button>
    );
  }

  // A run exists in this session: offer "See latest run" (reopen results) and a
  // separate "New run" (archive + back to setup).
  if (hasCurrentRun) {
    return (
      <div className="run-actions">
        <button
          className={`btn-run${isWorking ? " btn-run-launching" : ""}`}
          onClick={viewLatestRun}
        >
          {isWorking ? (
            <div className="btn-run-spinner" />
          ) : (
            <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
          )}
          <span className="btn-run-label">{t("see_latest_run")}</span>
        </button>
        <button className="btn-new-run" onClick={newRun}>
          {t("new_run")}
        </button>
      </div>
    );
  }

  // No run in this session yet — the normal launch button, plus (when a
  // price is available) the pay-per-job cloud option beside it.
  return (
    <div className="run-actions">
      <button
        className="btn-run"
        data-tour="run"
        disabled={disabled}
        onClick={handleClick}
        title={notReadyReason ?? undefined}
      >
        <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
        <span className="btn-run-label">
          {hasRun ? t("run_again") : t("btn_add_to_queue")}
        </span>
        {/* When Betty isn't ready, say so in place of the chapter count — a
            greyed button with no explanation reads as a bug. */}
        {notReadyReason ? (
          <span className="btn-run-meta btn-run-waiting">{notReadyReason}</span>
        ) : (
          units.length > 0 && (
            <span className="btn-run-meta">
              {units.length} {units.length === 1 ? "chapter" : "chapters"} ×{" "}
              {selectedModes.length}{" "}
              {selectedModes.length === 1 ? "mode" : "modes"}
            </span>
          )
        )}
      </button>

      {electronBridge && !disabled && (
        <button
          type="button"
          className="btn-run-cloud"
          disabled={!cloudEstimate || cloudCheckoutPending}
          onClick={handleRunInCloud}
          title={t(
            "cloud_run_disclosure",
            "Your manuscript will be sent to Bethaniel's cloud service for this job.",
          )}
        >
          <span aria-hidden="true">💳</span>
          <span className="btn-run-label">
            {cloudCheckoutPending
              ? t("cloud_waiting_payment", "Waiting for payment…")
              : t("cloud_run_cta", "Run in Cloud")}
          </span>
          {cloudEstimate && !cloudCheckoutPending && (
            <span className="btn-run-meta">
              ≈{cloudEstimate.estimatedTotalTokens.toLocaleString()}{" "}
              {t("cloud_tokens", "tokens")} · {cloudEstimate.confidence ===
              "lower_bound"
                ? "≥"
                : "≈"}
              €{(cloudEstimate.priceCents / 100).toFixed(2)}
            </span>
          )}
          {cloudEstimateError && !cloudEstimate && (
            <span className="btn-run-meta btn-run-waiting">
              {t("cloud_estimate_error", "Cloud pricing unavailable")}
            </span>
          )}
        </button>
      )}
      {cloudClaimError && (
        <div className="api-error">{cloudClaimError}</div>
      )}
    </div>
  );
}
