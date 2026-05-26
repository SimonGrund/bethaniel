// ── Manuscript upload — Stage I ──

import { useCallback, useRef } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { uploadFile, getDocument, setDocumentDetectBreaks } from "../api";

export default function ManuscriptUpload() {
  const {
    lang,
    document: doc,
    setDocument,
    setDocumentMd,
    uploading,
    setUploading,
    setSelectedChapters,
    setScopeMode,
    detectBreaks,
    setDetectBreaks,
  } = useStore();
  const t = useTranslation(lang);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const meta = await uploadFile(file, detectBreaks);
        setDocument(meta);
        // Fetch full text
        const full = await getDocument(meta.id);
        setDocumentMd(full.md);
        // Reset scope to whole-book and clear chapter selection for the new doc
        setScopeMode("whole_book");
        setSelectedChapters(meta.chapters?.length > 0 ? [0] : []);
      } catch (err) {
        console.error("Upload failed:", err);
      } finally {
        setUploading(false);
      }
    },
    [detectBreaks],
  );

  const handleToggleDetect = useCallback(
    async (next: boolean) => {
      if (!doc) return;
      setUploading(true);
      try {
        const meta = await setDocumentDetectBreaks(doc.id, next);
        setDocument(meta);
        setDetectBreaks(next);
        // Re-fetch md in case normalization replaced markers in place.
        const full = await getDocument(meta.id);
        setDocumentMd(full.md);
      } catch (err) {
        console.error("Toggle break detection failed:", err);
      } finally {
        setUploading(false);
      }
    },
    [doc],
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
    <section className="card card-upload">
      <div className="card-header">
        {t("sec_manuscript")}
        <span className="info-tooltip" data-tip={t("tooltip_manuscript")}>
          ⓘ
        </span>
      </div>

      {!doc ? (
        <>
          <div
            className="upload-zone compact"
            onDrop={onDrop}
            onDragOver={onDragOver}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".docx,.md,.markdown"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
              }}
            />
            {uploading ? (
              <p className="small-note">{t("converting")}</p>
            ) : (
              <p className="small-note">{t("upload_prompt")}</p>
            )}
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginTop: "0.5rem",
              fontSize: "0.85rem",
              color: "#6b5c44",
              cursor: "pointer",
            }}
            title="When enabled, Bethaniel inspects the manuscript on upload to identify scene-break and paragraph-break conventions, so the DOCX export can reproduce them. Most users can leave this off."
          >
            <input
              type="checkbox"
              checked={detectBreaks}
              onChange={(e) => setDetectBreaks(e.target.checked)}
              disabled={uploading}
            />
            Detect scene and paragraph breaks on upload
          </label>
        </>
      ) : (
        <div className="file-summary">
          <span className="file-name">{doc.name}</span>
          <span className="file-stats">
            {doc.wordCount.toLocaleString()} words · {doc.chapters.length} ch.
          </span>
          {doc.detectBreaks ? (
            <>
              <span
                className="file-stats"
                title="Detected scene-break marker. You can change how it's rendered in the DOCX export dialog."
                style={{ color: "#6b5c44" }}
              >
                · scene break:{" "}
                <code>{doc.detectedSceneBreak ?? "none found"}</code>
              </span>
              <span
                className="file-stats"
                title="Detected paragraph-break style."
                style={{ color: "#6b5c44" }}
              >
                · paragraph break:{" "}
                <code>{doc.detectedParagraphBreak ?? "empty line"}</code>
              </span>
            </>
          ) : (
            <span
              className="file-stats"
              style={{ color: "#9b8a6f" }}
              title="Break detection is off. The document will be converted plainly between Markdown and DOCX."
            >
              · break detection off
            </span>
          )}
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              fontSize: "0.8rem",
              color: "#6b5c44",
              cursor: uploading ? "not-allowed" : "pointer",
              marginLeft: "0.5rem",
            }}
            title="Toggle to re-detect (or clear) scene and paragraph breaks for this document."
          >
            <input
              type="checkbox"
              checked={!!doc.detectBreaks}
              onChange={(e) => handleToggleDetect(e.target.checked)}
              disabled={uploading}
            />
            detect breaks
          </label>
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
            accept=".docx,.md,.markdown"
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
    </section>
  );
}
