// ── The publication readiness report, as a document ──
//
// The PDF used to be a print of the panel's DOM, which carried the app's
// controls with it. A report someone hands to a co-author is a different
// object: a summary a reader can take in at a glance, then one line per
// correction — the chapter, the change, why — so it is built here from the
// data, not from the screen.
//
// Only what blocks publication is listed. The minor suggestions used to
// follow in a second table, and a report of fifteen blockers arrived as
// twelve pages of wording notes; a reader handed the document could not tell
// the two apart by weight. They stay in the app. The report says how many
// there are and where to find them, and lists none.

import { certaintyPercent, flagKindOf, type Correction } from "./types";

export interface ReportIssue {
  location: string;
  /** The change, as the author wrote it and as proposed. */
  original?: string;
  corrected?: string;
  /** A sentence of context around the change, when there is one. */
  context?: string;
  /** For structural findings: what was found. */
  message?: string;
  detail?: string;
  correction?: Correction;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Where a correction came from, in the reader's words. */
function sourceOf(c: Correction, t: (k: string, f?: string) => string): string {
  const reason = c.reason ?? "";
  let source: string;
  if (reason === "spell-check" || reason === "spell-check-uncommon") source = t("rr_src_dictionary");
  else if (reason === "dialect") source = t("rr_src_dialect");
  else if (reason.startsWith("grammar:"))
    source = `${t("rr_src_grammar")} · ${reason.slice(8).replace(/_/g, " ")}`;
  else if (reason.startsWith("retext:")) source = `${t("rr_src_text")} · ${reason.slice(7).replace(/-/g, " ")}`;
  else source = t("rr_src_betty");
  const pct = certaintyPercent(c);
  const kind = flagKindOf(c);
  const tail =
    kind === "unreviewed" || kind === "unchecked"
      ? t("flag_unchecked")
      : pct !== null
        ? `${pct}%`
        : "";
  return tail ? `${source} · ${tail}` : source;
}

function row(issue: ReportIssue, t: (k: string, f?: string) => string): string {
  const change =
    issue.original !== undefined
      ? `<del>${esc(issue.original)}</del> <span class="arrow">→</span> <ins>${esc(issue.corrected ?? "")}</ins>`
      : esc(issue.message ?? "");
  const why = issue.correction
    ? sourceOf(issue.correction, t)
    : esc(issue.detail ?? "");
  const note = issue.correction?.reviewReason ? `<div class="note">${esc(issue.correction.reviewReason)}</div>` : "";
  const ctx = issue.context ? `<div class="ctx">${esc(issue.context)}</div>` : "";
  return `<tr><td class="loc">${esc(issue.location)}</td><td class="change">${change}${ctx}${note}</td><td class="why">${why}</td></tr>`;
}

function table(issues: ReportIssue[], t: (k: string, f?: string) => string): string {
  return (
    `<table><thead><tr><th>${esc(t("rr_col_chapter"))}</th><th>${esc(t("rr_col_change"))}</th><th>${esc(t("rr_col_why"))}</th></tr></thead><tbody>` +
    issues.map((i) => row(i, t)).join("") +
    "</tbody></table>"
  );
}

export function buildReadinessReportHtml(opts: {
  source: string;
  chapters: number;
  wordCount: number;
  score: number;
  ready: boolean;
  structural: ReportIssue[];
  blocking: ReportIssue[];
  /** How many non-blocking suggestions the scan produced — counted, not listed. */
  minorCount: number;
  lang: string;
  t: (k: string, f?: string) => string;
}): string {
  const { t } = opts;
  const date = new Date().toLocaleDateString(opts.lang === "en" ? "en-GB" : opts.lang, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const n = (x: number) => x.toLocaleString(opts.lang === "en" ? "en-GB" : opts.lang);
  const verdict = opts.ready
    ? t("readiness_ready")
    : t("readiness_check").replace("{n}", String(opts.blocking.length + opts.structural.length));
  const scoreClass = opts.score >= 95 ? "good" : opts.score >= 80 ? "ok" : "bad";

  const css = `
    body{margin:0;padding:0 8px;font:12px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#2a2419;background:#fff}
    h1{font:600 22px Georgia,serif;margin:0 0 2px}
    h2{font:600 15px Georgia,serif;margin:22px 0 8px;padding-bottom:4px;border-bottom:1px solid #d9c9a8;break-after:avoid}
    .meta{color:#6b5d48;margin:0 0 14px}
    .summary{display:flex;gap:18px;align-items:center;padding:12px 14px;border:1px solid #d9c9a8;border-radius:8px;background:#faf6ec;margin:0 0 6px;break-inside:avoid}
    .score{font:700 34px Georgia,serif;line-height:1;min-width:64px;text-align:center}
    .score small{display:block;font:11px/1.2 -apple-system,"Segoe UI",Roboto,sans-serif;font-weight:400;color:#6b5d48;margin-top:4px}
    .score.good{color:#3d6b3d}.score.ok{color:#8a6a1a}.score.bad{color:#9b2335}
    .verdict{font-size:15px;font-weight:600;margin:0 0 6px}
    .counts{color:#4a3f2f;margin:0}
    .counts b{color:#2a2419}
    .empty{color:#4a6a3a;font-style:italic;margin:0}
    table{width:100%;border-collapse:collapse;font-size:11px}
    th{text-align:left;font-weight:600;color:#6b5d48;padding:5px 6px;border-bottom:1px solid #d9c9a8;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase}
    td{padding:5px 6px;border-bottom:1px solid #ece4d2;vertical-align:top}
    tr{break-inside:avoid}
    td.loc{width:17%;color:#4a3f2f}
    td.why{width:22%;color:#6b5d48}
    del{background:#f6d5d5;color:#7a1f1f;text-decoration:line-through}
    ins{background:#d9ecd2;color:#1f4a1f;text-decoration:none}
    .arrow{color:#9a8c76;margin:0 3px}
    .ctx{color:#6b5d48;font-style:italic;margin-top:2px}
    .note{color:#6b5d48;margin-top:2px}
    .foot{margin-top:24px;color:#9a8c76;font-size:10px}
  `;

  const structuralSection =
    opts.structural.length > 0
      ? `<h2>${esc(t("readiness_report_structural"))}</h2>${table(opts.structural, t)}`
      : "";
  const blockingSection =
    `<h2>${esc(t("readiness_report_corrections"))} (${opts.blocking.length})</h2>` +
    (opts.blocking.length > 0
      ? table(opts.blocking, t)
      : `<p class="empty">${esc(t("rr_no_blocking"))}</p>`);

  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t("readiness_report_title"))} — ${esc(opts.source)}</title><style>${css}</style></head><body>` +
    `<h1>${esc(t("readiness_report_title"))}</h1>` +
    `<p class="meta">${esc(opts.source)} · ${n(opts.chapters)} ${esc(t("scan_chapters"))} · ${n(opts.wordCount)} ${esc(t("cloud_words"))} · ${esc(date)}</p>` +
    `<div class="summary"><div class="score ${scoreClass}">${opts.score}<small>${esc(t("quality_score_label"))}</small></div><div>` +
    `<p class="verdict">${esc(verdict)}</p>` +
    `<p class="counts">${esc(t("rr_counts"))
      .replace("{s}", `<b>${opts.structural.length}</b>`)
      .replace("{b}", `<b>${opts.blocking.length}</b>`)
      .replace("{m}", `<b>${opts.minorCount}</b>`)}</p>` +
    `</div></div>` +
    structuralSection +
    blockingSection +
    `<p class="foot">${esc(t("rr_foot"))}</p>` +
    `</body></html>`
  );
}
