// ── ReviewFocus — the deck with the room to itself ──
//
// The suggestions are read one card at a time with the arrow keys, and
// that reading goes better with nothing else on the screen: no chapter
// dropdown above, no export bar below, no page to scroll. This is the
// backdrop and the centred panel the deck sits in. It is not a Modal: a
// click on the backdrop must not end the session, and the dialogs the
// deck raises from inside it (the same-change offer) stack above it and
// take Escape first — Modal's capture listener stops the key before it
// reaches this one.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { useTranslation } from "../i18n";

export default function ReviewFocus({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** For screen readers only: the view has no visible title. */
  title: string;
  children: React.ReactNode;
}) {
  const lang = useStore((s) => s.lang);
  const t = useTranslation(lang);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    // The page behind must not scroll under the wheel while the deck is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  // Into <body>, past the sidebar's stacking context — see Modal.tsx.
  return createPortal(
    <div className="review-focus" role="dialog" aria-modal="true" aria-label={title}>
      {/* No panel and no title bar: the card on the dark is the whole view.
          The jump-to control lives in the deck's settings menu. */}
      <button
        type="button"
        className="review-focus-close"
        onClick={() => onCloseRef.current()}
        title={`${t("focus_close")} — Esc`}
        aria-label={t("focus_close")}
      >
        ✕
      </button>
      <div className="review-focus-panel">
        <div className="review-focus-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
