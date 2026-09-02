// ── RunModeSlider — Speed / Max, above the Run button ──
//
// This choice used to live two levels deep inside the model step's advanced
// panel, which meant almost nobody found it. It is the one trade-off every
// user genuinely has an opinion about — how long am I willing to wait for a
// better edit — so it belongs in the sidebar next to the button that starts
// the wait.
//
// The knobs behind it are unchanged: this drives the same store setter the
// advanced panel used. Only shown for editing tasks — analysis/report modes
// don't run the editor/reviewer/2nd-pass pipeline the presets control.

import { useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { EDIT_MODES } from "../types";
import type { RunMode } from "../store";

const STOPS = ["speed", "max"] as const;
type Stop = (typeof STOPS)[number];

export default function RunModeSlider() {
  const lang = useStore((s) => s.lang);
  const runMode = useStore((s) => s.runMode);
  const setRunMode = useStore((s) => s.setRunMode);
  const selectedModes = useStore((s) => s.selectedModes);
  const model = useStore((s) => s.model);
  const hardware = useStore((s) => s.hardware);
  const t = useTranslation(lang);

  const [maxWarn, setMaxWarn] = useState(false);

  // "custom" means a knob was hand-tuned in advanced settings. There is no
  // stop for it — the thumb stays where it last was, dimmed, and the caption
  // says so. Clicking any stop adopts that preset and clears it.
  const lastPreset = useRef<Stop>("speed");
  if (runMode !== "custom") lastPreset.current = runMode as Stop;

  const isCustom = runMode === "custom";
  const activeIndex = STOPS.indexOf(lastPreset.current);

  // Max on a weak local machine is a footgun: 3 editors + a 2nd pass is ~5× the
  // work, and a full book can take hours. External Betty (API) is unaffected —
  // its throughput comes from the provider, not this hardware. "Weak" = the
  // machine can't comfortably run "normal" tier — Big Bad Betty, the biggest
  // local model there is (the backend's own tier verdict).
  const isApiModel =
    model.startsWith("custom:") && !model.startsWith("custom:gguf");
  const weakHardware = !!hardware && !(hardware.allowedTiers ?? []).includes("normal");
  const maxIsRisky = !isApiModel && weakHardware;

  /** Adopt a stop — but intercept Max on weak local hardware with a warning. */
  const chooseStop = (stop: Stop) => {
    if (stop === "max" && maxIsRisky) {
      setMaxWarn(true);
      return;
    }
    setRunMode(stop as RunMode);
  };

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
    chooseStop(STOPS[next]);
  };

  // The presets only drive the editor/reviewer/2nd-pass pipeline, which runs
  // for editing tasks. Analysis and report modes ignore them, so the control
  // would be a no-op there — hide it.
  const isEditingRun = selectedModes.some((m) => EDIT_MODES.includes(m));
  if (!isEditingRun) return null;

  return (
    <>
      <div className="run-mode-slider" data-tour="runmode">
        <span className="run-mode-slider-label">{t("run_mode")}</span>

        <div
          className={`run-mode-track${isCustom ? " run-mode-track-custom" : ""}`}
          role="radiogroup"
          aria-label={t("run_mode")}
          onKeyDown={onKeyDown}
        >
          {/* The moving highlight. One element sliding beats two fading: it
              shows the stops are a scale, not two unrelated buttons. The width
              is computed in CSS from --stops, because a percentage here would
              resolve against the padding box and drift from the stops. */}
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
                onClick={() => chooseStop(stop)}
              >
                {t(`run_mode_${stop}`)}
              </button>
            );
          })}
        </div>

        <span className="run-mode-help">
          {isCustom
            ? t("run_mode_custom_sidebar_help")
            : t(`run_mode_${runMode}_help`)}
        </span>
      </div>

      {maxWarn && (
        <div
          className="model-confirm-overlay"
          onClick={() => setMaxWarn(false)}
        >
          <div
            className="model-confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="model-confirm-text">{t("run_mode_max_warn")}</p>
            <p className="model-confirm-warn">{t("run_mode_max_warn_detail")}</p>
            <div className="model-confirm-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setMaxWarn(false)}
              >
                {t("run_mode_max_warn_cancel")}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setMaxWarn(false);
                  setRunMode("max");
                }}
              >
                {t("run_mode_max_warn_proceed")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
