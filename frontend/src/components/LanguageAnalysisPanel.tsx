// ── LanguageAnalysisPanel — the counts, as a short report ──
//
// Leads with what to look at first: the handful of findings furthest past
// their thresholds, each as one sentence with the number in it and one line
// on why it matters. Every section after that opens with the aim — the
// number to be under or over — and a mark saying whether this manuscript is,
// so the reader never has to infer the standard from the verdict. The
// tables and the chart sit below as evidence.
//
// The aims are printed from the report, not kept here: the backend holds one
// set of thresholds, awards the marks from them, and sends them along, so
// the stated aim and the mark can never disagree.
//
// Every sentence here is phrased from the report's params so the same
// numbers read correctly in Danish, German and Spanish.

import { useRef, useState } from "react";
import { useTranslation } from "../i18n";
import type { Lang, LanguageAnalysisReport, LanguageFinding } from "../types";

function fill(s: string, params: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ""));
}

/**
 * The book as a row of bars, one per run of sentences in reading order,
 * each as tall as those sentences are long on average. Short bars read
 * quick, tall bars read slow, and the shape across the row is the pace of
 * the whole — the one thing a per-chapter table cannot show.
 *
 * One series, one axis; the average as a dashed line; chapter starts as
 * ticks. Colour carries nothing: the height is the information.
 */
function PaceChart({
  profile,
  average,
  t,
}: {
  profile: LanguageAnalysisReport["rhythm"]["profile"];
  average: number;
  t: (k: string, f?: string) => string;
}) {
  if (profile.length < 2) return null;
  const W = 800;
  const H = 170;
  const padL = 34;
  const padR = 8;
  const padT = 14;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxY = Math.max(10, Math.ceil(Math.max(...profile.map((p) => p.meanSentence), average) * 1.1));
  const y = (v: number) => padT + innerH - (v / maxY) * innerH;
  const n = profile.length;
  const step = innerW / n;
  const barW = Math.max(2, step * 0.72);
  const gridlines = [10, 20, 30, 40].filter((g) => g < maxY);

  // Chapter starts, for the ticks. Numbered rather than named: names do
  // not fit under a bar two pixels wide, and the table below has them.
  const starts: { i: number; num: number }[] = [];
  let num = 0;
  profile.forEach((p, i) => {
    if (i === 0 || p.chapter !== profile[i - 1].chapter) starts.push({ i, num: ++num });
  });
  const labelEvery = starts.length > 24 ? Math.ceil(starts.length / 24) : 1;

  return (
    <svg
      className="la-pace"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={t("la_pace_aria")}
    >
      {gridlines.map((g) => (
        <g key={g}>
          <line x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} className="la-pace-grid" />
          <text x={padL - 6} y={y(g) + 3} className="la-pace-ylabel" textAnchor="end">
            {g}
          </text>
        </g>
      ))}
      {profile.map((p, i) => (
        <rect
          key={i}
          x={padL + i * step + (step - barW) / 2}
          y={y(p.meanSentence)}
          width={barW}
          height={Math.max(1, padT + innerH - y(p.meanSentence))}
          rx={1.5}
          className="la-pace-bar"
        >
          <title>{`${p.chapter} · ${p.meanSentence} ${t("la_words_per_sentence")} · ${p.dialogueShare}% ${t("la_dialogue").toLowerCase()}`}</title>
        </rect>
      ))}
      <line
        x1={padL}
        x2={W - padR}
        y1={y(average)}
        y2={y(average)}
        className="la-pace-avg"
      />
      <text x={W - padR} y={y(average) - 4} className="la-pace-avg-label" textAnchor="end">
        {t("la_pace_average")} {average}
      </text>
      {starts.map(({ i, num: k }) => (
        <g key={i}>
          <line
            x1={padL + i * step}
            x2={padL + i * step}
            y1={padT + innerH}
            y2={padT + innerH + 5}
            className="la-pace-tick"
          />
          {(k - 1) % labelEvery === 0 && (
            <text x={padL + i * step + 2} y={H - 8} className="la-pace-xlabel">
              {k}
            </text>
          )}
        </g>
      ))}
      <text x={padL} y={padT - 3} className="la-pace-edge">
        ↑ {t("la_pace_slower")}
      </text>
      <text x={W - padR} y={H - 8} className="la-pace-edge" textAnchor="end">
        ↓ {t("la_pace_quicker")}
      </text>
    </svg>
  );
}

