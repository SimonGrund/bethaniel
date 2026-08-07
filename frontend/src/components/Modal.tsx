// ── Modal — one dialog shell for the whole app ──
//
// The codebase had three ad-hoc overlay patterns and no shared component, so
// Escape-to-close and focus handling were implemented zero times. This wraps
// the best-looking of the three (.model-confirm-overlay) and adds the parts
// that were missing.

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  open,
  onClose,
  labelledBy,
  className = "",
  children,
}: {
  open: boolean;
  /** Omit to make the dialog non-dismissible (no backdrop click, no Escape). */
  onClose?: () => void;
  /** id of the element naming this dialog, for screen readers. */
  labelledBy?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<Element | null>(null);

  // Escape closes; Tab cycles inside. Without the trap, tabbing walks off into
  // the page behind the backdrop, which for a blocking first-run dialog means
  // a keyboard user can end up somewhere they cannot see.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    // Move focus in so the dialog reads immediately and Tab starts inside.
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      (restoreFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="model-confirm-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className={`model-confirm-dialog ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
