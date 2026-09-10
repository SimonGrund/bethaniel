// ── Style guide editor ──

import { useState, useRef, useEffect, useCallback } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { getStyleGuide, updateStyleGuide, uploadStyleGuide } from "../api";
import { ANALYSIS_MODES } from "../types";

export default function StyleGuideEditor() {
  const {
    lang,
    styleGuide,
    setStyleGuide,
    selectedModes,
    advanceWizard,
    markStepComplete,
  } = useStore();
  const t = useTranslation(lang);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) {
      getStyleGuide()
        .then((content) => {
          setStyleGuide(content);
          // Auto-open the editor when a style guide already exists, so the user
          // lands straight in edit mode instead of the read-only preview.
          if (content.trim()) setExpanded(true);
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  }, [loaded]);

  const handleSave = () => {
    updateStyleGuide(styleGuide);
  };

  const handleUpload = async (file: File) => {
    try {
      const content = await uploadStyleGuide(file);
      setStyleGuide(content);
    } catch (err) {
      console.error("Style guide upload failed:", err);
    }
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [handleUpload],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // Hide when only analysis modes are selected
  const hasNonAnalysis = selectedModes.some((m) => !ANALYSIS_MODES.includes(m));
  if (!hasNonAnalysis) return null;

  const previewLines = styleGuide
    ? styleGuide.split("\n").slice(0, 10).join("\n")
    : "";

  return (
    <section>

      {/* Empty: big textarea + drop zone */}
      {!styleGuide && !expanded ? (
        <div className="styleguide-empty">
          <textarea
            className="style-textarea style-textarea-empty"
            value={styleGuide}
            onChange={(e) => setStyleGuide(e.target.value)}
            rows={12}
            placeholder={t("style_guide_tip")}
          />
          <div
            className="upload-zone compact"
            onDrop={onDrop}
            onDragOver={onDragOver}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".md,.txt,.docx"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
              }}
            />
            <p className="small-note">{t("upload_style")}</p>
          </div>
        </div>
      ) : !expanded ? (
        /* Preview: first 10 lines + buttons below */
        <div className="styleguide-preview">
          <pre className="styleguide-preview-text">
            {previewLines || t("style_guide_tip")}
            {(styleGuide.split("\n").length > 10 || styleGuide.length > previewLines.length) && (
              <span className="styleguide-preview-more">…</span>
            )}
          </pre>
          <div className="styleguide-actions">
            <button
              className="btn-secondary btn-small"
              onClick={() => setExpanded(true)}
            >
              Edit
            </button>
            <button
              className="btn-secondary btn-small"
              onClick={() => fileRef.current?.click()}
            >
              Replace
            </button>
            <button
              className="btn-secondary btn-small"
              onClick={() => {
                setStyleGuide("");
                updateStyleGuide("");
              }}
            >
              Clear
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.txt,.docx"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUpload(file);
            }}
          />
        </div>
      ) : (
        /* Editing: full textarea */
        <div className="styleguide-expanded">
          <button
            type="button"
            className="mode-sub-close"
            onClick={() => { handleSave(); setExpanded(false); }}
            title={t("btn_cancel")}
          >
            −
          </button>
          <textarea
            className="style-textarea"
            value={styleGuide}
            onChange={(e) => setStyleGuide(e.target.value)}
            onBlur={handleSave}
            rows={20}
            placeholder={t("style_guide_tip")}
          />
          <div className="styleguide-actions">
            <button
              className="btn-secondary btn-small"
              onClick={() => fileRef.current?.click()}
            >
              Replace
            </button>
            <button
              className="btn-secondary btn-small"
              onClick={() => {
                handleSave();
                setExpanded(false);
              }}
            >
              Done
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.txt,.docx"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUpload(file);
            }}
          />
        </div>
      )}

      {/* ── Wizard confirm / skip buttons ── */}
      {/* Always, not only while this is the "current" step. That gate was
          written when one card was mounted at a time; on the one-page
          layout every card is mounted, so a card whose confirm appears only
          when it happens to be current is a step that cannot be finished —
          and this is the last one, so the run never becomes available. */}
      {(
        <div className="step-confirm-row">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              markStepComplete("style");
              advanceWizard("style");
            }}
          >
            {t("wizard_skip")}
          </button>
          <button
            type="button"
            className="btn-primary btn-confirm-step"
            onClick={() => {
              handleSave();
              markStepComplete("style");
              advanceWizard("style");
            }}
          >
            {t("wizard_confirm_style")}
          </button>
        </div>
      )}
    </section>
  );
}
