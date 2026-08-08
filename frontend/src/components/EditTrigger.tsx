// ── Edit trigger — wizard step 5: Run ──

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { addToQueue } from "../api";
import { buildUnits } from "./ScopeSelection";

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
    apiKeyConfigured,
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
        : isApiModel && !apiKeyConfigured
          ? t("run_blocked_no_api_key")
          : null;

  const disabled =
    !doc ||
    units.length === 0 ||
    selectedModes.length === 0 ||
    submitting ||
    notReadyReason !== null;

  const buildEditOptions = () => {
    const opts: Record<string, boolean> = {};
    if (selectedModes.includes("copy_edit")) {
      Object.assign(opts, copyEditOptions);
    }
    if (selectedModes.includes("line_edit")) {
      Object.assign(opts, lineEditOptions);
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

  // No run in this session yet — the normal launch button.
  return (
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
  );
}
