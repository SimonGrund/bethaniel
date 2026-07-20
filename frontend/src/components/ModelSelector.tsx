// ── Model selector — three colored Betty cards ──

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { getSocket } from "../socket";
import {
  fetchSystemRecommendation,
  fetchCustomModelConfig,
  saveCustomModelConfig,
  saveCustomModelName,
  deleteCustomModelConfig,
  fetchCustomGgufConfig,
  saveCustomGgufConfig,
  deleteCustomGgufConfig,
} from "../api";

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
  fitsGpu: boolean | null;
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

// Slider ceiling for External Betty (API) models. Local models stay capped by
// the hardware recommendation (≤3 — single-GPU decode is bandwidth-bound).
const API_MAX_PARALLEL = 24;

const TIER_COLORS: Record<string, string> = {
  small: "model-tier-green",
  normal: "model-tier-blue",
  big: "model-tier-purple",
  custom: "model-tier-custom",
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
    reviewMode,
    setReviewMode,
    reviewerThreshold,
    setReviewerThreshold,
    reviewerCount,
    setReviewerCount,
    spellCheck,
    setSpellCheck,
    dualEditor,
    setDualEditor,
    dualCount,
    setDualCount,
    characterDedup,
    setCharacterDedup,
    styleComplianceAgent,
    setStyleComplianceAgent,
    extraPass,
    setExtraPass,
    styleGuide,
    tasks,
    wizardStep,
    setWizardStep,
    highlightedModel,
    setHighlightedModel,
    markStepComplete,
    completedSteps,
    advanceWizard,
    showCustomBetty,
    setShowCustomBetty,
    showExternalBetty,
    setShowExternalBetty,
    showEngineStatus,
    setShowEngineStatus,
  } = useStore();
  const t = useTranslation(lang);

  const modelLocked = Object.values(tasks).some(
    (task) => task.status === "queued" || task.status === "editing",
  );

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxParallel, setMaxParallel] = useState(3);

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [progressMap, setProgressMap] = useState<Map<string, DownloadProgress>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<CatalogEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CatalogEntry | null>(null);
  const [preferredOrder, setPreferredOrder] = useState<string[]>([]);

  // External Betty (API) config
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiModelName, setApiModelName] = useState("deepseek-chat");
  const [apiSaving, setApiSaving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiConfigOpen, setApiConfigOpen] = useState(false);
  const {
    apiKeyConfigured,
    setApiKeyConfigured,
    setApiModel: setStoreApiModel,
  } = useStore();

  // Custom Betty (custom GGUF path)
  const [customGgufPath, setCustomGgufPath] = useState("");
  const [customGgufConfigured, setCustomGgufConfigured] = useState(false);
  const [customGgufSaving, setCustomGgufSaving] = useState(false);
  const [customGgufError, setCustomGgufError] = useState<string | null>(null);
  const [customGgufConfigOpen, setCustomGgufConfigOpen] = useState(false);
  const [showCustomGgufModal, setShowCustomGgufModal] = useState(false);

  function refresh() {
    return Promise.all([
      fetch(`${BASE}/api/hardware`).then((r) => r.json()),
      fetch(`${BASE}/api/models/catalog`).then((r) => r.json()),
      fetch(`${BASE}/api/models/installed`).then((r) => r.json()),
      fetch(`${BASE}/api/models`).then((r) => r.json()),
      fetchCustomModelConfig().catch(
        () => ({ configured: false, model: "" }) as const,
      ),
      fetchCustomGgufConfig().catch(
        () => ({ configured: false, path: "" }) as const,
      ),
    ]).then(([hw, cat, inst, modelsData, customCfg, ggufCfg]) => {
      setHardware(hw);
      setCatalog(cat.catalog ?? []);
      setPreferredOrder(cat.preferredOrder ?? []);
      setInstalled(inst.installed ?? []);
      setModels(modelsData.models ?? []);
      setApiKeyConfigured(customCfg.configured);
      setStoreApiModel(customCfg.model ?? "");
      if (customCfg.model) setApiModelName(customCfg.model);
      setCustomGgufConfigured(ggufCfg.configured);
      if (ggufCfg.path) setCustomGgufPath(ggufCfg.path);
    });
  }

  async function handleSaveApiConfig() {
    setApiError(null);
    setApiSaving(true);
    try {
      await saveCustomModelConfig(apiKeyInput, apiModelName);
      setApiKeyConfigured(true);
      setStoreApiModel(apiModelName);
      setApiKeyInput("");
      setApiConfigOpen(false);
      setHighlightedModel("custom:deepseek-chat");
      await refresh();
      setModel("custom:deepseek-chat");
      markStepComplete("model");
    } catch (err) {
      setApiError(err instanceof Error ? err.message : t("api_config_error"));
    } finally {
      setApiSaving(false);
    }
  }

  /** Change the DeepSeek model. Persists immediately when a key is stored;
   *  otherwise just preselects the value used when connecting. */
  async function handleChangeApiModel(name: string) {
    setApiModelName(name);
    if (!apiKeyConfigured) return;
    setApiError(null);
    try {
      await saveCustomModelName(name);
      setStoreApiModel(name);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : t("api_config_error"));
    }
  }

  async function handleDisconnectApi() {
    setApiError(null);
    try {
      await deleteCustomModelConfig();
      setApiKeyConfigured(false);
      setStoreApiModel("");
      setApiKeyInput("");
      setApiConfigOpen(false);
      setHighlightedModel("");
      if (model === "custom:deepseek-chat") setModel("");
      await refresh();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : t("api_config_error"));
    }
  }

  // ── Custom Betty (custom GGUF) handlers ──

  async function handleBrowseGguf() {
    // Native Electron file picker — falls back to manual path entry
    try {
      const win = window as unknown as {
        bethaniel?: { selectGgufFile?: () => Promise<string | null> };
      };
      if (win.bethaniel?.selectGgufFile) {
        const selected = await win.bethaniel.selectGgufFile();
        if (selected) {
          setCustomGgufPath(selected);
          setCustomGgufError(null);
        }
        return;
      }
    } catch {
      // Fall through to manual input — user types the path
    }
  }

  async function handleSaveCustomGgufConfig() {
    setCustomGgufError(null);
    setCustomGgufSaving(true);
    try {
      await saveCustomGgufConfig(customGgufPath);
      setCustomGgufConfigured(true);
      setShowCustomGgufModal(false);
      setHighlightedModel("custom:gguf");
      await refresh();
      setModel("custom:gguf");
      markStepComplete("model");
    } catch (err) {
      setCustomGgufError(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomGgufSaving(false);
    }
  }

  async function handleDisconnectCustomGguf() {
    setCustomGgufError(null);
    try {
      await deleteCustomGgufConfig();
      setCustomGgufConfigured(false);
      setCustomGgufPath("");
      setCustomGgufConfigOpen(false);
      setHighlightedModel("");
      if (model === "custom:gguf") setModel("");
      await refresh();
    } catch (err) {
      setCustomGgufError(err instanceof Error ? err.message : String(err));
    }
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
  useEffect(() => {
    if (models.length > 0 && !models.includes(model)) {
      const best =
        models.find((m) => preferredOrder.includes(m)) ?? models[0] ?? "";
      setModel(best);
    }
  }, [models]);

  // Close External Betty config panel when user selects a local model
  useEffect(() => {
    if (model && !model.startsWith("custom:")) {
      setApiConfigOpen(false);
      setCustomGgufConfigOpen(false);
    }
  }, [model]);

  // Auto-tune parallel jobs when model changes
  useEffect(() => {
    const activeModel = wizardStep === "model" ? highlightedModel : model;
    if (!activeModel) return;
    // External Betty (API): concurrency is bounded by provider rate limits,
    // not local hardware — allow a much higher ceiling but keep the current
    // parallel value as the default (no auto-bump).
    if (activeModel.startsWith("custom:") && !activeModel.startsWith("custom:gguf")) {
      setMaxParallel(API_MAX_PARALLEL);
      return;
    }
    if (activeModel.startsWith("custom:")) return;
    fetchSystemRecommendation(activeModel)
      .then((r) => {
        setParallel(r.recommendedParallel);
        setMaxParallel(r.recommendedParallel);
      })
      .catch(() => {});
  }, [highlightedModel, model, wizardStep]);

  // Pre-warm the selected model so the first task doesn't pay the cold-load
  // cost (mmap + KV alloc + Metal offload). Fire-and-forget — the backend
  // serializes loads and emits progress via the `model:warming` socket event.
  // Also flush the UI log (server + client) when the user switches models, so
  // the engine feed shows only events relevant to the newly chosen model.
  const prevModelRef = useRef<string>("");
  const bootTimeRef = useRef<number>(Date.now());
  const clearLogsLocal = useStore((s) => s.clearLogs);
  useEffect(() => {
    const activeModel = wizardStep === "model" ? highlightedModel : model;
    if (!activeModel) return;
    const prev = prevModelRef.current;
    prevModelRef.current = activeModel;
    // Skip warm-up + log-flush for cloud/Ollama/API models — only local GGUFs
    // need the cold-load mitigation.
    if (
      activeModel.startsWith("ollama:") ||
      (activeModel.startsWith("custom:") &&
        !activeModel.startsWith("custom:gguf"))
    )
      return;
    // Only flush on a real switch, not on the initial auto-select after boot,
    // so users keep useful startup diagnostics.
    if (prev && prev !== activeModel) {
      clearLogsLocal();
      fetch(`${BASE}/api/logs`, { method: "DELETE" }).catch(() => {});
    }
    // Postpone the initial warm-up by 5 s so the UI finishes loading first.
    const elapsed = Date.now() - bootTimeRef.current;
    const delay = !prev && elapsed < 5000 ? 5000 - elapsed : 0;
    const timer = setTimeout(() => {
      fetch(`${BASE}/api/models/preload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: activeModel }),
      }).catch(() => {});
    }, delay);
    return () => clearTimeout(timer);
  }, [highlightedModel, model, wizardStep, clearLogsLocal]);

  // Auto-tune words-per-chunk when model tier changes.
  // Big models are slow per token and have stricter context budgets, so we
  // default them to small chunks (500 words). Only override when the current
  // value matches a known tier default — never clobber a user customization.
  const TIER_WPC_DEFAULTS: Record<string, number> = {
    big: 1500,
    normal: 2000,
    small: 2000,
  };
  const KNOWN_TIER_DEFAULTS = new Set(Object.values(TIER_WPC_DEFAULTS));
  useEffect(() => {
    if (!model || catalog.length === 0) return;
    const entry = catalog.find((e) => e.fileName === model);
    if (!entry) return;
    const target = TIER_WPC_DEFAULTS[entry.tier];
    if (
      target &&
      target !== wordsPerChunk &&
      KNOWN_TIER_DEFAULTS.has(wordsPerChunk)
    ) {
      setWordsPerChunk(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, catalog]);

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

  // Find recommended tier.
  // If the machine can handle at least one model → recommend the highest allowed tier.
  // If nothing is allowed (very low RAM) → fall back to the smallest model so users
  // still have a clear "start here" option with a warning.
  const anyAllowed = (hardware?.allowedTiers?.length ?? 0) > 0;
  const recommendedTier = anyAllowed
    ? (hardware?.allowedTiers?.slice().reverse()[0] ?? null)
    : (catalog[0]?.tier ?? null);

  return (
    <div className="model-selector">
      <div className="section-label">
        <span className="num">I.</span> {t("sec_model")}
      </div>
      {modelLocked && (
        <div className="model-lock-notice"> {t("model_locked_while_busy")}</div>
      )}
      <div className="model-selector-cards">
        {catalog
          .filter((entry) => {
            if (entry.fileName === "custom:gguf") return showCustomBetty;
            if (entry.fileName === "custom:deepseek-chat")
              return showExternalBetty;
            return true;
          })
          .map((entry) => {
            const isApiModel =
              entry.fileName.startsWith("custom:") &&
              entry.fileName !== "custom:gguf";
            const isCustomGguf = entry.fileName === "custom:gguf";
            const isInstalled = isCustomGguf
              ? customGgufConfigured
              : isApiModel
                ? apiKeyConfigured
                : installed.some((i) => i.id === entry.id);
            const isDownloading =
              !isApiModel && !isCustomGguf && downloading.has(entry.id);
            // over-spec: machine lacks RAM but download is still allowed
            const isOverSpec =
              !isApiModel && !isCustomGguf && !entry.allowed && !isInstalled;
            const isSelected =
              wizardStep === "model"
                ? highlightedModel === entry.fileName
                : model === entry.fileName;
            const tierClass = TIER_COLORS[entry.tier] ?? "model-tier-green";
            const isRecommended = entry.tier === recommendedTier;
            // show "Best for your machine" when the machine is low-spec
            const isBestForMachine = !anyAllowed && isRecommended;
            const isLockedOut = modelLocked && !isSelected && isInstalled;
            const minRam = hardware?.appleSilicon
              ? entry.minRamAppleSiliconGb
              : entry.minRamGb;
            const entryProgress = !isApiModel
              ? progressMap.get(entry.id)
              : undefined;

            return (
              <div key={entry.id} className="model-card-wrap">
                <button
                  type="button"
                  className={[
                    "model-card",
                    tierClass,
                    isSelected && isInstalled ? "model-card-selected" : "",
                    isInstalled ? "model-card-ready" : "",
                    isOverSpec ? "model-card-overspec" : "",
                    isDownloading ? "model-card-downloading" : "",
                    isLockedOut ? "model-card-locked-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={isLockedOut}
                  onClick={() => {
                    if (isLockedOut) return;
                    if (isCustomGguf) {
                      if (isInstalled) {
                        setHighlightedModel(entry.fileName);
                        setModel(entry.fileName);
                        markStepComplete("model");
                      } else {
                        setShowCustomGgufModal(true);
                      }
                      return;
                    }
                    if (isApiModel) {
                      if (isInstalled) {
                        setHighlightedModel(entry.fileName);
                        setApiConfigOpen(false);
                        setModel(entry.fileName);
                        markStepComplete("model");
                      } else {
                        setHighlightedModel(entry.fileName);
                      }
                      return;
                    }
                    if (isInstalled) {
                      setHighlightedModel(entry.fileName);
                      setModel(entry.fileName);
                      markStepComplete("model");
                    } else if (!isDownloading) {
                      setConfirmEntry(entry);
                    }
                  }}
                >
                  <span className="model-card-name">{entry.name}</span>
                  <span className="model-card-desc">
                    {t(
                      "model_desc_" + entry.id.replace(/[.\-]/g, "_"),
                      entry.description,
                    )}
                  </span>
                  <span className="model-card-meta">
                    {isCustomGguf ? (
                      customGgufConfigured ? (
                        customGgufPath.split("/").pop() || customGgufPath
                      ) : (
                        t("custom_gguf_path_label")
                      )
                    ) : isApiModel ? (
                      apiKeyConfigured ? (
                        `${t("api_model_label")}: ${apiModelName}`
                      ) : (
                        t("api_not_configured")
                      )
                    ) : (
                      <>
                        {formatBytes(entry.sizeBytes)}
                        {entry.sizeBytes > 0 ? " · " : ""}
                        {entry.fitsGpu === null
                          ? `${t("model_requires")} ${minRam} GB RAM`
                          : entry.fitsGpu
                            ? t("model_fits_gpu")
                            : t("model_cpu_fallback")}
                      </>
                    )}
                  </span>

                  {isCustomGguf ? (
                    isInstalled ? (
                      <span className="model-card-status">
                        <span className="model-installed-check">✓</span>
                        <span className="model-recommended-badge">
                          {t("custom_gguf_configured")}
                        </span>
                      </span>
                    ) : (
                      <span className="model-card-status">
                        {t("custom_gguf_connect")}
                      </span>
                    )
                  ) : isApiModel ? (
                    isInstalled ? (
                      <span className="model-card-status">
                        <span className="model-installed-check">✓</span>
                        <span className="model-recommended-badge">
                          {t("api_connected")}
                        </span>
                      </span>
                    ) : (
                      <span className="model-card-status">
                        {t("api_connect")}
                      </span>
                    )
                  ) : isDownloading && entryProgress ? (
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
                  ) : isOverSpec ? (
                    <span className="model-card-status model-card-overspec-status">
                      {isBestForMachine && (
                        <span className="model-recommended-badge model-recommended-low-spec">
                          {t("model_recommended_for_machine")}
                        </span>
                      )}
                      <span className="model-overspec-label">
                        {t("model_download")}
                      </span>
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
                {isInstalled &&
                  !isDownloading &&
                  !isLockedOut &&
                  !isApiModel &&
                  !isCustomGguf && (
                    <button
                      type="button"
                      className="model-card-overlay-btn model-delete-btn"
                      onClick={() => setConfirmDelete(entry)}
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

      {/* ── Advanced settings (expandable) ── */}
      {/* Available before a model is picked; per-model tuning below stays
          gated on highlightedModel. */}
      {wizardStep === "model" && (
        <>
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
                  max={maxParallel}
                  step={1}
                  value={parallel}
                  onChange={(e) => setParallel(Number(e.target.value))}
                />
                <span className="help-text">{t("parallel_help")}</span>
              </div>

              <div className="field">
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={reviewMode}
                    onChange={(e) => setReviewMode(e.target.checked)}
                  />{" "}
                  {t("review_mode")}
                </label>
                <span className="help-text">{t("review_mode_help")}</span>
              </div>

              {reviewMode && (
                <div className="field">
                  <label>
                    {t("reviewer_threshold")}: {reviewerThreshold}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={reviewerThreshold}
                    onChange={(e) =>
                      setReviewerThreshold(Number(e.target.value))
                    }
                  />
                  <span className="help-text">
                    {t("reviewer_threshold_help")}
                  </span>
                </div>
              )}
              {reviewMode && (
                <div className="field">
                  <label>
                    {t("reviewer_count")}: {reviewerCount}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={4}
                    step={1}
                    value={reviewerCount}
                    onChange={(e) => setReviewerCount(Number(e.target.value))}
                  />
                  <span className="help-text">{t("reviewer_count_help")}</span>
                </div>
              )}

              <div className="field">
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={spellCheck}
                    onChange={(e) => setSpellCheck(e.target.checked)}
                  />{" "}
                  {t("spell_check")}
                </label>
                <span className="help-text">{t("spell_check_help")}</span>
              </div>

              <div className="field">
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={dualEditor}
                    onChange={(e) => setDualEditor(e.target.checked)}
                  />{" "}
                  {t("dual_editor")}
                </label>
                <span className="help-text">{t("dual_editor_help")}</span>
              </div>

              {dualEditor && (
                <div className="field">
                  <label>
                    {t("dual_count")}: {dualCount}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={4}
                    step={1}
                    value={dualCount}
                    onChange={(e) => setDualCount(Number(e.target.value))}
                  />
                  <span className="help-text">{t("dual_count_help")}</span>
                </div>
              )}

              <div className="field">
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={extraPass}
                    onChange={(e) => setExtraPass(e.target.checked)}
                  />{" "}
                  {t("extra_pass")}
                </label>
                <span className="help-text">{t("extra_pass_help")}</span>
              </div>

              <div className="field">
                <label
                  className="option-check"
                  style={{ opacity: styleGuide?.trim() ? 1 : 0.5 }}
                >
                  <input
                    type="checkbox"
                    checked={styleComplianceAgent && !!styleGuide?.trim()}
                    disabled={!styleGuide?.trim()}
                    onChange={(e) => setStyleComplianceAgent(e.target.checked)}
                  />{" "}
                  {t("style_compliance_agent")}
                </label>
                <span className="help-text">
                  {styleGuide?.trim()
                    ? t("style_compliance_agent_help")
                    : t("style_compliance_agent_disabled_help")}
                </span>
              </div>

              <div className="field">
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={characterDedup}
                    onChange={(e) => setCharacterDedup(e.target.checked)}
                  />{" "}
                  {t("character_dedup")}
                </label>
                <span className="help-text">{t("character_dedup_help")}</span>
              </div>

              <div className="field">
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={showEngineStatus}
                    onChange={(e) => setShowEngineStatus(e.target.checked)}
                  />{" "}
                  {t("show_engine_status")}
                </label>
                <span className="help-text">{t("show_engine_status_help")}</span>
              </div>

              <div className="field">
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={showCustomBetty}
                    onChange={(e) => setShowCustomBetty(e.target.checked)}
                  />{" "}
                  {t("show_custom_betty")}
                </label>
              </div>

              <div className="field">
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={showExternalBetty}
                    onChange={(e) => setShowExternalBetty(e.target.checked)}
                  />{" "}
                  {t("show_external_betty")}
                </label>
              </div>

              <div className="field">
                <label>
                  {t("api_model_label")}{" "}
                  <span
                    className="info-tooltip"
                    data-tip={t("api_model_tooltip")}
                  >
                    ⓘ
                  </span>
                </label>
                <select
                  className="api-config-select"
                  value={apiModelName}
                  onChange={(e) => handleChangeApiModel(e.target.value)}
                >
                  <option value="deepseek-chat">
                    deepseek-chat (DeepSeek V3)
                  </option>
                  <option value="deepseek-reasoner">
                    deepseek-reasoner (DeepSeek R1)
                  </option>
                </select>
              </div>

              {highlightedModel && <ModelTuning fileName={highlightedModel} />}
            </div>
          )}
        </>
      )}

      {/* ── Custom Betty: configured state (inline disconnect) ── */}
      {customGgufConfigured &&
        !modelLocked &&
        (model === "custom:gguf" || highlightedModel === "custom:gguf") && (
          <div className="custom-gguf-config-inline">
            <div className="custom-gguf-config-row">
              <label>
                {t("custom_gguf_path_label")}: {customGgufPath.split("/").pop()}
              </label>
            </div>
            <div className="custom-gguf-config-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleDisconnectCustomGguf}
              >
                {t("custom_gguf_disconnect")}
              </button>
            </div>
          </div>
        )}

      {/* ── Custom Betty: modal for setting GGUF path ── */}
      {showCustomGgufModal && (
        <div
          className="model-confirm-overlay"
          onClick={() => setShowCustomGgufModal(false)}
        >
          <div
            className="model-confirm-dialog custom-gguf-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="custom-gguf-title">{t("custom_betty_title")}</h3>
            <p className="custom-gguf-desc">{t("custom_betty_desc")}</p>
            <div className="custom-gguf-config-row">
              <label className="custom-gguf-label">{t("custom_gguf_path_label")}</label>
              <div className="custom-gguf-input-row">
                <input
                  type="text"
                  className="custom-gguf-input"
                  value={customGgufPath}
                  onChange={(e) => {
                    setCustomGgufPath(e.target.value);
                    setCustomGgufError(null);
                  }}
                  placeholder={t("custom_gguf_path_placeholder")}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn-secondary custom-gguf-browse-btn"
                  onClick={handleBrowseGguf}
                >
                  {t("custom_gguf_browse")}
                </button>
              </div>
            </div>
            {customGgufError && (
              <div className="model-error">
                {customGgufError}
              </div>
            )}
            <div className="model-confirm-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={handleSaveCustomGgufConfig}
                disabled={customGgufSaving || !customGgufPath.trim()}
              >
                {customGgufSaving ? "..." : t("custom_gguf_connect")}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowCustomGgufModal(false);
                  setCustomGgufError(null);
                }}
              >
                {t("btn_cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── External Betty: API config panel ── */}
      {catalog.some((e) => e.fileName.startsWith("custom:")) && (
        <>
          {!apiKeyConfigured &&
            !modelLocked &&
            highlightedModel === "custom:deepseek-chat" && (
              <div className="api-config-inline">
                <div className="api-config-row">
                  <label>{t("api_key_label")}</label>
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={t("api_key_placeholder")}
                  />
                  <button
                    type="button"
                    className="btn-show-key"
                    onClick={() => setShowApiKey(!showApiKey)}
                  >
                    {showApiKey ? t("api_hide_key") : t("api_show_key")}
                  </button>
                </div>
                <div className="api-config-row">
                  <label>{t("api_model_label")}</label>
                  <select
                    className="api-config-select"
                    value={apiModelName}
                    onChange={(e) => setApiModelName(e.target.value)}
                  >
                    <option value="deepseek-chat">
                      deepseek-chat (DeepSeek V3)
                    </option>
                    <option value="deepseek-reasoner">
                      deepseek-reasoner (DeepSeek R1)
                    </option>
                  </select>
                </div>
                <div className="api-privacy-warning">
                  {t("api_privacy_warning")}
                </div>
                {apiError && <div className="api-error">{apiError}</div>}
                <div className="api-config-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleSaveApiConfig}
                    disabled={apiSaving || !apiKeyInput.trim()}
                  >
                    {apiSaving ? t("api_config_saving") : t("api_connect")}
                  </button>
                  {apiKeyConfigured && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleDisconnectApi}
                    >
                      {t("api_disconnect")}
                    </button>
                  )}
                </div>
              </div>
            )}
          {apiKeyConfigured &&
            !modelLocked &&
            (model?.startsWith("custom:") ||
              highlightedModel === "custom:deepseek-chat") && (
              <div className="api-config-inline">
                <div className="api-config-row">
                  <label>
                    {t("api_model_label")}{" "}
                    <span
                      className="info-tooltip"
                      data-tip={t("api_model_tooltip")}
                    >
                      ⓘ
                    </span>
                  </label>
                  <select
                    className="api-config-select"
                    value={apiModelName}
                    onChange={(e) => handleChangeApiModel(e.target.value)}
                  >
                    <option value="deepseek-chat">
                      deepseek-chat (DeepSeek V3)
                    </option>
                    <option value="deepseek-reasoner">
                      deepseek-reasoner (DeepSeek R1)
                    </option>
                  </select>
                </div>
                <div className="api-privacy-warning">
                  {t("api_privacy_warning")}
                </div>
                <div className="api-config-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleDisconnectApi}
                  >
                    {t("api_disconnect")}
                  </button>
                </div>
              </div>
            )}
        </>
      )}

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
            {!confirmEntry.allowed && hardware && (
              <p className="model-confirm-warn">
                {t("model_low_ram_warning")
                  .replace("{yourRam}", String(hardware.totalRamGb))
                  .replace(
                    "{minRam}",
                    String(
                      hardware.appleSilicon
                        ? confirmEntry.minRamAppleSiliconGb
                        : confirmEntry.minRamGb,
                    ),
                  )}
              </p>
            )}
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

      {confirmDelete && (
        <div className="model-confirm-overlay">
          <div className="model-confirm-dialog">
            <p className="model-confirm-text">
              {t("model_delete_warning")
                .replace("{name}", confirmDelete.name)
                .replace(
                  "{size}",
                  formatBytes(confirmDelete.sizeBytes) || "~20 GB",
                )}
            </p>
            <div className="model-confirm-actions">
              <button
                type="button"
                className="btn-primary model-delete-confirm"
                onClick={() => {
                  const fn = confirmDelete.fileName;
                  setConfirmDelete(null);
                  deleteModel(fn);
                }}
              >
                {t("model_delete")}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmDelete(null)}
              >
                {t("btn_cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="model-error">{error}</div>}
    </div>
  );
}

// ── Per-model tuning subsection ──
interface ModelConfig {
  num_ctx: number;
  num_predict: number;
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;
  no_mmap: boolean;
}

function ModelTuning({ fileName }: { fileName: string }) {
  const { lang } = useStore();
  const t = useTranslation(lang);
  const [cfg, setCfg] = useState<ModelConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const isCustom = fileName.startsWith("custom:");

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/models/${encodeURIComponent(fileName)}/config`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setCfg({
          num_ctx: isCustom ? 0 : (data.num_ctx ?? 0),
          num_predict: data.num_predict ?? 4096,
          temperature: data.temperature ?? 0.1,
          top_p: data.top_p ?? 0.8,
          top_k: data.top_k ?? 20,
          repeat_penalty: data.repeat_penalty ?? 1.05,
          no_mmap: isCustom ? false : !!data.no_mmap,
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

  function resetToDefaults() {
    fetch(`${BASE}/api/models/${encodeURIComponent(fileName)}/config`, {
      method: "DELETE",
    })
      .then((r) => r.json())
      .then((data) => {
        setCfg({
          num_ctx: data.num_ctx,
          num_predict: data.num_predict,
          temperature: data.temperature,
          top_p: data.top_p,
          top_k: data.top_k,
          repeat_penalty: data.repeat_penalty,
          no_mmap: !!data.no_mmap,
        });
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1200);
      })
      .catch(() => {});
  }

  // Number-slider helper: yields onChange/onMouseUp/onTouchEnd/onKeyUp
  // that update local state immediately and persist on release.
  function sliderProps<K extends keyof ModelConfig>(
    key: K,
    parse: (v: string) => ModelConfig[K],
  ) {
    return {
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setCfg((c) => (c ? { ...c, [key]: parse(e.target.value) } : c)),
      onMouseUp: (e: React.MouseEvent<HTMLInputElement>) =>
        save({
          ...(cfg as ModelConfig),
          [key]: parse((e.target as HTMLInputElement).value),
        }),
      onTouchEnd: (e: React.TouchEvent<HTMLInputElement>) =>
        save({
          ...(cfg as ModelConfig),
          [key]: parse((e.target as HTMLInputElement).value),
        }),
      onKeyUp: (e: React.KeyboardEvent<HTMLInputElement>) =>
        save({
          ...(cfg as ModelConfig),
          [key]: parse((e.target as HTMLInputElement).value),
        }),
    };
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

      {!isCustom && (
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
            {...sliderProps("num_ctx", (v) => Number(v))}
          />
          <span className="help-text">{t("context_window_help")}</span>
        </div>
      )}

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
          {...sliderProps("num_predict", (v) => Number(v))}
        />
        <span className="help-text">{t("max_output_help")}</span>
      </div>

      <div className="field">
        <label>
          {t("temperature_label")}: {cfg.temperature.toFixed(2)}
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={cfg.temperature}
          {...sliderProps("temperature", (v) => Number(v))}
        />
        <span className="help-text">{t("temperature_help")}</span>
      </div>

      <div className="field">
        <label>
          {t("top_p_label")}: {cfg.top_p.toFixed(2)}
        </label>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={cfg.top_p}
          {...sliderProps("top_p", (v) => Number(v))}
        />
        <span className="help-text">{t("top_p_help")}</span>
      </div>

      <div className="field">
        <label>
          {t("top_k_label")}: {cfg.top_k}
        </label>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={cfg.top_k}
          {...sliderProps("top_k", (v) => Number(v))}
        />
        <span className="help-text">{t("top_k_help")}</span>
      </div>

      <div className="field">
        <label>
          {t("repeat_penalty_label")}: {cfg.repeat_penalty.toFixed(2)}
        </label>
        <input
          type="range"
          min={1}
          max={1.5}
          step={0.01}
          value={cfg.repeat_penalty}
          {...sliderProps("repeat_penalty", (v) => Number(v))}
        />
        <span className="help-text">{t("repeat_penalty_help")}</span>
      </div>

      {!isCustom && (
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
      )}

      <div className="field">
        <button
          type="button"
          className="model-tuning-reset"
          onClick={resetToDefaults}
        >
          {t("reset_to_defaults")}
        </button>
      </div>
    </div>
  );
}