/**
 * The same runs of sentences as the pace chart, bar for bar, each as tall
 * as the share of it that is dialogue. Read across both rows: a quick
 * stretch that is also all dialogue is a scene; a quick stretch with none
 * is short narration; a slow one with none is description.
 */
function DialogueChart({
  profile,
  t,
}: {
  profile: LanguageAnalysisReport["rhythm"]["profile"];
  t: (k: string, f?: string) => string;
}) {
  if (profile.length < 2) return null;
  const W = 800;
  const H = 110;
  const padL = 34;
  const padR = 8;
  const padT = 14;
  const padB = 8;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const y = (v: number) => padT + innerH - (v / 100) * innerH;
  const n = profile.length;
  const step = innerW / n;
  const barW = Math.max(2, step * 0.72);
  const overall = profile.reduce((a, p) => a + p.dialogueShare, 0) / n;

  return (
    <svg className="la-pace la-dialogue" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("la_dialogue_aria")}>
      {[50, 100].map((g) => (
        <g key={g}>
          <line x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} className="la-pace-grid" />
          <text x={padL - 6} y={y(g) + 3} className="la-pace-ylabel" textAnchor="end">
            {g}%
          </text>
        </g>
      ))}
      {profile.map((p, i) => (
        <rect
          key={i}
          x={padL + i * step + (step - barW) / 2}
          y={y(p.dialogueShare)}
          width={barW}
          height={Math.max(1, padT + innerH - y(p.dialogueShare))}
          rx={1.5}
          className="la-dialogue-bar"
        >
          <title>{`${p.chapter} · ${p.dialogueShare}% ${t("la_dialogue").toLowerCase()}`}</title>
        </rect>
      ))}
      <line x1={padL} x2={W - padR} y1={y(overall)} y2={y(overall)} className="la-pace-avg" />
      <text x={W - padR} y={y(overall) - 4} className="la-pace-avg-label" textAnchor="end">
        {t("la_pace_average")} {Math.round(overall)}%
      </text>
      <text x={padL} y={padT - 3} className="la-pace-edge">
        {t("la_dialogue")}
      </text>
    </svg>
  );
}

/** A complete document: this panel's markup with the page's stylesheet
 *  inlined, so it draws the same anywhere — including a hidden window that
 *  exists only to print it. */
function reportDocument(root: HTMLElement, title: string): string {
  let css = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + "\n";
    } catch {
      // A cross-origin sheet cannot be read; the report does not depend on one.
    }
  }
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + esc(title) + "</title><style>" + css +
    "\nbody{background:#fff;margin:0;padding:0 8px;font-size:12px;color:#2a2419}" +
    ".la{padding:0}.la-toolbar{display:none}.la-details{display:none}.la-pace{break-inside:avoid}" +
    ".la-section{break-inside:avoid}h3.la-title{font-family:Georgia,serif;font-size:20px;margin:0 0 2px}" +
    "p.la-subtitle{margin:0 0 14px;color:#8b7355;font-size:12px}</style></head><body>" +
    "<h3 class=\"la-title\">" + esc(title) + "</h3>" + root.outerHTML + "</body></html>"
  );
}

