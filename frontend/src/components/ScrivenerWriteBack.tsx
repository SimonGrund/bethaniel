// ── Write back to Scrivener ──
//
// The one step in Bethaniel that changes a file another app owns, so it is
// slow on purpose: check, show exactly what will happen and what could go
// wrong, wait for a yes, copy the whole project, then write. The checks and
// the copy are the backend's (backend/src/scrivener.ts) and cannot be skipped
// from here; this says them out loud before they happen.

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import {
  scrivenerStatus,
  scrivenerWriteBack,
  ScrivenerRefusal,
  type ScrivenerStatus,
  type ScrivenerWriteBackReport,
} from "../api";
import Modal from "./Modal";
import { LinkIcon } from "./ManuscriptUpload";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "confirm"; status: ScrivenerStatus; plan: ScrivenerWriteBackReport; pairs: Pairs }
  | { kind: "writing" }
  | { kind: "done"; report: ScrivenerWriteBackReport; status: ScrivenerStatus }
  | { kind: "refused"; message: string; detail?: string[] };

type Pairs = { original: string; edited: string }[];

export default function ScrivenerWriteBack({
  docId,
  getPairs,
  disabled,
  className = "btn-primary btn-small",
}: {
  docId: string;
  /** The reviewed chapters, as the export builds them; null if abandoned. */
  getPairs: () => Promise<Pairs | null>;
  disabled?: boolean;
  className?: string;
}) {
  const lang = useStore((s) => s.lang);
  const t = useTranslation(lang);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const close = () => setPhase({ kind: "idle" });

  const refuse = (err: unknown) => {
    if (err instanceof ScrivenerRefusal) setPhase({ kind: "refused", message: err.message, detail: err.detail });
    else setPhase({ kind: "refused", message: err instanceof Error ? err.message : String(err) });
  };

  const start = async () => {
    setPhase({ kind: "checking" });
    try {
      const pairs = await getPairs();
      if (!pairs) return close();
      const status = await scrivenerStatus(docId);
      if (status.open) {
        setPhase({ kind: "refused", message: t("scriv_wb_open") });
        return;
      }
      // A dry run: every check, every change planned, nothing written.
      const plan = await scrivenerWriteBack(docId, pairs, true);
      setPhase({ kind: "confirm", status, plan, pairs });
    } catch (err) {
      refuse(err);
    }
  };

  const write = async (pairs: Pairs) => {
    setPhase({ kind: "writing" });
    try {
      const report = await scrivenerWriteBack(docId, pairs, false);
      setPhase({ kind: "done", report, status: await scrivenerStatus(docId) });
    } catch (err) {
      refuse(err);
    }
  };

  const skippedList = (report: ScrivenerWriteBackReport) =>
    report.skipped.length > 0 && (
      <>
        <p className="scriv-wb-sub">
          {t("scriv_wb_skipped").replace("{n}", String(report.skipped.length))}
        </p>
        <ul className="scriv-wb-skipped">
          {report.skipped.map((s, i) => (
            <li key={i}>
              <span className="scriv-wb-scene">{s.scene}</span> “{s.original}” → “{s.replacement}”
            </li>
          ))}
        </ul>
      </>
    );

  const busy = phase.kind === "checking" || phase.kind === "writing";
  return (
    <>
      <button
        type="button"
        className={`${className} scriv-wb-btn`}
        disabled={disabled || busy}
        onClick={() => void start()}
        title={t("scriv_wb_tip")}
      >
        {busy ? <span className="btn-spinner" aria-hidden /> : <LinkIcon />}
        {t("scriv_wb_btn")}
      </button>

      <Modal
        open={phase.kind === "confirm" || phase.kind === "done" || phase.kind === "refused"}
        onClose={close}
        labelledBy="scriv-wb-title"
        className="scriv-wb-dialog"
      >
        {phase.kind === "confirm" && (
          <>
            <h2 id="scriv-wb-title" className="dialog-title">
              {t("scriv_wb_confirm_title").replace("{project}", phase.status.projectName ?? "")}
            </h2>
            {phase.plan.applied === 0 ? (
              <p>{t("scriv_wb_nothing")}</p>
            ) : (
              <p className="scriv-wb-lead">
                {t("scriv_wb_plan")
                  .replace("{n}", String(phase.plan.applied))
                  .replace("{scenes}", String(new Set(phase.plan.scenesChanged).size))}
              </p>
            )}
            {/* Every risk, said before it is taken. */}
            <ul className="scriv-wb-risks">
              <li>{t("scriv_wb_risk_backup").replace("{folder}", `${phase.status.projectName} - Betty backups`)}</li>
              <li>{t("scriv_wb_risk_closed")}</li>
              {phase.status.synced && <li className="scriv-wb-risk-strong">{t("scriv_wb_risk_synced")}</li>}
              <li>{t("scriv_wb_risk_untracked")}</li>
            </ul>
            {skippedList(phase.plan)}
            {phase.plan.unmapped > 0 && (
              <p className="small-note">{t("scriv_wb_unmapped").replace("{n}", String(phase.plan.unmapped))}</p>
            )}
            <div className="model-confirm-actions">
              <button type="button" className="btn-secondary" onClick={close}>
                {t("btn_cancel", "Cancel")}
              </button>
              {phase.plan.applied > 0 && (
                <button type="button" className="btn-primary" onClick={() => void write(phase.pairs)}>
                  {t("scriv_wb_go").replace("{n}", String(phase.plan.applied))}
                </button>
              )}
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <h2 id="scriv-wb-title" className="dialog-title">
              {t("scriv_wb_done_title")}
            </h2>
            <p className="scriv-wb-lead">
              {t("scriv_wb_done")
                .replace("{n}", String(phase.report.applied))
                .replace("{project}", phase.status.projectName ?? "")}
            </p>
            {phase.report.backupDir && (
              <p>
                {t("scriv_wb_done_backup")}
                <br />
                <code className="scriv-wb-path">{phase.report.backupDir}</code>
              </p>
            )}
            {skippedList(phase.report)}
            <p className="small-note">{t("scriv_wb_done_next")}</p>
            <div className="model-confirm-actions">
              <button type="button" className="btn-primary" onClick={close}>
                {t("btn_close")}
              </button>
            </div>
          </>
        )}

        {phase.kind === "refused" && (
          <>
            <h2 id="scriv-wb-title" className="dialog-title">
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
