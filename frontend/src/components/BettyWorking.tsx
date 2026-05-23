// ── "Betty is working" animation badge ──

import { useStore } from "../store";
import { useTranslation } from "../i18n";

export default function BettyWorking() {
  const { lang, tasks } = useStore();
  const t = useTranslation(lang);

  const isWorking = Object.values(tasks).some(
    (task) => task.status === "editing",
  );

  if (!isWorking) return null;

  return (
    <div className="betty-working">
      <img src="/logo-icon.svg" alt="" className="betty-working-icon" />
      <span className="betty-working-text">
        {t("betty_working")}
        <span className="betty-working-dots" />
      </span>
    </div>
  );
}
