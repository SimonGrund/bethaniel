// ── A translation of a linked Scrivener project, into a copy ──
//
// A Scrivener project is exported back into Scrivener, never to Word or
// EPUB. An edit writes back into the project itself (ScrivenerWriteBack); a
// translation replaces every paragraph, so it goes into a copy beside it —
// "Novel (French).scriv" — and the author's project is only read
// (backend/src/scrivener.ts, translateIntoCopy).

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import {
  scrivenerStatus,
  scrivenerTranslateCopy,
  ScrivenerRefusal,
  type ScrivenerTranslationCopyReport,
} from "../api";
import Modal from "./Modal";
import { LinkIcon } from "./ManuscriptUpload";

type Pairs = { original: string; edited: string }[];

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "confirm"; projectName: string; pairs: Pairs }
  | { kind: "writing" }
  | { kind: "done"; report: ScrivenerTranslationCopyReport }
  | { kind: "refused"; message: string; detail?: string[] };

export default function ScrivenerTranslationCopy({
  docId,
  language,
  getPairs,
  disabled,
}: {
  docId: string;
  /** The target language's name, for the copy's name: "Novel (French)". */
  language: string;
  getPairs: () => Promise<Pairs | null>;
  disabled?: boolean;
}) {
  const lang = useStore((s) => s.lang);
  const t = useTranslation(lang);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const close = () => setPhase({ kind: "idle" });
  const refuse = (err: unknown) =>
    setPhase(
      err instanceof ScrivenerRefusal
        ? { kind: "refused", message: err.message, detail: err.detail }
        : { kind: "refused", message: err instanceof Error ? err.message : String(err) },
    );

  const start = async () => {
    setPhase({ kind: "checking" });
    try {
      const pairs = await getPairs();
      if (!pairs) return close();
      const status = await scrivenerStatus(docId);
      if (status.open) {
        setPhase({ kind: "refused", message: t("scriv_tc_open") });
        return;
      }
      setPhase({ kind: "confirm", projectName: status.projectName ?? "", pairs });
    } catch (err) {
      refuse(err);
    }
  };

  const write = async (pairs: Pairs) => {
    setPhase({ kind: "writing" });
    try {
      setPhase({ kind: "done", report: await scrivenerTranslateCopy(docId, pairs, language) });
    } catch (err) {
      refuse(err);
    }
  };

  const busy = phase.kind === "checking" || phase.kind === "writing";
  return (
    <>
      <button
        type="button"
        className="btn-primary scriv-wb-btn"
        disabled={disabled || busy}
        onClick={() => void start()}
        title={t("scriv_tc_tip")}
      >
        {busy ? <span className="btn-spinner" aria-hidden /> : <LinkIcon />}
        {busy && phase.kind === "writing" ? t("scriv_tc_writing") : t("scriv_tc_btn")}
        <span className="beta-tag">{t("scriv_beta")}</span>
      </button>

      <Modal
        open={phase.kind === "confirm" || phase.kind === "done" || phase.kind === "refused"}
        onClose={close}
        labelledBy="scriv-tc-title"
        className="scriv-wb-dialog"
      >
        {phase.kind === "confirm" && (
          <>
            <h2 id="scriv-tc-title" className="dialog-title">
              {t("scriv_tc_confirm_title")}
            </h2>
            <p className="scriv-wb-lead">
              {t("scriv_tc_plan")
                .replace("{project}", phase.projectName)
                .replace("{copy}", `${phase.projectName} (${language})`)}
            </p>
            <ul className="scriv-wb-risks">
              <li className="scriv-wb-risk-strong">{t("scriv_beta_note")}</li>
              <li>{t("scriv_tc_untouched")}</li>
              <li>{t("scriv_wb_risk_closed")}</li>
            </ul>
            <div className="model-confirm-actions">
              <button type="button" className="btn-secondary" onClick={close}>
                {t("btn_cancel", "Cancel")}
              </button>
              <button type="button" className="btn-primary" onClick={() => void write(phase.pairs)}>
                {t("scriv_tc_go")}
              </button>
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <h2 id="scriv-tc-title" className="dialog-title">
              {t("scriv_tc_done_title")}
            </h2>
            <p className="scriv-wb-lead">
              {t("scriv_tc_done").replace("{n}", String(phase.report.paragraphs))}
            </p>
            <p>
              <code className="scriv-wb-path">{phase.report.projectDir}</code>
            </p>
            {phase.report.flattened > 0 && (
              <p className="small-note">
                {t("scriv_tc_flattened").replace("{n}", String(phase.report.flattened))}
              </p>
            )}
            {phase.report.untranslated > 0 && (
              <p className="small-note">
                {t("scriv_tc_untranslated").replace("{n}", String(phase.report.untranslated))}
              </p>
            )}
            {phase.report.toCheck.length > 0 && (
              <>
                <p className="scriv-wb-sub">
                  {t("scriv_tc_check").replace("{n}", String(phase.report.toCheck.length))}
                </p>
                <ul className="scriv-wb-skipped">
                  {phase.report.toCheck.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="small-note">{t("scriv_tc_done_next")}</p>
            <div className="model-confirm-actions">
              <button type="button" className="btn-primary" onClick={close}>
                {t("btn_close")}
              </button>
            </div>
          </>
        )}

        {phase.kind === "refused" && (
          <>
            <h2 id="scriv-tc-title" className="dialog-title">
              {t("scriv_wb_refused_title")}
            </h2>
            <p>{phase.message}</p>
            {phase.detail && phase.detail.length > 0 && (
              <ul className="scriv-wb-skipped">
                {phase.detail.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            <p className="small-note">{t("scriv_wb_refused_safe")}</p>
            <div className="model-confirm-actions">
              <button type="button" className="btn-primary" onClick={close}>
                {t("btn_close")}
              </button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
