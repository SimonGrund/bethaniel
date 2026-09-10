// ── WelcomeModal — one greeting, once ──
//
// This replaces a five-stop coachmark tour that spotlighted cards in the
// sidebar rail. The rail no longer carries those cards, so the tour had
// become a sequence of arrows pointing at nothing — but the deeper problem is
// that a layout needing a guided walk is a layout that has not explained
// itself. The setup page now shows all of its steps at once, each named, in
// order, with the next thing to press at the bottom of each card.
//
// So: a hello, what Betty is, and out of the way. No steps, no spotlight, and
// nothing to replay — a welcome worth reading twice would be a symptom.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import Modal from "./Modal";

export default function WelcomeModal() {
  const lang = useStore((s) => s.lang);
  const open = useStore((s) => s.introOpen);
  const setOpen = useStore((s) => s.setIntroOpen);
  const setHasSeenIntro = useStore((s) => s.setHasSeenIntro);
  const t = useTranslation(lang);

  const close = () => {
    setOpen(false);
    setHasSeenIntro(true);
  };

  return (
    <Modal
      open={open}
      onClose={close}
      labelledBy="welcome-title"
      className="welcome-dialog"
    >
      <img src="/logo-icon.svg" alt="" className="welcome-mark" />
      <h2 id="welcome-title" className="welcome-title">
        {t("intro_welcome_title")}
      </h2>
      <p className="welcome-body">
        {t(
          "welcome_body",
          "I read manuscripts and suggest corrections — spelling, grammar, phrasing. You decide which ones to keep; nothing changes in your text unless you say so.",
        )}
      </p>
      <p className="welcome-body welcome-body--quiet">
        {t(
          "welcome_steps",
          "Add your manuscript, choose what you want done, and press run. Everything happens on this computer.",
        )}
      </p>
      <div className="welcome-actions">
        <button type="button" className="btn-primary" onClick={close}>
          {t("welcome_start", "Let's go")}
        </button>
      </div>
    </Modal>
  );
}
