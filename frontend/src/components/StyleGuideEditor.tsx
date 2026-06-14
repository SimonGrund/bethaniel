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
    wizardStep,
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
      <div className="section-label">
        {t("style_guide")}
        <span className="info-tooltip" data-tip={t("style_guide_tooltip")}>
          ⓘ
        </span>
      </div>

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
              Upload
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
      {wizardStep === "style" && (
        <div className="wizard-confirm" style={{ gap: "0.5rem" }}>
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
