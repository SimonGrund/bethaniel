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

import { useState, type ReactNode } from "react";

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
  children,
}: {
  title: string;
  /** Stands in for the contents while folded — say what was settled on. */
  summary: string;
  status?: FoldStatus;
  children: ReactNode;
}) {
  // A panel that needs the author never opens itself. It used to: `attention`
  // threw the panel open and kept it open, so picking a task card — which is
  // what brings dialect and the commas into scope — made the column opposite
  // grow a settings form under the cursor. Wanting attention is not the same
  // as taking it. The orange flag and the "3 need your input" summary say so
  // from one folded line, and the reader opens it when they are ready.
  const [open, setOpen] = useState(false);

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
