// ── OnboardingGuide — first-run coachmark tour ──
// A dimmed-spotlight overlay that walks new users through the setup rail:
// a welcome bubble, then an arrow + speech bubble hopping between each
// sidebar step card (Upload → Edits → Model → Style) and the Run button.

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";

type TourStop =
  | { kind: "welcome" }
  | { kind: "anchor"; target: string; textKey: string };

/**
 * Tour stops in rail order.
 *
 * The model stop only exists in advanced mode: outside it there is no
 * `data-tour="model"` card to spotlight, and the tour would point an arrow at
 * nothing. Everyone else gets the run-mode slider instead, which is the choice
 * they actually have.
 */
function buildStops(advancedMode: boolean): TourStop[] {
  return [
    { kind: "welcome" },
    { kind: "anchor", target: "upload", textKey: "intro_upload" },
    { kind: "anchor", target: "edits", textKey: "intro_edits" },
    ...(advancedMode
      ? ([{ kind: "anchor", target: "model", textKey: "intro_model" }] as TourStop[])
      : []),
    { kind: "anchor", target: "style", textKey: "intro_style" },
    { kind: "anchor", target: "runmode", textKey: "intro_runmode" },
    { kind: "anchor", target: "run", textKey: "intro_run" },
  ];
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PAD = 6;
const BUBBLE_GAP = 14;
const BUBBLE_WIDTH = 300;

export default function OnboardingGuide() {
  const lang = useStore((s) => s.lang);
  const introOpen = useStore((s) => s.introOpen);
  const setIntroOpen = useStore((s) => s.setIntroOpen);
  const setHasSeenIntro = useStore((s) => s.setHasSeenIntro);
  const advancedMode = useStore((s) => s.advancedMode);
  const t = useTranslation(lang);

  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const STOPS = useMemo(() => buildStops(advancedMode), [advancedMode]);

  // Reset to the first stop each time the tour opens.
  useEffect(() => {
    if (introOpen) setIndex(0);
  }, [introOpen]);

  const stop = STOPS[index];
  const isLast = index === STOPS.length - 1;
  const isWelcome = stop?.kind === "welcome";

  const finish = () => {
    setIntroOpen(false);
    setHasSeenIntro(true);
  };
  const next = () => {
    if (isLast) finish();
    else setIndex((i) => Math.min(i + 1, STOPS.length - 1));
  };
  const back = () => setIndex((i) => Math.max(i - 1, 0));

  // Measure the current anchor target; re-measure on step change, resize, scroll.
  useLayoutEffect(() => {
    if (!introOpen || !stop || stop.kind !== "anchor") {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(`[data-tour="${stop.target}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [introOpen, index, stop]);

  // Escape closes the tour (counts as seen).
  useEffect(() => {
    if (!introOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [introOpen]);

  if (!introOpen || !stop) return null;

  // An anchor stop whose target isn't on screen — dim only, center the bubble
  // so the tour never gets stuck with an invisible arrow.
  const anchored = stop.kind === "anchor" && rect !== null;

  const spotlightStyle = anchored
    ? {
        top: rect!.top - SPOTLIGHT_PAD,
        left: rect!.left - SPOTLIGHT_PAD,
        width: rect!.width + SPOTLIGHT_PAD * 2,
        height: rect!.height + SPOTLIGHT_PAD * 2,
      }
    : null;

  // Bubble to the right of the target, vertically aligned and clamped on-screen.
  let bubbleStyle: React.CSSProperties = {};
  const centered = isWelcome || !anchored;
  if (anchored && spotlightStyle) {
    const rawTop = rect!.top;
    const maxTop = window.innerHeight - 180;
    bubbleStyle = {
      left: rect!.left + rect!.width + BUBBLE_GAP,
      top: Math.max(16, Math.min(rawTop, maxTop)),
      width: BUBBLE_WIDTH,
    };
  }

  const bodyText = isWelcome ? t("intro_welcome_body") : t(stop.textKey);

  return (
    <>
      <div
        className={`intro-backdrop${centered ? " dim" : ""}`}
        onClick={finish}
      />
      {anchored && spotlightStyle && (
        <div className="intro-spotlight" style={spotlightStyle} />
      )}
      <div
        className={`intro-bubble${centered ? " centered" : ""}`}
        style={bubbleStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {isWelcome && (
          <div className="intro-bubble-title">{t("intro_welcome_title")}</div>
        )}
        <p className="intro-bubble-body">{bodyText}</p>
        <div className="intro-actions">
          <button type="button" className="intro-skip" onClick={finish}>
            {t("intro_skip")}
          </button>
          <div className="intro-actions-right">
            {index > 0 && (
              <button type="button" className="intro-back" onClick={back}>
                {t("intro_back")}
              </button>
            )}
            <button type="button" className="intro-next" onClick={next}>
              {isWelcome
                ? t("intro_start")
                : isLast
                  ? t("intro_done")
                  : t("intro_next")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
