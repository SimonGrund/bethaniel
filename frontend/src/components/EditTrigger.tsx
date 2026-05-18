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
    if (!doc) return;
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
    <section className="stage edit-trigger-stage">
      <div className="trigger-buttons-row">
        <button className="btn-run" disabled={disabled} onClick={handleClick}>
          <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
          <span className="btn-run-label">{t("btn_add_to_queue")}</span>
          {units.length > 0 && (
            <span className="btn-run-meta">
              {units.length} {units.length === 1 ? "chapter" : "chapters"} ×{" "}
              {selectedModes.length}{" "}
              {selectedModes.length === 1 ? "mode" : "modes"}
            </span>
          )}
        </button>

        <button className="btn-rent-betty" disabled title="Coming soon">
          <span className="btn-rent-betty-label">Rent-A-Betty</span>
          <span className="btn-rent-betty-sub">
            Once the coffee budget runs out - or we get enough complaints about
            Big Bad Betty being too hard to run - we might offer a paid,
            cloud-based option to run edits without needing a powerful local
            machine.
          </span>
        </button>
      </div>

      {selectedModes.length > 1 && (
        <p
          className="mode-description"
          style={{ marginTop: "0.5rem", textAlign: "center" }}
        >
          {modeLabel}
        </p>
      )}
    </section>
  );
}
