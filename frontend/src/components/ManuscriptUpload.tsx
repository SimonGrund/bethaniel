// ── Manuscript upload — Stage I ──

import { useCallback, useRef } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { uploadFile, getDocument } from "../api";

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
  } = useStore();
  const t = useTranslation(lang);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true);
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
      console.error("Upload failed:", err);
    } finally {
      setUploading(false);
    }
  }, []);

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
      ) : (
        <div className="file-summary">
          <span className="file-name">{doc.name}</span>
          <span className="file-stats">
            {doc.wordCount.toLocaleString()} words · {doc.chapters.length} ch.
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
