// ── RunModeSlider — Speed / Balanced / Max, above the Run button ──
//
// This choice used to live two levels deep inside the model step's advanced
// panel, which meant almost nobody found it. It is the one trade-off every
// user genuinely has an opinion about — how long am I willing to wait for a
// better edit — so it belongs in the sidebar next to the button that starts
// the wait.
//
// The knobs behind it are unchanged: this drives the same store setter the
// advanced panel used.

import { useRef } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import type { RunMode } from "../store";

const STOPS = ["speed", "balanced", "max"] as const;
type Stop = (typeof STOPS)[number];

export default function RunModeSlider() {
  const lang = useStore((s) => s.lang);
  const runMode = useStore((s) => s.runMode);
  const setRunMode = useStore((s) => s.setRunMode);
  const t = useTranslation(lang);

  // "custom" means a knob was hand-tuned in advanced settings. There is no
  // fourth stop for it — the thumb stays where it last was, dimmed, and the
  // caption says so. Clicking any stop adopts that preset and clears it.
  const lastPreset = useRef<Stop>("speed");
  if (runMode !== "custom") lastPreset.current = runMode as Stop;

  const isCustom = runMode === "custom";
  const activeIndex = STOPS.indexOf(lastPreset.current);

  /** Arrow keys move along the track, matching radiogroup conventions. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = Math.min(STOPS.length - 1, Math.max(0, activeIndex + delta));
    setRunMode(STOPS[next] as RunMode);
  };

  return (
    <div className="run-mode-slider" data-tour="runmode">
      <span className="run-mode-slider-label">{t("run_mode")}</span>

      <div
        className={`run-mode-track${isCustom ? " run-mode-track-custom" : ""}`}
        role="radiogroup"
        aria-label={t("run_mode")}
        onKeyDown={onKeyDown}
      >
        {/* The moving highlight. One element sliding beats three fading:
            it shows the stops are a scale, not three unrelated buttons. The
            width is computed in CSS from --stops, because a percentage here
            would resolve against the padding box and drift from the stops. */}
        <span
          className="run-mode-thumb"
          style={
            {
              "--stops": STOPS.length,
              transform: `translateX(${activeIndex * 100}%)`,
            } as React.CSSProperties
          }
          aria-hidden
        />
        {STOPS.map((stop, i) => {
          const selected = !isCustom && runMode === stop;
          return (
            <button
              key={stop}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={i === activeIndex ? 0 : -1}
              className={`run-mode-stop${selected ? " run-mode-stop-active" : ""}`}
              onClick={() => setRunMode(stop as RunMode)}
            >
              {t(`run_mode_${stop}`)}
            </button>
          );
        })}
      </div>

      <span className="run-mode-help">
        {isCustom ? t("run_mode_custom_sidebar_help") : t(`run_mode_${runMode}_help`)}
      </span>
    </div>
  );
}
