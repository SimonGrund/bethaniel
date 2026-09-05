// ── Header settings menu — the app-level drawer of things that aren't a step ──
//
// Model settings (the advanced-mode reveal) and Storage & data used to live at
// opposite ends of the app: one in the header, one at the bottom of the
// sidebar rail. Neither belongs to the wizard, and the rail needed the room for
// the engine log, so they share one dropdown here.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import StorageSettings from "./StorageSettings";
import Modal from "./Modal";

export default function HeaderSettingsMenu() {
  const lang = useStore((s) => s.lang);
  const advancedMode = useStore((s) => s.advancedMode);
  const setAdvancedMode = useStore((s) => s.setAdvancedMode);
  const wizardStep = useStore((s) => s.wizardStep);
  const setWizardStep = useStore((s) => s.setWizardStep);
  const t = useTranslation(lang);

  const [open, setOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Click-outside / Escape close. Skipped entirely while shut so the app isn't
  // carrying two document-level listeners it never uses.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggleModelSettings = () => {
    const next = !advancedMode;
    setAdvancedMode(next);
    // Leaving advanced mode while the model step is open would otherwise
    // strand the user on an empty panel.
    if (!next && wizardStep === "model") setWizardStep("folded");
    if (next) setWizardStep("model");
    setOpen(false);
  };

  return (
    <div className="header-settings" ref={wrapRef}>
      <button
        type="button"
        className={`btn-header-settings${open ? " btn-header-settings-on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden>⚙</span>
        {t("settings")}
      </button>

      {open && (
        <div className="header-settings-menu" role="menu">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={advancedMode}
            className="header-settings-item"
            onClick={toggleModelSettings}
          >
            {advancedMode ? t("hide_model_selector") : t("activate_model_selector")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="header-settings-item"
            onClick={() => {
              setStorageOpen(true);
              setOpen(false);
            }}
          >
            {t("storage_title")}
          </button>
        </div>
      )}

      <Modal
        open={storageOpen}
        onClose={() => setStorageOpen(false)}
        labelledBy="storage-title"
        className="storage-dialog"
      >
        <StorageSettings />
        <div className="model-confirm-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setStorageOpen(false)}
          >
            {t("btn_close")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
