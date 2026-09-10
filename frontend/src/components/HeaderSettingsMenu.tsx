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
        <svg
          className="btn-header-settings-cog"
          viewBox="0 0 24 24"
          width="26"
          height="26"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm0 5.7a2.1 2.1 0 1 1 0-4.2 2.1 2.1 0 0 1 0 4.2Z"
          />
          <path
            fill="currentColor"
            d="m20.6 13.6.02-1.6-.02-1.6-1.9-.3a6.9 6.9 0 0 0-.62-1.5l1.13-1.56a9 9 0 0 0-2.25-2.25L15.4 5.92a6.9 6.9 0 0 0-1.5-.62l-.3-1.9-1.6-.02-1.6.02-.3 1.9a6.9 6.9 0 0 0-1.5.62L7.04 4.79a9 9 0 0 0-2.25 2.25L5.92 8.6a6.9 6.9 0 0 0-.62 1.5l-1.9.3L3.38 12l.02 1.6 1.9.3c.15.53.36 1.03.62 1.5l-1.13 1.56a9 9 0 0 0 2.25 2.25l1.56-1.13c.47.26.97.47 1.5.62l.3 1.9 1.6.02 1.6-.02.3-1.9c.53-.15 1.03-.36 1.5-.62l1.56 1.13a9 9 0 0 0 2.25-2.25l-1.13-1.56c.26-.47.47-.97.62-1.5l1.9-.3ZM12 18.3A6.3 6.3 0 1 1 18.3 12 6.3 6.3 0 0 1 12 18.3Z"
          />
        </svg>
        <span className="btn-header-settings-label">{t("settings")}</span>
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
