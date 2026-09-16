// ── "I want to…" — four cards, and almost nothing to configure ──
//
// This file used to carry a Settings dialog for the selected card. It is gone,
// and with it the fifteen copy- and line-edit checkboxes: every Edit run is
// now copy + line with the options at their defaults, which is what all but a
// handful of authors would have chosen anyway and what the rest were being
// asked to confirm on the way to their first run. The preference is still in
// the store (`lineEditEnabled`), unread, so restoring the toggle later costs
// nothing.
//
// Translation's one real question — where to — is the only setting any card
// still has, and it is now in the card itself rather than two clicks away
// behind a button labelled Settings.
//
// The manuscript's own settings (language, dialect, commas), the scope and the
// style sheet all live on the manuscript column opposite, each behind its own
// flag. Nothing about the task belongs there and nothing about the manuscript
// belongs here.

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { FRONT_CARD_MODES, frontCardFor } from "../types";
import type { FrontCard } from "../types";
import {
  TRANSLATION_LANGUAGES,
  OTHER_LANGUAGE,
  isListedLanguage,
} from "../translationLanguages";
import CodeBalanceNote from "./CodeBalanceNote";

const CARDS: { id: FrontCard; titleKey: string; descKey?: string }[] = [
  { id: "edit", titleKey: "card_edit_title", descKey: "card_edit_desc" },
  {
    id: "readthrough",
    titleKey: "card_readthrough_title",
    descKey: "card_readthrough_desc",
  },
  {
    id: "translate",
    titleKey: "card_translate_title",
    descKey: "card_translate_desc",
  },
  // The title says it all; a line under it only made this card taller than
  // the three beside it.
  { id: "language", titleKey: "card_language_title" },
];

export default function ModeSelector() {
  const {
    lang,
    selectedModes,
    setSelectedModes,
    targetLang,
    setTargetLang,
    markStepComplete,
  } = useStore();
  const t = useTranslation(lang);

  const activeCard = frontCardFor(selectedModes);
  // Choosing "Other…" clears the target, so the choice cannot be recovered
  // from the value alone — an empty target means both "picked Other, still
  // typing" and "nothing picked yet", and reading it as the latter left the
  // author with a dead end where the text box should have been. The choice is
  // therefore remembered; a target that survived from a previous session opens
  // the box on its own account.
  const [choseOther, setChoseOther] = useState(false);
  const freeText =
    choseOther || (targetLang.trim() !== "" && !isListedLanguage(targetLang));
  const translateNeedsTarget =
    activeCard === "translate" && !targetLang.trim();

  function selectCard(id: FrontCard) {
    // Always the card's full mode set. The Edit card no longer consults the
    // remembered line-edit preference, because there is no longer a control
    // that could have set it.
    setSelectedModes([...FRONT_CARD_MODES[id]]);
    markStepComplete("edits");
  }

  function pickLanguage(value: string) {
    // The sentinel must never reach targetLang — the prompt would ask for a
    // translation into "other". It clears the field and opens the text box.
    const other = value === OTHER_LANGUAGE;
    setChoseOther(other);
    setTargetLang(other ? "" : value);
    markStepComplete("edits");
  }

  return (
    <section className="mode-selector">
      <div className="task-cards">
        {CARDS.map((card) => (
          // The card is a container, not a button: the Translate card holds a
          // <select>, and interactive content nested inside a <button> is
          // invalid HTML that browsers handle inconsistently — clicks on the
          // dropdown can never be relied on to reach it. The pick button fills
          // the card, so everything except the control still selects.
          <div
            key={card.id}
            className={`task-card${activeCard === card.id ? " task-card-active" : ""}${
              card.id === "translate" && translateNeedsTarget
                ? " task-card-attention"
                : ""
            }`}
          >
            <button
              type="button"
              className="task-card-pick"
              aria-pressed={activeCard === card.id}
              onClick={() => selectCard(card.id)}
            >
              <span className="task-card-title">{t(card.titleKey)}</span>
              {card.descKey && (
                <span className="task-card-desc">{t(card.descKey)}</span>
              )}
              {/* What the author's code can pay for on THIS card. Silent on
                  the cards it cannot, so a readthrough-only code does not
                  have to apologise on the other three. */}
              <CodeBalanceNote card={card.id} />
            </button>

            {/* The one setting any card still has, in the card it belongs to
                rather than two clicks away behind a button labelled Settings.

                Always rendered, not only while the card is selected: shown on
                selection it made the card grow under the cursor that had just
                clicked it, and with grid-auto-rows: 1fr the other three grew
                with it. A card that changes size when you click it moves
                whatever you were about to click next. */}
            {card.id === "translate" && (
              <span className="task-card-control">
                <label className="translate-lang">
                  <span className="translate-lang-label">
                    {t("target_language")}
                  </span>
                  <select
                    className="translate-lang-select"
                    value={freeText ? OTHER_LANGUAGE : targetLang}
                    onChange={(e) => pickLanguage(e.target.value)}
                  >
                    <option value="" disabled>
                      {t("target_language_pick")}
                    </option>
                    {TRANSLATION_LANGUAGES.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                    <option value={OTHER_LANGUAGE}>
                      {t("target_language_other")}
                    </option>
                  </select>
                </label>
                {freeText && (
                  <input
                    type="text"
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    placeholder={t("target_language_placeholder")}
                    className="lang-input"
                    aria-label={t("target_language")}
                  />
                )}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
