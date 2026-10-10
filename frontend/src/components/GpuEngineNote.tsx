// ── The GPU engine, said beside the model download ──
//
// Windows only, in practice: the backend fetches and tests the engine for
// this machine's graphics card alongside the model (gpuEngineManager.ts), and
// this says how that is going — or why Betty stays on the processor. What it
// says is decided in gpuEngineNote.ts.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { gpuNoteFor } from "../gpuEngineNote";

export default function GpuEngineNote() {
  const lang = useStore((s) => s.lang);
  const status = useStore((s) => s.gpuEngine);
  const installed = useStore((s) => s.installed);
  const downloads = useStore((s) => s.downloads);
  const dismissed = useStore((s) => s.dismissedAdvice);
  const dismissAdvice = useStore((s) => s.dismissAdvice);
  const t = useTranslation(lang);

  // "Ready" is news only right after a setup this session, and only briefly.
  const sawSetup = useRef(false);
  if (status?.state === "downloading" || status?.state === "testing") sawSetup.current = true;
  const [readyGone, setReadyGone] = useState(false);
  useEffect(() => {
    if (status?.state !== "ready" || !sawSetup.current) return;
    const timer = setTimeout(() => setReadyGone(true), 12_000);
    return () => clearTimeout(timer);
  }, [status?.state]);

  const note = gpuNoteFor(status, {
    localModel: installed.length > 0 || Object.keys(downloads).length > 0,
    sawSetup: sawSetup.current && !readyGone,
    dismissed,
  });
  if (!note) return null;

  const gpu = note.gpu || t("gpu_your_card");
  const text = t(note.key).replace("{gpu}", gpu).replace("{percent}", String(note.percent ?? 0));
  return (
    <div className={`gpu-note gpu-note-${status?.state ?? ""}`} role="status">
      <span className="gpu-note-text">
        {text}
        {note.link && (
          <>
            {" "}
            <a href={note.link} target="_blank" rel="noopener noreferrer">
              {t("gpu_driver_link")}
            </a>
          </>
        )}
      </span>
      {note.percent !== undefined && (
        <div className="download-bar-track" role="progressbar" aria-valuenow={note.percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="download-bar-fill" style={{ width: `${note.percent}%` }} />
        </div>
      )}
      {note.dismissKey && (
        <button type="button" className="link-button gpu-note-dismiss" onClick={() => dismissAdvice(note.dismissKey!)}>
          {t("gpu_note_dismiss")}
        </button>
      )}
    </div>
  );
}
