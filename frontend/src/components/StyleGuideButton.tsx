// ── The style guide, behind one button ──
//
// It used to be a whole step of the setup flow, which put a blank textarea in
// front of every author on the way to their first run — an optional question
// wearing the same clothes as the required ones. It is now a single button in
// the task column, offered only for runs that actually read one (see
// styleGuideApplies in types.ts), and the sheet itself opens in a dialog.
//
// The button doubles as the status, so the state is readable without opening
// it: "Recommended" while empty, a word count once filled in. That is also why
// it is not a checkbox — there is nothing to toggle, only something to write.

import { useState } from "react";

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import Modal from "./Modal";
import StyleGuideEditor from "./StyleGuideEditor";

export default function StyleGuideButton() {
  const lang = useStore((s) => s.lang);
  const styleGuide = useStore((s) => s.styleGuide);
  const t = useTranslation(lang);
  const [open, setOpen] = useState(false);

  const words = styleGuide.trim() ? styleGuide.trim().split(/\s+/).length : 0;
  const filled = words > 0;

  return (
    <>
      <button
        type="button"
        className={`styleguide-cta${filled ? " styleguide-cta-filled" : ""}`}
        onClick={() => setOpen(true)}
      >
        <span className="styleguide-cta-mark" aria-hidden="true">
          {filled ? "✓" : "★"}
        </span>
        <span className="styleguide-cta-body">
          <span className="styleguide-cta-title">
            {t("style_guide")}
            <span className="styleguide-cta-tag">
              {filled
                ? t("styleguide_cta_words").replace("{n}", String(words))
                : t("styleguide_cta_recommended")}
            </span>
          </span>
          <span className="styleguide-cta-hint">
            {filled ? t("styleguide_cta_edit") : t("styleguide_cta_blurb")}
          </span>
        </span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        labelledBy="styleguide-dialog-title"
        className="styleguide-dialog"
      >
        <h2 id="styleguide-dialog-title" className="dialog-title">
          {t("style_guide")}
        </h2>
        {/* Guidance first: the commonest reason a style guide is left empty is
            not knowing what belongs in one. */}
        <p className="dialog-intro">{t("styleguide_guidance")}</p>
        <ul className="dialog-list">
          <li>{t("styleguide_guidance_names")}</li>
          <li>{t("styleguide_guidance_terms")}</li>
          <li>{t("styleguide_guidance_style")}</li>
        </ul>
        <StyleGuideEditor onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}
