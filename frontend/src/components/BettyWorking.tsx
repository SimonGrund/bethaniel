// ── "Betty is working" animation badge ──
// Doubles as the always-available route back to the current-run view: from
// any wizard step or the Former Runs view, clicking it folds the wizard and
// scrolls the run header card into view.

import { useStore } from "../store";
import { useTranslation } from "../i18n";

export default function BettyWorking() {
  const { lang, tasks, setWizardStep } = useStore();
  const t = useTranslation(lang);

  const isWorking = Object.values(tasks).some(
    (task) => task.status === "editing",
  );

  if (!isWorking) return null;

  return (
    <button
      type="button"
      className="betty-working betty-working-btn"
      title={t("betty_working_go")}
      aria-label={t("betty_working_go")}
      onClick={() => {
        setWizardStep("folded");
        // Let the run panel mount first when coming from the Former Runs view.
        setTimeout(() => {
          document
            .getElementById("current-run-header")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 80);
      }}
    >
      <img src="/logo-icon.svg" alt="" className="betty-working-icon" />
      <span className="betty-working-text">
        {t("betty_working")}
        <span className="betty-working-dots" />
      </span>
    </button>
  );
}
