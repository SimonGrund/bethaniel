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
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [progressMap, setProgressMap] = useState<Map<string, DownloadProgress>>(
    new Map(),
  );
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
      if (data.status === "done") {
        setDownloading((prev) => {
          const next = new Set(prev);
          next.delete(data.modelId);
          return next;
        });
        setProgressMap((prev) => {
          const next = new Map(prev);
          next.delete(data.modelId);
          return next;
        });
        refresh().then(() => onModelInstalled?.());
      } else if (data.status === "error") {
        setDownloading((prev) => {
          const next = new Set(prev);
          next.delete(data.modelId);
          return next;
        });
        setProgressMap((prev) => {
          const next = new Map(prev);
          next.delete(data.modelId);
          return next;
        });
        setError(data.error ?? "Download failed");
      } else if (data.status === "cancelled") {
        setDownloading((prev) => {
          const next = new Set(prev);
          next.delete(data.modelId);
          return next;
        });
        setProgressMap((prev) => {
          const next = new Map(prev);
          next.delete(data.modelId);
          return next;
        });
      } else {
        setProgressMap((prev) => {
          const next = new Map(prev);
          next.set(data.modelId, data);
          return next;
        });
      }
    };
    socket.on("model:download", handler);
    return () => {
      socket.off("model:download", handler);
    };
  }, []);

  // Auto-select best installed model
  const preferredOrder = [
    "Qwen3-32B-Q4_K_M.gguf",
    "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
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
    setDownloading((prev) => new Set(prev).add(modelId));
    try {
      const res = await fetch(`${BASE}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Download failed");
        setDownloading((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
        return;
      }
      if (data.status === "already_installed") {
        setDownloading((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
        refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
      setDownloading((prev) => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
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
    setDownloading((prev) => {
      const next = new Set(prev);
      next.delete(modelId);
      return next;
    });
    setProgressMap((prev) => {
      const next = new Map(prev);
      next.delete(modelId);
      return next;
    });
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
          const isDownloading = downloading.has(entry.id);
          const isDisabled = !entry.allowed && !isInstalled;
          const isSelected = model === entry.fileName;
          const tierClass = TIER_COLORS[entry.tier] ?? "model-tier-green";
          const isRecommended = entry.tier === recommendedTier;
          const minRam = hardware?.appleSilicon
            ? entry.minRamAppleSiliconGb
            : entry.minRamGb;
          const entryProgress = progressMap.get(entry.id);

          return (
            <div key={entry.id} className="model-card-wrap">
              <button
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
                  } else if (!isDisabled && !isDownloading) {
                    setConfirmEntry(entry);
                  }
                }}
              >
                <span className="model-card-name">{entry.name}</span>
                <span className="model-card-desc">
                  {t("model_desc_" + entry.id.replace(/[.\-]/g, "_")) ||
                    entry.description}
                </span>
                <span className="model-card-meta">
                  {formatBytes(entry.sizeBytes)}
                  {entry.sizeBytes > 0 ? " · " : ""}
                  {t("model_requires")} {minRam} GB RAM
                </span>

                {isDownloading && entryProgress ? (
                  <span className="model-card-progress">
                    <span className="model-progress-bar">
                      <span
                        className="model-progress-fill"
                        style={{ width: `${entryProgress.percent}%` }}
                      />
                    </span>
                    <span className="model-progress-text">
                      {entryProgress.percent}%
                    </span>
                  </span>
                ) : isInstalled ? (
                  <span className="model-card-status">
                    <span className="model-installed-check">✓</span>
                    {isRecommended && (
                      <span className="model-recommended-badge">
                        {t("model_recommended")}
                      </span>
                    )}
                  </span>
                ) : isDisabled ? (
                  <span className="model-card-status model-card-locked">
                    {t("model_insufficient_ram")}
                  </span>
                ) : (
                  <span className="model-card-status">
                    {t("model_download")}
                  </span>
                )}
              </button>

              {isDownloading && (
                <button
                  type="button"
                  className="model-card-overlay-btn model-cancel-btn"
                  onClick={() => cancelDownload(entry.id)}
                  title={t("model_cancel_download")}
                >
                  ✕
                </button>
              )}
              {isInstalled && !isDownloading && (
                <button
                  type="button"
                  className="model-card-overlay-btn model-delete-btn"
                  onClick={() => deleteModel(entry.fileName)}
                  title={t("model_delete")}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}

        {/* Business Betty — placeholder locked card 
        <button
          type="button"
          className="model-card model-tier-vip model-card-vip-locked"
          title={t("model_vip_coming_soon")}
          disabled
        >
          <span className="model-card-name">{t("model_vip_name")}</span>
          <span className="model-card-desc">{t("model_vip_desc")}</span>
          <span className="model-card-status">
            <span className="vip-lock-icon">🔒</span>
            {t("model_vip_coming_soon")}
          </span>
        </button>
        */}
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

          {model && <ModelTuning fileName={model} />}
        </div>
      )}
    </div>
  );
}

// ── Per-model tuning subsection ──
interface ModelConfig {
  num_ctx: number;
  num_predict: number;
  temperature: number;
  no_mmap: boolean;
}

function ModelTuning({ fileName }: { fileName: string }) {
  const { lang } = useStore();
  const t = useTranslation(lang);
  const [cfg, setCfg] = useState<ModelConfig | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/models/${encodeURIComponent(fileName)}/config`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setCfg({
          num_ctx: data.num_ctx,
          num_predict: data.num_predict,
          temperature: data.temperature,
          no_mmap: !!data.no_mmap,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  function save(next: ModelConfig) {
    setCfg(next);
    fetch(`${BASE}/api/models/${encodeURIComponent(fileName)}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    })
      .then((r) => r.json())
      .then(() => {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1200);
      })
      .catch(() => {});
  }

  if (!cfg) return null;

  return (
    <div className="model-tuning">
      <div className="model-tuning-header">
        <strong>{t("model_tuning")}</strong>
        {saved && (
          <span className="model-tuning-saved">{t("tuning_saved")}</span>
        )}
      </div>
      <span className="help-text">{t("model_tuning_help")}</span>

      <div className="field">
        <label>
          {t("context_window")}: {cfg.num_ctx.toLocaleString()}
        </label>
        <input
          type="range"
          min={2048}
          max={32768}
          step={1024}
          value={cfg.num_ctx}
          onChange={(e) => setCfg({ ...cfg, num_ctx: Number(e.target.value) })}
          onMouseUp={(e) =>
            save({
              ...cfg,
              num_ctx: Number((e.target as HTMLInputElement).value),
            })
          }
          onTouchEnd={(e) =>
            save({
              ...cfg,
              num_ctx: Number((e.target as HTMLInputElement).value),
            })
          }
          onKeyUp={(e) =>
            save({
              ...cfg,
              num_ctx: Number((e.target as HTMLInputElement).value),
            })
          }
        />
        <span className="help-text">{t("context_window_help")}</span>
      </div>

      <div className="field">
        <label>
          {t("max_output_tokens")}: {cfg.num_predict.toLocaleString()}
        </label>
        <input
          type="range"
          min={512}
          max={8192}
          step={256}
          value={cfg.num_predict}
          onChange={(e) =>
            setCfg({ ...cfg, num_predict: Number(e.target.value) })
          }
          onMouseUp={(e) =>
            save({
              ...cfg,
              num_predict: Number((e.target as HTMLInputElement).value),
            })
          }
          onTouchEnd={(e) =>
            save({
              ...cfg,
              num_predict: Number((e.target as HTMLInputElement).value),
            })
          }
          onKeyUp={(e) =>
            save({
              ...cfg,
              num_predict: Number((e.target as HTMLInputElement).value),
            })
          }
        />
        <span className="help-text">{t("max_output_help")}</span>
      </div>

      <div className="field">
        <label>
          {t("temperature_label")}: {cfg.temperature.toFixed(1)}
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={cfg.temperature}
          onChange={(e) =>
            setCfg({ ...cfg, temperature: Number(e.target.value) })
          }
          onMouseUp={(e) =>
            save({
              ...cfg,
              temperature: Number((e.target as HTMLInputElement).value),
            })
          }
          onTouchEnd={(e) =>
            save({
              ...cfg,
              temperature: Number((e.target as HTMLInputElement).value),
            })
          }
          onKeyUp={(e) =>
            save({
              ...cfg,
              temperature: Number((e.target as HTMLInputElement).value),
            })
          }
        />
        <span className="help-text">{t("temperature_help")}</span>
      </div>

      <div className="field model-tuning-checkbox">
        <label>
          <input
            type="checkbox"
            checked={cfg.no_mmap}
            onChange={(e) => save({ ...cfg, no_mmap: e.target.checked })}
          />{" "}
          {t("disable_mmap")}
        </label>
      </div>
    </div>
  );
}
