// ── A settings group folded down to one line ──
//
// The setup step used to be a wall of controls the author had to read past
// before starting. Most of them are already right — detected from the
// manuscript, or left at a sensible default — so each group folds to a single
// line that says what it settled on, and opens when the reader wants it.
//
// The summary is the whole point. A folded panel that only says "Copy edit"
// hides its state and forces a click to learn anything; one that says
// "default, click to change" or "English · British · Oxford comma" is
// readable without opening it at all.
//
// `status` is optional because only the detected settings have one to report.
// A group of plain preferences has no business wearing a green checkmark —
// nothing checked it.

import { useEffect, useState, type ReactNode } from "react";

export type FoldStatus = "clean" | "attention" | "neutral";

const ICON: Record<FoldStatus, string> = {
  clean: "✓",
  attention: "⚠",
  neutral: "",
};

export default function FoldingPanel({
  title,
  summary,
  status = "neutral",
  demandsAttention = false,
  resetKey,
  children,
}: {
  title: string;
  /** Stands in for the contents while folded — say what was settled on. */
  summary: string;
  status?: FoldStatus;
  /** Opens the panel and keeps it open until the reader folds it again. */
  demandsAttention?: boolean;
  /** Change this to re-assert `demandsAttention` after the reader folded the
   *  panel — a fresh upload needs to raise its hand again. */
  resetKey?: unknown;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(demandsAttention);
  useEffect(() => {
    if (demandsAttention) setOpen(true);
  }, [demandsAttention, resetKey]);

  return (
    <div className={`fold-panel fold-panel-${status}`}>
      <button
        type="button"
        className="fold-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {status !== "neutral" && (
          <span className={`fold-icon fold-icon-${status}`} aria-hidden="true">
            {ICON[status]}
          </span>
        )}
        <span className="fold-title">{title}</span>
        <span className="fold-summary">{summary}</span>
        <span className="fold-chevron" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}
