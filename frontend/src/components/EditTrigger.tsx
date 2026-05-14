// ── Edit trigger — Stage III ──

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
    taskMode,
    copyEditOptions,
    lineEditOptions,
    targetLang,
    fastMode,
    wordsPerChunk,
    overlapParagraphs,
    parallel,
    styleGuide,
    submitting,
    setSubmitting,
  } = useStore();
  const t = useTranslation(lang);

  if (!doc) return null;

  const units = buildUnits(
    documentMd,
    doc.chapters,
    scopeMode,
    selectedChapters,
    firstNWords,
  );
  const disabled = units.length === 0 || submitting;

  const handleClick = async () => {
    setSubmitting(true);
    try {
      console.log("[EditTrigger] addToQueue", {
        docId: doc.id,
        unitCount: units.length,
        model,
        fast: fastMode,
      });
      const taskIds = await addToQueue({
        docId: doc.id,
        units,
        model,
        mode: taskMode,
        fast: fastMode,
        wordsPerChunk,
        overlapParagraphs,
        parallel,
        styleGuide: styleGuide || undefined,
        editOptions:
          taskMode === "copy_edit"
            ? copyEditOptions
            : taskMode === "line_edit"
              ? lineEditOptions
              : undefined,
        targetLang: taskMode === "translate" ? targetLang : undefined,
      });
      console.log("[EditTrigger] taskIds:", taskIds);
    } catch (err) {
      console.error("Failed to add to queue:", err);
      alert(
        `Failed to add to queue: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="stage">
      <div className="section-label">
        <span className="num">IV.</span>
        {t("sec_edit")}
      </div>
      <button className="btn-primary" disabled={disabled} onClick={handleClick}>
        {t("btn_add_to_queue")}
        {units.length > 0 ? ` (${units.length})` : ""}
      </button>
    </section>
  );
}
