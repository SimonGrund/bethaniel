// ── Model selector — three colored Betty cards ──

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { getSocket } from "../socket";
import { fetchSystemRecommendation } from "../api";

interface CatalogEntry {
  id: string;
  tier: string;
  name: string;
  description: string;
  fileName: string;
  sizeBytes: number;
  minRamGb: number;
  minRamAppleSiliconGb: number;
  allowed: boolean;
}

interface HardwareInfo {
  totalRamGb: number;
  freeRamGb: number;
  platform: string;
  arch: string;
  appleSilicon: boolean;
  cpuCount: number;
  gpu: { vendor: string; vramGb: number | null };
  allowedTiers: string[];
}

interface InstalledModel {
  id: string;
  tier: string;
  name: string;
  fileName: string;
}

interface DownloadProgress {
  modelId: string;
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
  status?: string;
  error?: string;
}

const BASE = import.meta.env.VITE_API_URL ?? "";

const TIER_COLORS: Record<string, string> = {
  small: "model-tier-green",
  normal: "model-tier-blue",
  big: "model-tier-purple",
};

export default function ModelSelector({
  onModelInstalled,
}: {
  onModelInstalled?: () => void;
}) {
  const {
    lang,
    model,
    setModel,
    models,
    setModels,
    wordsPerChunk,
    setWordsPerChunk,
    overlapParagraphs,
    setOverlapParagraphs,
    parallel,
    setParallel,
  } = useStore();
  const t = useTranslation(lang);

  const [showAdvanced, setShowAdvanced] = useState(false);

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<CatalogEntry | null>(null);

  function refresh() {
    return Promise.all([
      fetch(`${BASE}/api/hardware`).then((r) => r.json()),
      fetch(`${BASE}/api/models/catalog`).then((r) => r.json()),
      fetch(`${BASE}/api/models/installed`).then((r) => r.json()),
      fetch(`${BASE}/api/models`).then((r) => r.json()),
    ]).then(([hw, cat, inst, modelsData]) => {
      setHardware(hw);
      setCatalog(cat.catalog ?? []);
      setInstalled(inst.installed ?? []);
      setModels(modelsData.models ?? []);
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const socket = getSocket();
    const handler = (data: DownloadProgress) => {
      setProgress(data);
      if (data.status === "done") {
        setDownloading(null);
        refresh().then(() => onModelInstalled?.());
      } else if (data.status === "error") {
        setDownloading(null);
        setError(data.error ?? "Download failed");
      } else if (data.status === "cancelled") {
        setDownloading(null);
        setProgress(null);
      }
    };
    socket.on("model:download", handler);
    return () => {
      socket.off("model:download", handler);
    };
  }, []);

  // Auto-select best installed model
  const preferredOrder = [
    "mistral-small3.2:24b",
    "qwen3.5:35b",
    "gemma-3n-E4B-it-Q4_K_M.gguf",
  ];
  useEffect(() => {
    if (models.length > 0 && !models.includes(model)) {
      const best =
        models.find((m) => preferredOrder.includes(m)) ?? models[0] ?? "";
      setModel(best);
    }
  }, [models]);

  // Auto-tune parallel jobs when model changes
  useEffect(() => {
    if (!model) return;
    fetchSystemRecommendation(model)
      .then((r) => setParallel(r.recommendedParallel))
      .catch(() => {});
  }, [model]);

  async function startDownload(modelId: string) {
    setError(null);
    setDownloading(modelId);
    setProgress(null);
    try {
      const res = await fetch(`${BASE}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Download failed");
        setDownloading(null);
        return;
      }
      if (data.status === "already_installed") {
        setDownloading(null);
        refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
      setDownloading(null);
    }
  }

  async function cancelDownload(modelId: string) {
    try {
      await fetch(`${BASE}/api/models/download/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
    } catch {
      // ignore
    }
    setDownloading(null);
    setProgress(null);
  }

  async function deleteModel(fileName: string) {
    await fetch(`${BASE}/api/models/${encodeURIComponent(fileName)}`, {
      method: "DELETE",
    });
    await refresh();
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return "";
    const gb = bytes / 1024 ** 3;
    return gb >= 1
      ? `${gb.toFixed(1)} GB`
      : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }

  // Find recommended tier
  const recommendedTier = hardware?.allowedTiers?.slice().reverse()[0] ?? null;

  return (
    <div className="model-selector">
      <div className="section-label">
        <span className="num">I.</span> {t("sec_model")}
      </div>
      <div className="model-selector-cards">
        {catalog.map((entry) => {
          const isInstalled = installed.some((i) => i.id === entry.id);
          const isDownloading = downloading === entry.id;
          const isDisabled = !entry.allowed && !isInstalled;
          const isSelected = model === entry.fileName;
          const tierClass = TIER_COLORS[entry.tier] ?? "model-tier-green";
          const isRecommended = entry.tier === recommendedTier;
          const minRam = hardware?.appleSilicon
            ? entry.minRamAppleSiliconGb
            : entry.minRamGb;

          return (
            <button
              key={entry.id}
              type="button"
              className={[
                "model-card",
                tierClass,
                isSelected && isInstalled ? "model-card-selected" : "",
                isInstalled ? "model-card-ready" : "",
                isDisabled ? "model-card-disabled" : "",
                isDownloading ? "model-card-downloading" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => {
                if (isInstalled) {
                  setModel(entry.fileName);
                } else if (!isDisabled && !downloading) {
                  setConfirmEntry(entry);
                }
              }}
              disabled={isDownloading}
            >
              <span className="model-card-name">{entry.name}</span>
              <span className="model-card-desc">{entry.description}</span>
              <span className="model-card-meta">
                {formatBytes(entry.sizeBytes)}
                {entry.sizeBytes > 0 ? " · " : ""}
                {t("model_requires")} {minRam} GB RAM
              </span>

              {isDownloading && progress && progress.modelId === entry.id ? (
                <span className="model-card-progress">
                  <span className="model-progress-bar">
                    <span
                      className="model-progress-fill"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </span>
                  <span className="model-progress-text">
                    {progress.percent}%
                  </span>
                  <button
                    type="button"
                    className="model-cancel-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelDownload(entry.id);
                    }}
                    title={t("model_cancel_download")}
                  >
                    ✕
                  </button>
                </span>
              ) : isInstalled ? (
                <span className="model-card-status">
                  <span className="model-installed-check">✓</span>
                  {isRecommended && (
                    <span className="model-recommended-badge">
                      {t("model_recommended")}
                    </span>
                  )}
                  <button
                    type="button"
                    className="model-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteModel(entry.fileName);
                    }}
                    title={t("model_delete")}
                  >
                    ✕
                  </button>
                </span>
              ) : isDisabled ? (
                <span className="model-card-status model-card-locked">
                  {t("model_insufficient_ram")}
                </span>
              ) : (
                <span className="model-card-status">{t("model_download")}</span>
              )}
            </button>
          );
        })}
      </div>

      {confirmEntry && (
        <div className="model-confirm-overlay">
          <div className="model-confirm-dialog">
            <p className="model-confirm-text">
              {t("model_download_warning")
                .replace("{name}", confirmEntry.name)
                .replace(
                  "{size}",
                  formatBytes(confirmEntry.sizeBytes) || "~20 GB",
                )}
            </p>
            <div className="model-confirm-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  const id = confirmEntry.id;
                  setConfirmEntry(null);
                  startDownload(id);
                }}
              >
                {t("model_download")}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmEntry(null)}
              >
                {t("btn_cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="model-error">{error}</div>}

      <button
        type="button"
        className="expander-toggle advanced-toggle"
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? "▾" : "▸"} {t("advanced_settings")}
      </button>

      {showAdvanced && (
        <div className="advanced-panel">
          <div className="field">
            <label>
              {t("words_per_chunk")}: {wordsPerChunk}
            </label>
            <input
              type="range"
              min={1000}
              max={5000}
              step={250}
              value={wordsPerChunk}
              onChange={(e) => setWordsPerChunk(Number(e.target.value))}
            />
          </div>

          <div className="field">
            <label>
              {t("paragraph_overlap")}: {overlapParagraphs}
            </label>
            <input
              type="range"
              min={0}
              max={3}
              step={1}
              value={overlapParagraphs}
              onChange={(e) => setOverlapParagraphs(Number(e.target.value))}
            />
          </div>

          <div className="field">
            <label>
              {t("parallel_jobs")}: {parallel}
            </label>
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={parallel}
              onChange={(e) => setParallel(Number(e.target.value))}
            />
            <span className="help-text">{t("parallel_help")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
