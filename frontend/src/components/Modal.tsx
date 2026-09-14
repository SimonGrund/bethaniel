// ── Modal — one dialog shell for the whole app ──
//
// The codebase had three ad-hoc overlay patterns and no shared component, so
// Escape-to-close and focus handling were implemented zero times. This wraps
// the best-looking of the three (.model-confirm-overlay) and adds the parts
// that were missing.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Dialogs stack: the style sheet opens from inside the task's settings. Only
// the one on top answers Escape and traps Tab, or one Escape closes both and
// the outer trap pulls focus out of the inner dialog's notes.
const openStack: symbol[] = [];

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
  const id = useRef(Symbol("modal"));
  // Read through a ref so the effect below depends on `open` alone. Callers
  // pass `onClose={() => setOpen(false)}` — a new function every render —
  // and a parent that re-renders on each keystroke (the style-sheet button
  // counts the words) re-ran the effect on each one: focus was restored to
  // the opener and then moved to the dialog's first control, and the
  // textarea being typed in kept the first letter only.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape closes; Tab cycles inside. Without the trap, tabbing walks off into
  // the page behind the backdrop, which for a blocking first-run dialog means
  // a keyboard user can end up somewhere they cannot see.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement;
    const me = id.current;
    openStack.push(me);

    const onKeyDown = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== me) return;
      if (e.key === "Escape" && onCloseRef.current) {
        e.stopPropagation();
        onCloseRef.current();
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
      const at = openStack.indexOf(me);
      if (at >= 0) openStack.splice(at, 1);
      (restoreFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  // Rendered into document.body rather than in place. `position: fixed` and a
  // high z-index are not enough on their own: an ancestor that forms a stacking
  // context traps the overlay inside it. The sidebar is `position: sticky`,
  // which always creates one, so a modal opened from there painted *underneath*
  // .main-content — the page content covered the dialog, which made it look
  // half-transparent and left its buttons unclickable (clicks landed on the
  // content in front). The portal escapes every such context.
  return createPortal(
    <div
      className="model-confirm-overlay"
      onClick={() => onCloseRef.current?.()}
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
    </div>,
    document.body,
  );
}
