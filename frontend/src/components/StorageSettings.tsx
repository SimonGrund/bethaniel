// ── Storage & data ──
//
// Bethaniel writes >20 GB to disk once a couple of models are downloaded, and
// none of it is removed by uninstalling on macOS or Linux (Windows asks). This
// panel is the supported way to see what is stored and reclaim it — and on the
// platforms with no uninstall hook, the only one.

import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { fetchStorageUsage, purgeStorage } from "../api";
import { formatBytes } from "../modelCopy";
import type { PurgeSelection, StorageUsage } from "../types";
import Modal from "./Modal";

type Category = "models" | "documents" | "settings" | "all";

export default function StorageSettings() {
  const { lang } = useStore();
  const t = useTranslation(lang);

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [pending, setPending] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUsage(await fetchStorageUsage());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectionFor = (cat: Category): PurgeSelection =>
    cat === "all"
      ? { models: true, documents: true, settings: true }
      : { [cat]: true };

  const confirmText = (cat: Category, size: string) =>
    t(
      cat === "all"
        ? "storage_confirm_all"
        : cat === "models"
          ? "storage_confirm_models"
          : cat === "documents"
            ? "storage_confirm_documents"
            : "storage_confirm_settings",
    ).replace("{size}", size);

  /** What "{size}" becomes in the confirmation. Documents are measured in
   *  documents, not bytes — their text lives in the shared database file. */
  const amountFor = (cat: Category): string => {
    if (!usage) return "";
    if (cat === "documents") {
      return usage.documents.bytes > 0
        ? formatBytes(usage.documents.bytes)
        : t("storage_documents_count").replace(
            "{count}",
            String(usage.documents.count),
          );
    }
    return formatBytes(cat === "all" ? usage.total : usage[cat].bytes);
  };

  const runPurge = async (cat: Category) => {
    setBusy(true);
    setPending(null);
    try {
      const result = await purgeStorage(selectionFor(cat));

      // The backend deletes files; it cannot reach the renderer's
      // localStorage. Without this, "delete everything" left the language,
      // model choice, wizard progress and the seen-the-intro flag behind — the
      // app looked freshly installed to the disk and not at all fresh to the
      // user. Reload so the next paint is a genuine first run.
      if (cat === "all") {
        useStore.persist?.clearStorage?.();
        window.location.reload();
        return;
      }

      setFreed(result.bytesFreed);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  const docCount = usage?.documents.count ?? 0;

  // "Size" and "is there anything to delete" are not the same question here.
  // Manuscript *text* lives in the SQLite file (counted under Edit history), so
  // a library of 28 documents can hold 0 bytes of extracted images — the row
  // must still offer a Delete. Likewise the API key is a few dozen bytes but is
  // the single most important thing to be able to remove.
  const rows: {
    cat: Exclude<Category, "all">;
    label: string;
    sub?: string;
    sizeLabel: string;
    removable: boolean;
  }[] = [
    {
      cat: "models",
      label: t("storage_models"),
      sub: usage?.models.files.map((f) => f.name).join(", "),
      sizeLabel:
        usage && usage.models.bytes > 0
          ? formatBytes(usage.models.bytes)
          : t("storage_empty"),
      removable: (usage?.models.bytes ?? 0) > 0,
    },
    {
      cat: "documents",
      label: t("storage_documents"),
      sub:
        usage && usage.documents.bytes > 0
          ? formatBytes(usage.documents.bytes)
          : undefined,
      sizeLabel: docCount
        ? t("storage_documents_count").replace("{count}", String(docCount))
        : t("storage_empty"),
      removable: docCount > 0 || (usage?.documents.bytes ?? 0) > 0,
    },
    {
      cat: "settings",
      label: t("storage_settings"),
      sizeLabel:
        usage && usage.settings.bytes > 0
          ? formatBytes(usage.settings.bytes)
          : t("storage_empty"),
      removable: !!usage && (usage.settings.bytes > 0 || usage.settings.hasApiKey),
    },
  ];

  return (
    <section className="storage-settings">
      <h3 id="storage-title">{t("storage_title")}</h3>
      <p className="storage-intro">{t("storage_intro")}</p>

      {error && <p className="storage-error">{error}</p>}
      {freed !== null && (
        <p className="storage-freed">
          {t("storage_freed").replace("{size}", formatBytes(freed))}
        </p>
      )}

      <div className="storage-total">
        <span>{t("storage_total")}</span>
        <strong>{usage ? formatBytes(usage.total) : "…"}</strong>
      </div>

      <ul className="storage-rows">
        {rows.map(({ cat, label, sub, sizeLabel, removable }) => (
          <li key={cat} className="storage-row">
            <div className="storage-row-text">
              <span className="storage-row-label">{label}</span>
              {sub && <span className="storage-row-sub">{sub}</span>}
            </div>
            <span className="storage-row-size">{sizeLabel}</span>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !removable}
              onClick={() => setPending(cat)}
            >
              {t("storage_delete")}
            </button>
          </li>
        ))}
      </ul>

      <div className="storage-row storage-row-db">
        <span className="storage-row-label">{t("storage_database")}</span>
        <span className="storage-row-size">
          {usage ? formatBytes(usage.database.bytes) : "…"}
        </span>
      </div>

      <button
        type="button"
        className="btn-danger storage-delete-all"
        disabled={busy || !usage || usage.total === 0}
        onClick={() => setPending("all")}
      >
        {t("storage_delete_all")}
      </button>

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        labelledBy="storage-confirm-text"
      >
        <p className="model-confirm-text" id="storage-confirm-text">
          {pending && confirmText(pending, amountFor(pending))}
        </p>
        <div className="model-confirm-actions">
          <button
            type="button"
            className="btn-primary model-delete-confirm"
            onClick={() => pending && void runPurge(pending)}
          >
            {t("storage_delete")}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPending(null)}
          >
            {t("btn_cancel")}
          </button>
        </div>
      </Modal>
    </section>
  );
}
