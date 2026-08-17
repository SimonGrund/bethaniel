// ── Manuscript upload — Stage I ──

import { useCallback, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { uploadFile, getDocument } from "../api";
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
    documentMd,
    setDocumentMd,
    uploading,
    setUploading,
    setSelectedChapters,
    setScopeMode,
    wizardStep,
    advanceWizard,
    markStepComplete,
    installed,
    modelEnvLoaded,
    hasSeenModelIntro,
    setModelIntroOpen,
    recommendation,
  } = useStore();
  const t = useTranslation(lang);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * Offer a Betty, once, when the manuscript lands.
   *
   * This is the moment a model first becomes relevant, and — since the model
   * step is hidden by default — the only moment the app gets to raise it.
   * Skipped for anyone who already has a local model on disk, and for anyone
   * who has seen the offer before.
   */
  function maybeOfferModel() {
    if (hasSeenModelIntro) return;
    // An empty list before the first fetch lands means "unknown", not "none".
    if (!modelEnvLoaded || installed.length > 0) return;
    if (!recommendation) return;
    setModelIntroOpen(true);
  }

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
        // that is not text. Swallowing that left the user clicking Upload and
        // watching nothing happen.
        console.error("Upload failed:", err);
        setUploadError(
          err instanceof Error && err.message ? err.message : t("upload_failed"),
        );
      } finally {
        setUploading(false);
      }
    },
    [t],
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
    <section>

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
              accept=".docx,.pdf,.md,.markdown"
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
          {doc && documentMd && (
            <details
              className="import-preview"
              open={doc.name.toLowerCase().endsWith(".pdf")}
            >
              <summary>{t("preview_extracted")}</summary>
              <p className="small-note">{t("preview_hint")}</p>
              <pre className="import-preview-text">
                {documentMd.slice(0, PREVIEW_CHARS)}
                {documentMd.length > PREVIEW_CHARS ? "\n…" : ""}
              </pre>
            </details>
          )}
          <span className="file-name">{doc.name}</span>
          <span className="file-stats">
            {doc.wordCount.toLocaleString()} words ·{" "}
            {doc.chapters.length === 0
              ? "no chapters detected"
              : doc.chapters
                  .slice(0, 4)
                  .map((ch, i) => shortChapterLabel(i, ch.title))
                  .join(" · ") +
                (doc.chapters.length > 4
                  ? ` · +${doc.chapters.length - 4} more`
                  : "")}
          </span>
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? t("converting") : t("btn_change_document")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.pdf,.md,.markdown"
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

      {/* ── Scope selection (after upload, in wizard step 3) ── */}
      {wizardStep === "upload" && doc && (
        <>
          <ScopeSelection />
          <div className="wizard-confirm">
            <button
              type="button"
              className="btn-primary btn-confirm-step"
              onClick={() => {
                markStepComplete("upload");
                maybeOfferModel();
                advanceWizard("upload");
              }}
            >
              {t("wizard_confirm_upload")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