export default function LanguageAnalysisPanel({
  report,
  lang,
  source,
}: {
  report: LanguageAnalysisReport;
  lang: Lang;
  /** The manuscript's name, for the export's title and file name. */
  source?: string;
}) {
  const t = useTranslation(lang);
  const n = (x: number) => x.toLocaleString(lang === "en" ? "en-GB" : lang);
  const aims = report.aims;
  const rootRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState<"idle" | "busy" | "saved" | "failed">("idle");

  // In the desktop app the main process prints a hidden copy and asks where
  // to save it. In a browser the fallback is the print dialog, where "Save as
  // PDF" is a printer on every platform.
  const exportPdf = async () => {
    const root = rootRef.current;
    if (!root) return;
    const title = `${t("mode_language_analysis")} — ${source ?? ""}`.replace(/ — $/, "");
    const bridge = (window as unknown as { bethaniel?: { exportPdf?: (h: string, n: string) => Promise<string | null> } }).bethaniel;
    if (!bridge?.exportPdf) {
      window.print();
      return;
    }
    setExporting("busy");
    try {
      const saved = await bridge.exportPdf(reportDocument(root, title), title);
      setExporting(saved ? "saved" : "idle");
    } catch {
      setExporting("failed");
    }
    setTimeout(() => setExporting("idle"), 2500);
  };

  const headline = (f: LanguageFinding) => ({
    title: fill(t(`la_h_${f.id}`), f.params),
    why: t(`la_h_${f.id}_why`),
  });

  // Green tick within range, red mark where worth a look, nothing where there
  // was nothing to judge. The verdicts come from the report, so the mark and
  // the headline list can never disagree.
  const Mark = ({ id }: { id: keyof LanguageAnalysisReport["sections"] }) => {
    const v = report.sections?.[id] ?? "na";
    if (v === "na") return null;
    const label = v === "ok" ? t("la_mark_ok") : t("la_mark_look");
    return (
      <span className={`la-mark la-mark-${v}`} title={label} aria-label={label}>
        {v === "ok" ? "✓" : "!"}
      </span>
    );
  };

  // The aim, under every heading, with the mark's verdict spelt out beside
  // it so a reader who cannot see colour still gets the answer.
  const Aim = ({ id, text }: { id: keyof LanguageAnalysisReport["sections"]; text: string }) => {
    const v = report.sections?.[id] ?? "na";
    return (
      <p className={`la-aim la-aim-${v}`}>
        {text}
        {v !== "na" && (
          <span className="la-aim-verdict">
            {" — "}
            {v === "ok" ? t("la_aim_met") : t("la_aim_not_met")}
          </span>
        )}
      </p>
    );
  };

  const crutch = report.overused.filter((o) => o.kind === "crutch");
  const frequent = report.overused.filter((o) => o.kind === "frequent");

  return (
    <div className="la" ref={rootRef}>
      <div className="la-toolbar">
        <button
          type="button"
          className="btn-secondary btn-small"
          onClick={() => void exportPdf()}
          disabled={exporting === "busy"}
        >
          {exporting === "busy"
            ? t("la_export_busy")
            : exporting === "saved"
              ? t("la_export_saved")
              : exporting === "failed"
                ? t("la_export_failed")
                : t("la_export_pdf")}
        </button>
      </div>
      <p className="la-scope small-note">
        {fill(t("la_scope"), {
          chapters: n(report.chaptersScanned),
          words: n(report.words),
          sentences: n(report.sentences),
        })}
        {" · "}
        {t("la_no_ai")}
      </p>

      {/* ── What to look at first ── */}
      <section className="la-section">
        <h4 className="la-h">{t("la_first")}</h4>
        {report.headlines.length === 0 ? (
          <p className="la-clean">
            <span className="la-mark la-mark-ok" aria-hidden="true">{"✓"}</span>
            {t("la_nothing_stands_out")}
          </p>
        ) : (
          <ol className="la-headlines">
            {report.headlines.map((f, i) => {
              const h = headline(f);
              return (
                <li key={i} className="la-headline">
                  <span className="la-headline-title">
                    <span className="la-mark la-mark-look" aria-hidden="true">!</span>
                    {h.title}
                  </span>
                  <span className="la-headline-why">{h.why}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ── Rhythm: the whole book ── */}
      <section className="la-section">
        <h4 className="la-h"><Mark id="rhythm" />{t("la_rhythm")}</h4>
        <Aim id="rhythm" text={fill(t("la_aim_rhythm"), { mean: aims.sentenceMean })} />
        <p className="la-stat">
          {fill(t("la_rhythm_summary"), {
            mean: report.rhythm.meanSentence,
            sd: report.rhythm.sd,
          })}
        </p>
        <PaceChart profile={report.rhythm.profile} average={report.rhythm.meanSentence} t={t} />
        <p className="la-hint">
          {fill(t("la_pace_guide"), { n: report.rhythm.windowSentences })}
        </p>
        <DialogueChart profile={report.rhythm.profile} t={t} />
        <p className="la-hint">{t("la_dialogue_guide")}</p>
        <details className="la-details">
          <summary>{t("la_per_chapter")}</summary>
          <table className="la-table la-pacing">
            <thead>
              <tr>
                <th>{t("la_chapter")}</th>
                <th className="la-num">{t("la_words")}</th>
                <th className="la-num" title={t("la_mean_sentence_tip")}>{t("la_mean_sentence")}</th>
                <th className="la-num" title={t("la_short_tip")}>{t("la_short")}</th>
                <th className="la-num" title={t("la_long_tip")}>{t("la_long")}</th>
                <th className="la-num">{t("la_dialogue")}</th>
              </tr>
            </thead>
            <tbody>
              {report.pacing.map((p) => (
                <tr key={p.chapter}>
                  <td className="la-word">{p.chapter}</td>
                  <td className="la-num la-muted">{n(p.words)}</td>
                  <td className="la-num">{p.meanSentence}</td>
                  <td className="la-num la-muted">{p.shortShare}%</td>
                  <td className="la-num la-muted">{p.longShare}%</td>
                  <td className="la-num la-muted">{p.dialogueShare}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <div className="la-grid">
        {/* ── Words ── */}
        <section className="la-section">
          <h4 className="la-h"><Mark id="overused" />{t("la_overused")}</h4>
          <Aim id="overused" text={fill(t("la_aim_overused"), { n: aims.crutchPerThousand })} />
          {crutch.length === 0 ? (
            <p className="la-clean">{t("la_overused_none")}</p>
          ) : (
            <table className="la-table">
              <tbody>
                {crutch.map((o) => (
                  <tr key={o.word} className={o.perThousand > aims.crutchPerThousand ? "la-row-look" : ""}>
                    <td className="la-word">{o.word}</td>
                    <td className="la-num">{n(o.count)}</td>
                    <td className="la-num la-muted">{o.perThousand} / 1k</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="la-hint">{t("la_overused_hint")}</p>

          <h5 className="la-sub">{t("la_frequent")}</h5>
          <p className="la-cloud">
            {frequent.map((o) => (
              <span key={o.word} className="la-chip" title={`${n(o.count)} · ${o.perThousand} / 1k`}>
                {o.word} <small>{n(o.count)}</small>
              </span>
            ))}
          </p>
        </section>

        {/* ── Adverbs and filter words ── */}
        <section className="la-section">
          <h4 className="la-h"><Mark id="adverbs" />{t("la_adverbs")}</h4>
          {report.adverbs.detected ? (
            <>
              <Aim id="adverbs" text={fill(t("la_aim_per_thousand"), { n: aims.adverbsPerThousand })} />
              <p className="la-stat">
                <strong>{report.adverbs.perThousand}</strong> {t("la_per_thousand")}
                <span className="la-muted"> · {n(report.adverbs.count)} {t("la_in_total")}</span>
              </p>
              <p className="la-cloud">
                {report.adverbs.top.map((o) => (
                  <span key={o.word} className="la-chip">
                    {o.word} <small>{n(o.count)}</small>
                  </span>
                ))}
              </p>
            </>
          ) : (
            <p className="la-clean">{t("la_adverbs_not_detected")}</p>
          )}
          <p className="la-hint">{t("la_adverbs_hint")}</p>

          <h5 className="la-sub"><Mark id="filter" />{t("la_filter")}</h5>
          <Aim id="filter" text={fill(t("la_aim_per_thousand"), { n: aims.filterPerThousand })} />
          <p className="la-stat">
            <strong>{report.filterWords.perThousand}</strong> {t("la_per_thousand")}
            <span className="la-muted"> · {n(report.filterWords.count)} {t("la_in_total")}</span>
          </p>
          {report.filterWords.top.length > 0 && (
            <p className="la-cloud">
              {report.filterWords.top.map((o) => (
                <span key={o.word} className="la-chip">
                  {o.word} <small>{n(o.count)}</small>
                </span>
              ))}
            </p>
          )}
          <p className="la-hint">{t("la_filter_hint")}</p>
        </section>

        {/* ── Openers ── */}
        <section className="la-section">
          <h4 className="la-h"><Mark id="openers" />{t("la_openers")}</h4>
          <Aim id="openers" text={fill(t("la_aim_openers"), { n: aims.openerShare })} />
          <table className="la-table">
            <tbody>
              {report.openers.slice(0, 6).map((o) => (
                <tr key={o.word} className={o.share > aims.openerShare ? "la-row-look" : ""}>
                  <td className="la-word">{o.word}</td>
                  <td className="la-num">{o.share}%</td>
                  <td className="la-bar-cell">
                    <span className="la-bar" style={{ width: `${Math.min(100, o.share * 2.5)}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.openerRuns.length > 0 && (
            <>
              <h5 className="la-sub">{t("la_opener_runs")}</h5>
              <ul className="la-list">
                {report.openerRuns.slice(0, 6).map((r, i) => (
                  <li key={i}>
                    <span className="la-word">{r.word}</span> ×{r.length}
                    <span className="la-muted"> · {r.chapter}</span>
                    <span className="la-excerpt">{r.excerpt}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="la-hint">{t("la_openers_hint")}</p>
        </section>

        {/* ── Echoes ── */}
        <section className="la-section">
          <h4 className="la-h"><Mark id="echoes" />{t("la_echoes")}</h4>
          <Aim id="echoes" text={fill(t("la_aim_echoes"), { n: aims.echoesPerThousand })} />
          {report.echoes.length === 0 ? (
            <p className="la-clean">{t("la_echoes_none")}</p>
          ) : (
            <ul className="la-list">
              {report.echoes.slice(0, 10).map((e, i) => (
                <li key={i}>
                  <span className="la-word">{e.word}</span>
                  <span className="la-muted"> · {fill(t("la_words_apart"), { n: e.distance })} · {e.chapter}</span>
                  <span className="la-excerpt">…{e.excerpt}…</span>
                </li>
              ))}
            </ul>
          )}
          <p className="la-hint">{t("la_echoes_hint")}</p>
        </section>

        {/* ── Dialogue tags ── */}
        <section className="la-section">
          <h4 className="la-h"><Mark id="tags" />{t("la_tags")}</h4>
          <Aim id="tags" text={fill(t("la_aim_tags"), { n: 100 - aims.tagsOtherShare })} />
          {report.dialogueTags.said + report.dialogueTags.otherCount === 0 ? (
            <p className="la-clean">{t("la_tags_none")}</p>
          ) : (
            <>
              <p className="la-stat">
                {fill(t("la_tags_summary"), {
                  said: n(report.dialogueTags.said),
                  other: n(report.dialogueTags.otherCount),
                })}
              </p>
              {report.dialogueTags.other.length > 0 && (
                <p className="la-cloud">
                  {report.dialogueTags.other.map((o) => (
                    <span key={o.word} className="la-chip">
                      {o.word} <small>{n(o.count)}</small>
                    </span>
                  ))}
                </p>
              )}
            </>
          )}
          <p className="la-hint">{t("la_tags_hint")}</p>
        </section>

        {/* ── Paragraphs ── */}
        <section className="la-section">
          <h4 className="la-h"><Mark id="paragraphs" />{t("la_paragraphs")}</h4>
          <Aim id="paragraphs" text={fill(t("la_aim_paragraphs"), { n: aims.longParagraphShare })} />
          <p className="la-stat">
            {fill(t("la_paragraphs_summary"), {
              count: n(report.paragraphs.count),
              mean: report.paragraphs.mean,
              longest: n(report.paragraphs.longest),
              over200: n(report.paragraphs.over200),
            })}
          </p>
          <p className="la-hint">{t("la_paragraphs_hint")}</p>
        </section>
      </div>
    </div>
  );
}
