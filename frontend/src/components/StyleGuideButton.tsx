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
import LexiconPanel from "./LexiconPanel";

export default function StyleGuideButton() {
  const lang = useStore((s) => s.lang);
  const styleGuide = useStore((s) => s.styleGuide);
  const lexicon = useStore((s) => s.lexicon);
  const t = useTranslation(lang);
  const [open, setOpen] = useState(false);

  const words = styleGuide.trim() ? styleGuide.trim().split(/\s+/).length : 0;
  const filled = words > 0;
  // The harvested list changes what the button has to say: found and not
  // yet looked at, it asks; looked at, it reports what is protected.
  const termCount = lexicon?.terms.length ?? 0;
  const protectedCount = lexicon?.terms.filter((x) => x.enabled).length ?? 0;
  const lexiconPending = termCount > 0 && !lexicon?.reviewedAt;
  const lexiconDone = termCount > 0 && !!lexicon?.reviewedAt;
  const done = filled || lexiconDone;
  // One flag vocabulary across the manuscript column: green when nothing is
  // waiting, orange when something is. A style sheet is optional, so an empty
  // one is NOT orange — nobody is waiting on it, and the hint says
  // "recommended" in words. Terms Betty harvested and the author has not
  // looked at are the one thing here that is genuinely waiting.
  const status: "clean" | "attention" = lexiconPending ? "attention" : "clean";
  const tag = lexiconPending
    ? t("lexicon_cta_found").replace("{n}", String(termCount))
    : [
        lexiconDone ? t("lexicon_cta_protected").replace("{n}", String(protectedCount)) : null,
        filled ? t("styleguide_cta_words").replace("{n}", String(words)) : null,
      ]
        .filter(Boolean)
        .join(" · ") || t("styleguide_cta_recommended");
  const hint = lexiconPending
    ? t("lexicon_cta_hint")
    : done
      ? t("styleguide_cta_edit")
      : t("styleguide_cta_blurb");

  return (
    <>
      <button
        type="button"
        className={`styleguide-cta styleguide-cta-${status}${done ? " styleguide-cta-filled" : ""}`}
        onClick={() => setOpen(true)}
      >
        <span
          className={`styleguide-cta-mark fold-icon-${status}`}
          aria-hidden="true"
        >
          {status === "attention" ? "⚠" : "✓"}
        </span>
        <span className="styleguide-cta-body">
          <span className="styleguide-cta-title">
            {t("style_guide")}
            <span className="styleguide-cta-tag">{tag}</span>
          </span>
          <span className="styleguide-cta-hint">{hint}</span>
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
        {/* What Betty found first, then what the author wants to add: the
            list covers the first two bullets above for most books. */}
        <LexiconPanel />
        <h3 className="lexicon-title lexicon-sheet-title">{t("styleguide_freetext_title")}</h3>
        <StyleGuideEditor onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}
