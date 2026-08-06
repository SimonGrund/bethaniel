// ── StepBar — vertical setup rail in the sidebar (4 steps + run button) ──

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { modeLabelKeys } from "../types";
import type { WizardStep } from "../store";

const STEP_ORDER: WizardStep[] = ["upload", "edits", "model", "style"];

const STEP_META: Record<WizardStep, { num: number; nameKey: string; brief: string } | null> = {
  upload: { num: 1, nameKey: "step_name_upload", brief: "upload_step_brief" },
  edits: { num: 2, nameKey: "step_name_edits", brief: "edits_step_brief" },
  model: { num: 3, nameKey: "step_name_model", brief: "model_step_brief" },
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
    return modeLabelKeys(selectedModes)
      .map((k) => t(k))
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

  // The first not-yet-completed step — highlighted to guide the user forward.
  const nextStep = STEP_ORDER.find((s) => !completedSteps.includes(s));

  return (
    <div className="step-rail">
      {STEP_ORDER.map((step) => {
        const meta = STEP_META[step];
        const isCurrent = wizardStep === step;
        const isCompleted = completedSteps.includes(step);
        const isNext = step === nextStep && !isCurrent;
        const label = getLabel(step);

        return (
          <button
            key={step}
            type="button"
            data-tour={step}
            className={`step-card${isCurrent ? " step-card-current" : ""}${step === "model" ? " step-card-model" : ""}${isNext ? " step-card-next" : ""}`}
            onClick={() => setWizardStep(isCurrent ? "folded" : step)}
          >
            <span className="step-card-num">{meta?.num}</span>
            <span className="step-card-name">{t(meta?.nameKey ?? "")}</span>
            {label && <span className="step-card-label">{label}</span>}
            {isCompleted && <span className="step-card-check">✓</span>}
          </button>
        );
      })}
    </div>
  );
}
