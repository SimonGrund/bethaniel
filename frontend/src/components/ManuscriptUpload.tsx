// ── Manuscript upload — Stage I ──

import { useCallback, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import {
  uploadFile,
  getDocument,
  linkScrivener,
  pickScrivenerViaBackend,
  RequestRefusedError,
} from "../api";
import type { DocumentMeta } from "../types";
import Modal from "./Modal";
import ScopeSelection, { shortChapterLabel } from "./ScopeSelection";
import StyleGuideButton from "./StyleGuideButton";
import ManuscriptSettings from "./ManuscriptSettings";
import { frontCardFor } from "../types";

/**
 * How much of the manuscript to show back. Enough to see whether a PDF's drop
 * caps, paragraph breaks and accents survived, without pasting a chapter into
 * the upload panel.
 */
const PREVIEW_CHARS = 900;
// Newline plus an ellipsis, by char code: the source then carries no escape
// for tooling to mangle on the way in.
const PREVIEW_MORE = String.fromCharCode(10, 8230);

/** Two chain links: a project linked where it lives, not a copy handed over. */
export function LinkIcon() {
  return (
    <svg className="scriv-link-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"
      />
    </svg>
  );
}

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
    applyDetectedSettings,
    setLexicon,
    advanceWizard,
    markStepComplete,
    selectedModes,
  } = useStore();
  const t = useTranslation(lang);
  const fileRef = useRef<HTMLInputElement>(null);

  // Refusals the backend can explain — a scanned PDF, a file that is not text.
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Which chapter the sample shows. Null is the start of the manuscript, which
  // is where a reader looks first — front matter is where a bad import usually
  // shows itself.
  const [previewChapter, setPreviewChapter] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  /** A manuscript has arrived — uploaded, or read from a linked project. */
  const adopt = useCallback(
    async (meta: DocumentMeta) => {
      setDocument(meta);
      // The manuscript answers the language / dialect / comma questions the
      // next wizard step is about to ask. Applied before the user gets
      // there, so the controls are already right when they arrive.
      applyDetectedSettings(meta.detected);
      // Its names & terms, harvested in the same upload: the list the
      // style-sheet button now offers for review.
      setLexicon(meta.lexicon ?? null);
      // Fetch full text
      const full = await getDocument(meta.id);
      setDocumentMd(full.md);
      // Reset scope to whole-book and clear chapter selection for the new doc
      setScopeMode("whole_book");
      setSelectedChapters(meta.chapters?.length > 0 ? [0] : []);
    },
    [applyDetectedSettings, setLexicon],
  );

  // ── Linking a Scrivener project ──
  // Read where it is; nothing in the project changes until the author writes
  // back from the review. The author clicks through Explorer or Finder to it:
  // Electron's own dialog in the desktop app, and in a browser — which cannot
  // hand over a path — the same dialog opened by the backend, which runs on
  // this machine. A typed path is only the last resort, for a machine with
  // no desktop to show a dialog on.
  const [pathField, setPathField] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const handleLink = useCallback(
    async (projectPath: string) => {
      setUploading(true);
      setUploadError(null);
      try {
        await adopt(await linkScrivener(projectPath));
        setPathField(null);
      } catch (err) {
        setUploadError(err instanceof Error && err.message ? err.message : t("upload_failed"));
      } finally {
        setUploading(false);
      }
    },
    [adopt, t],
  );
  const pickScrivener = useCallback(async () => {
    const bridge = (window as { bethaniel?: { selectScrivenerProject?: () => Promise<string | null> } })
      .bethaniel;
    setUploadError(null);
    setPicking(true);
    try {
      const picked = bridge?.selectScrivenerProject
        ? await bridge.selectScrivenerProject()
        : await pickScrivenerViaBackend(t("scriv_link_btn"));
      if (picked) await handleLink(picked);
    } catch {
      // No dialog could be shown on this machine: let the path be typed.
      setPathField("");
    } finally {
      setPicking(false);
    }
  }, [handleLink, t]);

  const handleUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadError(null);
      try {
        await adopt(await uploadFile(file));
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
    [t, clearDocument, adopt],
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

  // The slice the picker is asking for.
  const chapterForPreview =
    previewChapter !== null && doc ? doc.chapters[previewChapter] : undefined;
  const previewBody = chapterForPreview
    ? documentMd.slice(chapterForPreview.start, chapterForPreview.end)
    : documentMd;

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
          {/* The other way in: not a file handed over, a project linked
              where it lives. */}
          <div className="scriv-link">
            <span className="scriv-link-or">{t("run_or")}</span>
            <button
              type="button"
              className="btn-secondary scriv-link-btn"
              onClick={pickScrivener}
              disabled={uploading || picking}
            >
              <LinkIcon />
              {picking ? t("scriv_link_picking") : t("scriv_link_btn")}
              <span className="beta-tag">{t("scriv_beta")}</span>
            </button>
            {pathField !== null && (
              <form
                className="scriv-link-path"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (pathField.trim()) void handleLink(pathField.trim());
                }}
              >
                <input
                  type="text"
                  value={pathField}
                  onChange={(e) => setPathField(e.target.value)}
                  placeholder={t("scriv_link_path_placeholder")}
                  aria-label={t("scriv_link_path_placeholder")}
                  autoFocus
                />
                <button type="submit" className="btn-primary btn-small" disabled={!pathField.trim() || uploading}>
                  {t("scriv_link_go")}
                </button>
              </form>
            )}
            <p className="small-note scriv-link-note">{t("scriv_link_note")}</p>
          </div>
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

      {/* What the manuscript IS, and what to run it over. There is no confirm
          button any more: the run row is always on the page and enables itself
          once there is a document and a task, so a button whose only job was
          to advance a wizard step was a click that bought nothing. */}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        labelledBy="preview-dialog-title"
        className="preview-dialog"
      >
        <div className="import-preview-head">
          <h2 id="preview-dialog-title" className="dialog-title">
            {t("preview_extracted")}
          </h2>
          {/* Checking an import means checking where it is likely to have
              gone wrong, which is rarely the first page. */}
          {doc && doc.chapters.length > 0 && (
            <select
              className="import-preview-pick"
              value={previewChapter === null ? "start" : String(previewChapter)}
              onChange={(e) =>
                setPreviewChapter(
                  e.target.value === "start" ? null : Number(e.target.value),
                )
              }
              aria-label={t("preview_pick_chapter", "Chapter to preview")}
            >
              <option value="start">
                {t("preview_from_start", "From the beginning")}
              </option>
              {doc.chapters.map((ch, i) => (
                <option key={i} value={i}>
                  {shortChapterLabel(i, ch.title)}
                </option>
              ))}
            </select>
          )}
        </div>
        <pre className="import-preview-text">
          {previewBody.slice(0, PREVIEW_CHARS)}
          {previewBody.length > PREVIEW_CHARS ? PREVIEW_MORE : ""}
        </pre>
        <div className="step-confirm-row">
          <button
            type="button"
            className="btn-primary"
            onClick={() => setPreviewOpen(false)}
          >
            {t("btn_close")}
          </button>
        </div>
      </Modal>

      {doc && (
        <aside className="upload-side">
          <div className="upload-side-doc">
            <span className="file-name-row">
              {doc.scrivener && <LinkIcon />}
              <span className="file-name">{doc.scrivener ? doc.scrivener.projectName : doc.name}</span>
              {/* On the file name rather than in the card's corner: an × up
                  there reads as closing the card, and this unloads the
                  manuscript. "Change document" replaces one; nothing emptied
                  the card until now. */}
              <button
                type="button"
                className="file-remove"
                onClick={clearDocument}
                title={t("remove_document")}
                aria-label={t("remove_document")}
              >
                ×
              </button>
            </span>
            <span className="file-stats">
              {doc.wordCount.toLocaleString()} {t("lbl_words")} ·{" "}
              {doc.chapters.length === 0
                ? t("no_chapters_detected")
                : doc.chapters
                    .slice(0, 3)
                    .map((ch, i) => shortChapterLabel(i, ch.title))
                    .join(" · ") +
                  (doc.chapters.length > 3
                    ? ` · ${t("n_more").replace("{n}", String(doc.chapters.length - 3))}`
                    : "")}
            </span>
            {/* The extracted text is no longer shown on the page. It is the
                tallest thing in the setup screen and it is needed once — to
                check the import did not mangle anything — so it opens on
                request instead of pushing the rest of the job below the fold
                on every visit. Sits with the file it describes. */}
            {documentMd && (
              <button
                type="button"
                className="btn-linkish import-preview-open"
                onClick={() => setPreviewOpen(true)}
              >
                {t("preview_open")}
              </button>
            )}
            {/* A linked project says so, and says what that means: read, not
                changed, until the author writes back. */}
            {doc.scrivener && (
              <span className="scriv-linked">
                <span className="scriv-linked-badge">{t("scriv_linked_badge")}</span>
                <span className="beta-tag">{t("scriv_beta")}</span>{" "}
                {t("scriv_linked_note").replace("{n}", String(doc.scrivener.scenes))}
              </span>
            )}
            {doc.scrivener ? (
              <button
                type="button"
                className="btn-linkish"
                onClick={() => void handleLink(doc.scrivener!.projectDir)}
                disabled={uploading}
                title={t("scriv_reread_tip")}
              >
                {uploading ? t("converting") : t("scriv_reread")}
              </button>
            ) : (
              <button
                type="button"
                className="btn-linkish"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? t("converting") : t("btn_change_document")}
              </button>
            )}
          </div>

          <ScopeSelection />

          {/* What Betty read off the manuscript — language, dialect, the
              comma conventions — with the manuscript it describes. Which
              rows show depends on the task picked opposite: a translation
              never asks about the Oxford comma. */}
          {frontCardFor(selectedModes) && (
            <ManuscriptSettings card={frontCardFor(selectedModes)!} />
          )}

          {/* The names & terms Betty just read off this manuscript, and the
              style sheet: offered here, with the manuscript they describe, as
              well as in the task's settings. Right after an upload is when
              an author wants to see what was found. */}
          <StyleGuideButton />
        </aside>
      )}
    </section>
  );
}
