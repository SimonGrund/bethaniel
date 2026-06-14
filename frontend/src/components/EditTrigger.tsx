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
    fastMode,
    reviewMode,
    reviewerThreshold,
    reviewerCount,
    spellCheck,
    dualEditor,
    dualCount,
    characterDedup,
    wordsPerChunk,
    overlapParagraphs,
    parallel,
    styleGuide,
    submitting,
    setSubmitting,
    tasks,
    wizardStep,
    setWizardStep,
    markStepComplete,
    apiModel,
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
        fast: fastMode,
        wordsPerChunk,
        overlapParagraphs,
        parallel,
        styleGuide: styleGuide || undefined,
        editOptions: buildEditOptions(),
        targetLang: selectedModes.includes("translate")
          ? targetLang
          : undefined,
        reviewMode,
        reviewerThreshold,
        reviewerCount,
        spellCheck,
        dualEditor,
        dualCount,
        characterDedup,
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

  if (wizardStep !== "run" && wizardStep !== "done" && wizardStep !== "folded") return null;

  function modelLabel(): string {
    if (!model) return "?";
    if (model.startsWith("custom:")) return `External: ${apiModel || "DeepSeek"}`;
    if (model.includes("Qwen3.5-4B")) return "Baby Betty";
    if (model.includes("Qwen3.5-9B")) return "Basic Betty";
    if (model.includes("Mistral")) return "Big Bad Betty";
    return model.replace(".gguf", "");
  }

  const editLabel = selectedModes.map((m) => t(`mode_${m}`)).join(" + ");
  const chapterLabel = units.length > 0
    ? `${units.length} ${units.length === 1 ? "chapter" : "chapters"}`
    : "";

  return (
    <section className="wizard-run-section">
      {/* Summary */}
      <div className="wizard-run-summary">
        <span className="run-summary-line">
          {modelLabel()} · {editLabel}
        </span>
        {doc && (
          <span className="run-summary-line">
            {doc.name} · {chapterLabel} · {doc.wordCount.toLocaleString()} words
          </span>
        )}
        {styleGuide && (
          <span className="run-summary-line">
            {t("style_guide")}: {t("provided")}
          </span>
        )}
      </div>

      {/* Run button */}
      <button
        className={`btn-run${submitting ? " btn-run-launching" : ""}`}
        disabled={disabled || isWorking}
        onClick={handleClick}
      >
        {submitting ? (
          <div className="btn-run-spinner" />
        ) : (
          <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
        )}
        <span className="btn-run-label">
          {submitting
            ? "Launching…"
            : isWorking
              ? t("btn_add_to_queue_busy")
              : t("btn_add_to_queue")}
        </span>
        {units.length > 0 && !submitting && !isWorking && (
          <span className="btn-run-meta">
            {units.length} {units.length === 1 ? "chapter" : "chapters"} ×{" "}
            {selectedModes.length}{" "}
            {selectedModes.length === 1 ? "mode" : "modes"}
          </span>
        )}
      </button>
    </section>
  );
}
