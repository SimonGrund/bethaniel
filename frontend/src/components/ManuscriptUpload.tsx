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
    model,
    setSelectedChapters,
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
      // Reset selection
      if (meta.chapters?.length > 0) {
        setSelectedChapters([0]);
      }
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
    <section className="stage">
      <div className="section-label">
        <span className="num">I.</span>
        {t("sec_manuscript")}
      </div>

      {!doc ? (
        <div
          className="upload-zone"
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
        <div className="chip-row">
          <span className="label">{t("lbl_file")}</span>
          <span className="value">{doc.name}</span>
          <span className="sep">·</span>
          <span className="label">{t("lbl_words")}</span>
          <span className="value">{doc.wordCount.toLocaleString()}</span>
          <span className="sep">·</span>
          <span className="label">{t("lbl_chapters")}</span>
          <span className="value">{doc.chapters.length}</span>
          <span className="sep">·</span>
          <span className="label">{t("lbl_model")}</span>
          <span className="value">{model}</span>
        </div>
      )}
    </section>
  );
}
