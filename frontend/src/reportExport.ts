// ── Exporting a report panel as a PDF ──
//
// Any panel that renders a report can be saved as a PDF the same way: take
// its markup, inline the page's stylesheet so it draws identically anywhere,
// and hand the document to the desktop shell, which prints it in a window
// nobody sees and asks where to save. window.print() would print the whole
// app and bury "Save as PDF" in the printer list; in a browser, where there
// is no shell, that dialog is still the fallback.
//
// The hook owns the button's four states — idle, busy, saved, failed — so
// each panel only has to render them.

import { useCallback, useRef, useState } from "react";

export type ExportState = "idle" | "busy" | "saved" | "failed";

/** A complete document: the panel's markup with the page's CSS inlined, and
 *  a title. Print-only tweaks hide controls and keep sections whole. */
export function reportDocument(root: HTMLElement, title: string): string {
  let css = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + "\n";
    } catch {
      // A cross-origin sheet cannot be read; the reports do not depend on one.
    }
  }
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + "</title><style>" + css +
    "\nbody{background:#fff;margin:0;padding:0 8px;font-size:12px;color:#2a2419}" +
    ".la,.readiness{padding:0}.report-toolbar,.la-toolbar,.la-details,.readiness-review{display:none}" +
    ".la-pace,.la-section,.readiness-item{break-inside:avoid}" +
    "h3.report-title{font-family:Georgia,serif;font-size:20px;margin:0 0 10px}" +
    "</style></head><body>" +
    '<h3 class="report-title">' + esc(title) + "</h3>" + root.outerHTML + "</body></html>"
  );
}

type Bridge = { exportPdf?: (html: string, name: string) => Promise<string | null> };

export function useReportExport(title: string) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ExportState>("idle");

  const exportPdf = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;
    const bridge = (window as unknown as { bethaniel?: Bridge }).bethaniel;
    if (!bridge?.exportPdf) {
      window.print();
      return;
    }
    setState("busy");
    try {
      const saved = await bridge.exportPdf(reportDocument(root, title), title);
      setState(saved ? "saved" : "idle");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }, [title]);

  return { rootRef, state, exportPdf };
}

/** The button's label for each state, from the panel's translator. */
export function exportLabel(state: ExportState, t: (k: string, f?: string) => string): string {
  return state === "busy"
    ? t("la_export_busy")
    : state === "saved"
      ? t("la_export_saved")
      : state === "failed"
        ? t("la_export_failed")
        : t("la_export_pdf");
}
