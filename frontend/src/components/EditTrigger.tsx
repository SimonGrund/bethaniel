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
  } = useStore();
  const t = useTranslation(lang);

  const isWorking = Object.values(tasks).some(
    (task) => task.status === "queued" || task.status === "editing",
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

  // While a run is live this button is the route back to the current-run view.
  const viewCurrentRun = () => {
    setWizardStep("folded");
    setTimeout(() => {
      window.document
        .getElementById("current-run-header")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  const hasRun = completedSteps.includes("run");
  const runLabel = submitting
    ? "Launching…"
    : isWorking
      ? t("view_current_run")
      : hasRun
        ? t("run_again")
        : t("btn_add_to_queue");

  return (
    <button
      className={`btn-run${submitting || isWorking ? " btn-run-launching" : ""}`}
      disabled={submitting || (!isWorking && disabled)}
      onClick={isWorking ? viewCurrentRun : handleClick}
    >
      {submitting || isWorking ? (
        <div className="btn-run-spinner" />
      ) : (
        <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
      )}
      <span className="btn-run-label">{runLabel}</span>
      {units.length > 0 && !submitting && !isWorking && (
        <span className="btn-run-meta">
          {units.length} {units.length === 1 ? "chapter" : "chapters"} ×{" "}
          {selectedModes.length}{" "}
          {selectedModes.length === 1 ? "mode" : "modes"}
        </span>
      )}
    </button>
  );
}
