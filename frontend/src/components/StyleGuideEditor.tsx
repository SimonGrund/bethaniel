// ── Style guide editor ──

import { useState, useRef, useEffect, useCallback } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { getStyleGuide, updateStyleGuide, uploadStyleGuide } from "../api";
import { ANALYSIS_MODES } from "../types";

export default function StyleGuideEditor({
  onDone,
}: {
  /** Supplied when this sits in the style-guide dialog: the buttons become
   *  save-and-close rather than the wizard's confirm/skip, and the editor
   *  starts open — the reader clicked a button saying "style guide" and
   *  landing on a read-only preview of an empty sheet would be a dead end. */
  onDone?: () => void;
}) {
  const { lang, styleGuide, setStyleGuide, selectedModes } = useStore();
  const t = useTranslation(lang);
  const [expanded, setExpanded] = useState(!!onDone);
  // In the dialog the editor IS the whole surface, so the controls that fold
  // it back to a read-only preview have nothing to fold into — the dialog's
  // own Save and Close are the only two ways out that make sense.
  const inDialog = !!onDone;
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) {
      getStyleGuide()
        .then((content) => {
          // What the author has here outranks the server's copy: a note
          // typed and closed a moment ago is in the store, and letting an
          // older (or empty) server copy replace it lost the note. The
          // local text is pushed up instead.
          const local = useStore.getState().styleGuide;
          if (local.trim() && local !== content) {
            updateStyleGuide(local);
          } else {
            setStyleGuide(content);
          }
          // Auto-open the editor when a style guide already exists, so the user
          // lands straight in edit mode instead of the read-only preview.
          if ((local || content).trim()) setExpanded(true);
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  }, [loaded]);

  // Closing the dialog unmounts the textarea before it can blur, so a note
  // finished with Escape or the backdrop is saved from here.
  const latest = useRef(styleGuide);
  latest.current = styleGuide;
  const savedAs = useRef<string | null>(null);
  const handleSave = () => {
    savedAs.current = styleGuide;
    updateStyleGuide(styleGuide);
  };
  useEffect(
    () => () => {
      if (savedAs.current !== latest.current) updateStyleGuide(latest.current);
    },
    [],
  );

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
              {t("btn_edit")}
            </button>
            <button
              className="btn-secondary btn-small"
              onClick={() => fileRef.current?.click()}
            >
              {t("btn_replace")}
            </button>
            <button
              className="btn-secondary btn-small"
              onClick={() => {
                setStyleGuide("");
                updateStyleGuide("");
              }}
            >
              {t("btn_clear")}
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
          {!inDialog && (
            <button
              type="button"
              className="mode-sub-close"
              onClick={() => { handleSave(); setExpanded(false); }}
              title={t("btn_cancel")}
            >
              −
            </button>
          )}
          {inDialog && <p className="dialog-intro">{t("styleguide_notes_hint")}</p>}
          <textarea
            className={`style-textarea${inDialog ? " style-textarea-notes" : ""}`}
            value={styleGuide}
            onChange={(e) => setStyleGuide(e.target.value)}
            onBlur={handleSave}
            rows={inDialog ? 7 : 20}
            aria-label={t("styleguide_freetext_title")}
            placeholder={inDialog ? t("styleguide_notes_example") : t("style_guide_tip")}
          />
          <div className="styleguide-actions">
            <button
              className="btn-secondary btn-small"
              onClick={() => fileRef.current?.click()}
            >
              {styleGuide.trim() ? t("styleguide_replace") : t("upload_style")}
            </button>
            {!inDialog && (
              <button
                className="btn-secondary btn-small"
                onClick={() => {
                  handleSave();
                  setExpanded(false);
                }}
              >
                {t("btn_done")}
              </button>
            )}
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

      <div className="step-confirm-row">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => onDone?.()}
        >
          {t("btn_close")}
        </button>
        <button
          type="button"
          className="btn-primary btn-confirm-step"
          onClick={() => {
            handleSave();
            onDone?.();
          }}
        >
          {t("styleguide_save")}
        </button>
      </div>
    </section>
  );
}
