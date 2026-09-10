// ── Manuscript upload — Stage I ──

import { useCallback, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { uploadFile, getDocument, RequestRefusedError } from "../api";
import ScopeSelection, { shortChapterLabel } from "./ScopeSelection";

/**
 * How much of the manuscript to show back. Enough to see whether a PDF's drop
 * caps, paragraph breaks and accents survived, without pasting a chapter into
 * the upload panel.
 */
const PREVIEW_CHARS = 900;

export default function ManuscriptUpload() {
  const {
    lang,
    document: doc,
    setDocument,
    clearDocument,
    documentMd,
    setDocumentMd,
    uploading,
    setUploading,
    setSelectedChapters,
    setScopeMode,
    advanceWizard,
    markStepComplete,
  } = useStore();
  const t = useTranslation(lang);
  const fileRef = useRef<HTMLInputElement>(null);

  // Refusals the backend can explain — a scanned PDF, a file that is not text.
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadError(null);
      try {
        const meta = await uploadFile(file);
        setDocument(meta);
        // Fetch full text
        const full = await getDocument(meta.id);
        setDocumentMd(full.md);
        // Reset scope to whole-book and clear chapter selection for the new doc
        setScopeMode("whole_book");
        setSelectedChapters(meta.chapters?.length > 0 ? [0] : []);
      } catch (err) {
        // The backend explains refusals it can explain — a scanned PDF, a file
        // whose fonts carry no character map, a file that is not text.
        // Swallowing that left the user clicking Upload and watching nothing
        // happen.
        console.error("Upload failed:", err);
        // Drop whatever was loaded before, but ONLY when the server refused
        // the file. Keeping it behind an error message invites editing the
        // previous manuscript in the belief that the new one arrived. A 500 or
        // a dropped connection says nothing about the file, and wiping a loaded
        // manuscript over a backend hiccup would be the worse bug.
        const refused = err instanceof RequestRefusedError;
        const had = useStore.getState().document !== null;
        if (refused) clearDocument();
        const detail =
          err instanceof Error && err.message ? err.message : t("upload_failed");
        setUploadError(
          refused && had ? `${detail} ${t("upload_cleared")}` : detail,
        );
      } finally {
        setUploading(false);
      }
    },
    [t, clearDocument],
  );

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

  return (
    <section className={`upload-step${doc ? " upload-step-loaded" : ""}`}>
      <div className="upload-main">
      {!doc ? (
        <>
          <div
            className="upload-zone"
            onDrop={onDrop}
            onDragOver={onDragOver}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".docx,.epub,.pdf,.md,.markdown"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
              }}
            />
            <span className="upload-zone-icon" aria-hidden="true">
              ⬆
            </span>
            {uploading ? (
              <p className="small-note">{t("converting")}</p>
            ) : (
              <p className="small-note">{t("upload_prompt")}</p>
            )}
          </div>
          <p className="small-note upload-pdf-note">{t("pdf_caveat")}</p>
          {uploadError && (
            <p className="upload-error" role="alert">
              {uploadError}
            </p>
          )}
        </>
      ) : (
        <div className="file-summary">
          {uploadError && (
            <p className="upload-error" role="alert">
              {uploadError}
            </p>
          )}
          {doc && documentMd && (
            <div className="import-preview">
              <p className="import-preview-label">{t("preview_extracted")}</p>
              <p className="small-note">{t("preview_hint")}</p>
              <pre className="import-preview-text">
                {documentMd.slice(0, PREVIEW_CHARS)}
                {documentMd.length > PREVIEW_CHARS ? "\n…" : ""}
              </pre>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.epub,.pdf,.md,.markdown"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handleUpload(file);
                e.target.value = "";
              }
            }}
          />
        </div>
      )}

      </div>

      {/* Everything that describes the manuscript or acts on it lives in one
          column beside the sample, not stacked under it: the file, what is in
          it, what to edit, and the button that moves on. Confirm sits at the
          bottom of that column, which is where a column of decisions ends. */}
      {/* Same reasoning as the style step: the card is on screen, so the
          control that completes it is too. */}
      {doc && (
        <aside className="upload-side">
          <div className="upload-side-doc">
            <span className="file-name">{doc.name}</span>
            <span className="file-stats">
              {doc.wordCount.toLocaleString()} words ·{" "}
              {doc.chapters.length === 0
                ? "no chapters detected"
                : doc.chapters
                    .slice(0, 3)
                    .map((ch, i) => shortChapterLabel(i, ch.title))
                    .join(" · ") +
                  (doc.chapters.length > 3
                    ? ` · +${doc.chapters.length - 3} more`
                    : "")}
            </span>
            <button
              type="button"
              className="btn-linkish"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? t("converting") : t("btn_change_document")}
            </button>
          </div>

          <ScopeSelection />

          <div className="step-confirm-row upload-side-confirm">
          <button
            type="button"
            className="btn-primary btn-confirm-step"
            onClick={() => {
              markStepComplete("upload");
              advanceWizard("upload");
            }}
          >
            {t("wizard_confirm_upload")}
          </button>
          </div>
        </aside>
      )}
    </section>
  );
}
