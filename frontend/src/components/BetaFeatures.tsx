// ── Experimental task modes ──
//
// Everything Betty can do that is not one of the three paid passes. Kept in
// its own file on purpose: the front card set in ModeSelector is the paid
// product, and this drawer is where new work lands before it earns a card.
// One file holds what we sell, this one holds what we are still testing.

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { BETA_GROUPS, betaGroupFor } from "../types";
import type { BetaGroup, BetaGroupId, TaskMode } from "../types";

export default function BetaFeatures() {
  const lang = useStore((s) => s.lang);
  const selectedModes = useStore((s) => s.selectedModes);
  const setSelectedModes = useStore((s) => s.setSelectedModes);
  const markStepComplete = useStore((s) => s.markStepComplete);
  const t = useTranslation(lang);

  // Open when the saved selection already lives in here, so an existing
  // developmental-edit or analysis user does not find their choice hidden.
  const [open, setOpen] = useState(() => betaGroupFor(selectedModes) !== null);

  const activeGroup = betaGroupFor(selectedModes);

  function selectGroup(id: BetaGroupId) {
    const group = BETA_GROUPS.find((g) => g.id === id);
    if (!group) return;
    // Selection is one intent: picking a Beta group replaces the front-card
    // selection entirely, exactly as picking a card clears this.
    setSelectedModes([...group.modes]);
    markStepComplete("edits");
  }

  function toggleMode(mode: TaskMode, group: BetaGroup) {
    if (group.exclusive) {
      selectGroup(group.id);
      return;
    }
    const withinGroup = selectedModes.filter((m) => group.modes.includes(m));
    const next = withinGroup.includes(mode)
      ? withinGroup.filter((m) => m !== mode)
      : [...withinGroup, mode];
    // Never leave the panel with nothing selected — mirrors toggleMode in
    // the store and the old selector's toggleEditingChoice.
    if (next.length === 0) return;
    // Keep declaration order regardless of click order.
    setSelectedModes(group.modes.filter((m) => next.includes(m)));
    markStepComplete("edits");
  }

  return (
    <section className="beta-features">
      <button
        type="button"
        className={`beta-disclosure${open ? " beta-disclosure-open" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="beta-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        {t("beta_disclosure")}
        {activeGroup && !open && (
          <span className="beta-active-badge">
            {t(`beta_group_${activeGroup}`)}
          </span>
        )}
      </button>

      {open && (
        <div className="beta-panel">
          <p className="beta-hint">{t("beta_disclosure_hint")}</p>
          {BETA_GROUPS.map((group) => (
            <div key={group.id} className="beta-group">
              <span className="beta-group-name">
                {t(`beta_group_${group.id}`)}
              </span>
              <div className="beta-group-modes">
                {group.modes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`mode-tab${selectedModes.includes(mode) ? " active" : ""}`}
                    onClick={() => toggleMode(mode, group)}
                  >
                    {t(`mode_${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
