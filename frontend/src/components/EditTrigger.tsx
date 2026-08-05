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
  const disabled =
    !doc || units.length === 0 || selectedModes.length === 0 || submitting;

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
        manuscriptLang: selectedModes.some(
          (m) => m === "copy_edit" || m === "line_edit",
        )
          ? manuscriptLang
          : undefined,
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
    <button className="btn-run" disabled={disabled} onClick={handleClick}>
      <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
      <span className="btn-run-label">
        {hasRun ? t("run_again") : t("btn_add_to_queue")}
      </span>
      {units.length > 0 && (
        <span className="btn-run-meta">
          {units.length} {units.length === 1 ? "chapter" : "chapters"} ×{" "}
          {selectedModes.length}{" "}
          {selectedModes.length === 1 ? "mode" : "modes"}
        </span>
      )}
    </button>
  );
}
