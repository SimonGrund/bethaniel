// ── Edit trigger — Stage IV ──

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
  const disabled =
    units.length === 0 || selectedModes.length === 0 || submitting;

  // Build combined editOptions from all selected edit modes
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
    setSubmitting(true);
    try {
      console.log("[EditTrigger] addToQueue", {
        docId: doc.id,
        unitCount: units.length,
        modes: selectedModes,
        model,
        fast: fastMode,
      });
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
      });
      console.log("[EditTrigger] taskIds:", taskIds);
      if (taskIds.warnings.length > 0) {
        alert(`⚠️ Performance warning:\n\n${taskIds.warnings.join("\n\n")}`);
      }
    } catch (err) {
      console.error("Failed to add to queue:", err);
      alert(
        `Failed to add to queue: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const modeLabel = selectedModes.map((m) => t(`mode_${m}`)).join(" + ");

  return (
    <section className="stage">
      <div className="section-label">
        <span className="num">IV.</span>
        {t("sec_edit")}
      </div>
      <button className="btn-primary" disabled={disabled} onClick={handleClick}>
        {t("btn_add_to_queue")}
        {units.length > 0 ? ` (${units.length} × ${selectedModes.length})` : ""}
      </button>
      {selectedModes.length > 1 && (
        <p className="mode-description" style={{ marginTop: "0.3rem" }}>
          {modeLabel}
        </p>
      )}
    </section>
  );
}
