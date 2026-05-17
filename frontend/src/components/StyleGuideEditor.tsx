// ── Style guide editor ──

import { useState, useRef, useEffect, useCallback } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { getStyleGuide, updateStyleGuide, uploadStyleGuide } from "../api";
import { ANALYSIS_MODES } from "../types";

export default function StyleGuideEditor() {
  const { lang, styleGuide, setStyleGuide, selectedModes } = useStore();
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

  return (
    <section className="card card-styleguide">
      <div className="card-header">
        {t("style_guide")}
        <span className="info-tooltip" data-tip={t("style_guide_tooltip")}>
          ⓘ
        </span>
      </div>

      {!styleGuide && !expanded ? (
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
      ) : !expanded ? (
        <div className="file-summary">
          <span className="file-name">{styleGuide.slice(0, 60)}…</span>
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
        <div className="styleguide-expanded">
          <textarea
            className="style-textarea"
            value={styleGuide}
            onChange={(e) => setStyleGuide(e.target.value)}
            onBlur={handleSave}
            rows={8}
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
    </section>
  );
}
