// ── Sidebar — queue panel ──

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import QueuePanel from "./QueuePanel";

export default function Sidebar() {
  const { lang } = useStore();
  const t = useTranslation(lang);

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <img src="/logo-icon.svg" alt="Bethaniel" />
      </div>

      <div className="sidebar-section sidebar-queue">
        <QueuePanel />
      </div>
    </aside>
  );
}
