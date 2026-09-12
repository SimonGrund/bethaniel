// ── LanguageAnalysisPanel — the counts, as a short report ──
//
// Leads with what to look at first: the handful of findings furthest past
// their thresholds, each as one sentence with the number in it and one line
// on why it matters. Everything else — the frequency tables, the rhythm per
// chapter, the echoes with their excerpts — sits below as evidence, because
// a table of forty numbers is not a report and nobody reads down to the
// interesting row.
//
// Every sentence here is phrased from the report's params so the same
// numbers read correctly in Danish, German and Spanish. The report itself
// carries no prose.

import { useTranslation } from "../i18n";
import type { Lang, LanguageAnalysisReport, LanguageFinding } from "../types";

function fill(s: string, params: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ""));
}

export default function LanguageAnalysisPanel({
  report,
  lang,
}: {
  report: LanguageAnalysisReport;
  lang: Lang;
}) {
  const t = useTranslation(lang);
  const n = (x: number) => x.toLocaleString(lang === "en" ? "en-GB" : lang);

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
        {v === "ok" ? "\u2713" : "!"}
      </span>
    );
  };

  const crutch = report.overused.filter((o) => o.kind === "crutch");
  const frequent = report.overused.filter((o) => o.kind === "frequent");
  const rhythmMax = Math.max(1, ...report.pacing.map((p) => p.meanSentence));

  return (
    <div className="la">
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
            <span className="la-mark la-mark-ok" aria-hidden="true">{"\u2713"}</span>
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

      <div className="la-grid">
        {/* ── Words ── */}
        <section className="la-section">
          <h4 className="la-h"><Mark id="overused" />{t("la_overused")}</h4>
          {crutch.length === 0 ? (
            <p className="la-clean">{t("la_overused_none")}</p>
          ) : (
            <table className="la-table">
              <tbody>
                {crutch.map((o) => (
                  <tr key={o.word}>
                    <td className="la-word">{o.word}</td>
                    <td className="la-num">{n(o.count)}</td>
                    <td className="la-num la-muted">{o.perThousand} / 1k</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="la-hint small-note">{t("la_overused_hint")}</p>

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
          <p className="la-hint small-note">{t("la_adverbs_hint")}</p>

          <h5 className="la-sub"><Mark id="filter" />{t("la_filter")}</h5>
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
          <p className="la-hint small-note">{t("la_filter_hint")}</p>
        </section>

        {/* ── Openers ── */}
        <section className="la-section">
          <h4 className="la-h"><Mark id="openers" />{t("la_openers")}</h4>
          <table className="la-table">
            <tbody>
              {report.openers.slice(0, 6).map((o) => (
                <tr key={o.word}>
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
          <p className="la-hint small-note">{t("la_openers_hint")}</p>
        </section>

        {/* ── Echoes ── */}
        <section className="la-section">
          <h4 className="la-h"><Mark id="echoes" />{t("la_echoes")}</h4>
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
          <p className="la-hint small-note">{t("la_echoes_hint")}</p>
        </section>
      </div>

      {/* ── Rhythm, by chapter ── */}
      <section className="la-section">
        <h4 className="la-h"><Mark id="rhythm" />{t("la_rhythm")}</h4>
        <p className="la-stat">
          {fill(t("la_rhythm_summary"), {
            mean: report.rhythm.meanSentence,
            sd: report.rhythm.sd,
          })}
        </p>
        <table className="la-table la-pacing">
          <thead>
            <tr>
              <th>{t("la_chapter")}</th>
              <th className="la-num">{t("la_words")}</th>
              <th className="la-num" title={t("la_mean_sentence_tip")}>{t("la_mean_sentence")}</th>
              <th className="la-bar-cell" />
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
                <td className="la-bar-cell">
                  <span className="la-bar" style={{ width: `${(p.meanSentence / rhythmMax) * 100}%` }} />
                </td>
                <td className="la-num la-muted">{p.shortShare}%</td>
                <td className="la-num la-muted">{p.longShare}%</td>
                <td className="la-num la-muted">{p.dialogueShare}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="la-hint small-note">{t("la_rhythm_hint")}</p>
      </section>

      {/* ── Dialogue tags and paragraphs ── */}
      <div className="la-grid">
        <section className="la-section">
          <h4 className="la-h"><Mark id="tags" />{t("la_tags")}</h4>
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
          <p className="la-hint small-note">{t("la_tags_hint")}</p>
        </section>

        <section className="la-section">
          <h4 className="la-h"><Mark id="paragraphs" />{t("la_paragraphs")}</h4>
          <p className="la-stat">
            {fill(t("la_paragraphs_summary"), {
              count: n(report.paragraphs.count),
              mean: report.paragraphs.mean,
              longest: n(report.paragraphs.longest),
              over200: n(report.paragraphs.over200),
            })}
          </p>
          <p className="la-hint small-note">{t("la_paragraphs_hint")}</p>
        </section>
      </div>
    </div>
  );
}
