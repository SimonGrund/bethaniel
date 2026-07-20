// ── StepBar — vertical setup rail in the sidebar (4 steps + run button) ──

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import type { WizardStep } from "../store";

const STEP_ORDER: WizardStep[] = ["model", "edits", "upload", "style"];

const STEP_META: Record<WizardStep, { num: number; nameKey: string; brief: string } | null> = {
  model: { num: 1, nameKey: "step_name_model", brief: "model_step_brief" },
  edits: { num: 2, nameKey: "step_name_edits", brief: "edits_step_brief" },
  upload: { num: 3, nameKey: "step_name_upload", brief: "upload_step_brief" },
  style: { num: 4, nameKey: "step_name_style", brief: "style_step_brief" },
  run: { num: 5, nameKey: "", brief: "run_step_brief" },
  done: null,
  folded: null,
};

export default function StepBar() {
  const {
    lang,
    wizardStep,
    setWizardStep,
    completedSteps,
    model,
    selectedModes,
    document,
    styleGuide,
    targetLang,
    apiModel,
    tasks,
  } = useStore();
  const t = useTranslation(lang);

  const hasRun = completedSteps.includes("run");
  const hasActiveTasks = Object.values(tasks).some(
    (t) => t.status === "queued" || t.status === "editing",
  );

  function modelLabel(): string {
    if (!model) return "";
    if (model.startsWith("custom:")) return `External: ${apiModel || "DeepSeek"}`;
    if (model.includes("Qwen3.5-4B")) return "Baby Betty";
    if (model.includes("Qwen3.5-9B")) return "Basic Betty";
    if (model.includes("Mistral")) return "Big Bad Betty";
    return model.replace(".gguf", "");
  }

  function editsLabel(): string {
    if (selectedModes.length === 0) return "";
    if (selectedModes.includes("translate")) return `${t("mode_translate")} → ${targetLang || "?"}`;
    return selectedModes
      .map((m) => t("mode_" + m))
      .join(" + ");
  }

  function uploadLabel(): string {
    if (!document) return "";
    const ch = document.chapters?.length ?? 0;
    return `${document.name} · ${ch} ch`;
  }

  function styleLabel(): string {
    if (!styleGuide) return t("skipped");
    return t("style_guide_provided");
  }

  function getLabel(step: WizardStep): string {
    switch (step) {
      case "model": return modelLabel();
      case "edits": return editsLabel();
      case "upload": return uploadLabel();
      case "style": return styleLabel();
      case "run": return hasActiveTasks ? t("working") : t("run_again");
      case "done":
      case "folded":
        return "";
    }
  }

  return (
    <div className="step-rail">
      {STEP_ORDER.map((step) => {
        const meta = STEP_META[step];
        const isCurrent = wizardStep === step;
        const isCompleted = completedSteps.includes(step);
        const label = getLabel(step);

        return (
          <button
            key={step}
            type="button"
            className={`step-card${isCurrent ? " step-card-current" : ""}${step === "model" ? " step-card-model" : ""}${!isCompleted ? " step-card-pending" : ""}`}
            onClick={() => setWizardStep(isCurrent ? "folded" : step)}
            title={t(meta?.brief ?? "")}
          >
            <span className="step-card-num">{meta?.num}</span>
            <span className="step-card-name">{t(meta?.nameKey ?? "")}</span>
            {label && <span className="step-card-label">{label}</span>}
            {isCompleted && <span className="step-card-check">✓</span>}
          </button>
        );
      })}

      {/* ── Run button — appears after first run ── */}
      {hasRun && (
        <button
          type="button"
          className={`btn-run-inline${hasActiveTasks ? " btn-run-launching" : ""}`}
          onClick={() => {
            if (hasActiveTasks) {
              // While a run is live this button is the route back to it.
              setWizardStep("folded");
              setTimeout(() => {
                window.document
                  .getElementById("current-run-header")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }, 80);
              return;
            }
            setWizardStep(wizardStep === "run" ? "folded" : "run");
          }}
        >
          {hasActiveTasks ? (
            <span className="btn-run-inline-spinner" />
          ) : (
            <img src="/logo-icon.svg" alt="" className="btn-run-inline-icon" />
          )}
          <span className="btn-run-inline-label">
            {hasActiveTasks ? t("view_current_run") : t("run_again")}
          </span>
        </button>
      )}
    </div>
  );
}
