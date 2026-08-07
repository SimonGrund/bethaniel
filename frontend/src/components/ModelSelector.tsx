// ── Model selector — three colored Betty cards ──

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { refreshModelEnvironment, useStartDownload } from "../useModelRuntime";
import {
  fetchCustomModelConfig,
  saveCustomModelConfig,
  saveCustomModelName,
  deleteCustomModelConfig,
  fetchCustomGgufConfig,
  saveCustomGgufConfig,
  deleteCustomGgufConfig,
} from "../api";
import type { CatalogEntry } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? "";

const TIER_COLORS: Record<string, string> = {
  small: "model-tier-green",
  normal: "model-tier-blue",
  big: "model-tier-purple",
  custom: "model-tier-custom",
};

// A style-appropriate icon per model. The local Bettys follow a size
// progression (hatchling → bird → owl) echoing the quill/feather logo;
// the two custom Bettys get their own marks (cloud for the API, tools for
// a user-supplied GGUF).
function modelIcon(fileName: string, tier: string): string {
  if (fileName === "custom:deepseek-chat") return "☁️";
  if (fileName === "custom:gguf") return "🛠️";
  switch (tier) {
    case "small":
      return "🐣";
    case "normal":
      return "🐦";
    case "big":
      return "🦉";
    default:
      return "✒️";
  }
}

export default function ModelSelector() {
  const {
    lang,
    model,
    setModel,
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
    retextCheck,
    setRetextCheck,
    grammarCheck,
    setGrammarCheck,
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
    downloads,
    setDownloadProgress,
    clearDownload,
    downloadError,
    setDownloadError,
    // Model environment — fetched and kept current by useModelRuntime, which
    // App mounts once. This component only reads it.
    catalog,
    hardware,
    installed,
    recommendation,
    maxParallel,
  } = useStore();
  const t = useTranslation(lang);
  const startModelDownload = useStartDownload();

  const modelLocked = Object.values(tasks).some(
    (task) => task.status === "queued" || task.status === "editing",
  );

  const [showAdvanced, setShowAdvanced] = useState(false);

  // Download progress is owned by the store (updated by the App-level socket
  // listener) so it survives this component unmounting between setup menus.
  const downloading = useMemo(
    () => new Set(Object.keys(downloads)),
    [downloads],
  );
  const progressMap = useMemo(
    () => new Map(Object.entries(downloads)),
    [downloads],
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<CatalogEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CatalogEntry | null>(null);

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

  /**
   * Reload everything this panel shows.
   *
   * The shared environment (hardware, catalog, installed list) comes from the
   * runtime hook so it stays consistent app-wide; the two credential configs
   * are only ever edited here, so they stay local.
   */
  function refreshAll() {
    return Promise.all([
      refreshModelEnvironment(),
      fetchCustomModelConfig().catch(
        () => ({ configured: false, model: "" }) as const,
      ),
      fetchCustomGgufConfig().catch(
        () => ({ configured: false, path: "" }) as const,
      ),
    ]).then(([, customCfg, ggufCfg]) => {
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
      await refreshAll();
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
      await refreshAll();
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
      await refreshAll();
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
      await refreshAll();
    } catch (err) {
      setCustomGgufError(err instanceof Error ? err.message : String(err));
    }
  }

  // Surface a download error reported by the App-level listener, then clear it.
  useEffect(() => {
    if (downloadError) {
      setError(downloadError);
      setDownloadError(null);
    }
  }, [downloadError, setDownloadError]);

  // Credential configs are this panel's own; the shared model environment is
  // already loaded and kept current by useModelRuntime.
  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the External/Custom Betty config panels when a local model is picked.
  useEffect(() => {
    if (model && !model.startsWith("custom:")) {
      setApiConfigOpen(false);
      setCustomGgufConfigOpen(false);
    }
  }, [model]);

  async function startDownload(modelId: string, name?: string) {
    setError(null);
    const res = await startModelDownload(modelId, name);
    if (!res.ok) setError(res.error);
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
    clearDownload(modelId);
  }

  async function deleteModel(fileName: string) {
    await fetch(`${BASE}/api/models/${encodeURIComponent(fileName)}`, {
      method: "DELETE",
    });
    await refreshAll();
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return "";
    const gb = bytes / 1024 ** 3;
    return gb >= 1
      ? `${gb.toFixed(1)} GB`
      : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }

  // The recommendation is the backend's call — one source of truth, weighing
  // GPU class and measured throughput rather than RAM alone. This used to be
  // derived here from `allowedTiers.reverse()[0]`, which always resolved to
  // "custom" (Custom and External Betty share that tier at minRam 0), so the
  // badge landed on the cloud card on every machine.
  const recommendedFileName = recommendation?.fileName ?? null;
  // Nothing at all fits in RAM: the recommendation is still shown, but framed
  // as "best available here" alongside the under-spec warning.
  const anyAllowed = (hardware?.allowedTiers ?? []).some((tier) =>
    ["small", "normal", "big"].includes(tier),
  );

  return (
    <div className="model-selector">
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
            const isRecommended = entry.fileName === recommendedFileName;
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
                    isRecommended ? "model-card-recommended" : "",
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
                  <span className="model-card-icon" aria-hidden="true">
                    {modelIcon(entry.fileName, entry.tier)}
                  </span>
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
                      {/* Badge the recommendation even before it is installed —
                          on a fresh machine nothing is, and the whole point is
                          to point at one card. */}
                      {isRecommended && (
                        <span className="model-recommended-badge">
                          {t("model_recommended")}
                        </span>
                      )}
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
              {/* The Speed/Balanced/Max choice now lives in the sidebar, above
                  the Run button, where every user can see it. Hand-tuning any
                  knob below still flips that slider to "Custom". */}

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
                    checked={retextCheck}
                    onChange={(e) => setRetextCheck(e.target.checked)}
                  />{" "}
                  {t("retext_check")}
                </label>
                <span className="help-text">{t("retext_check_help")}</span>
              </div>

              <div className="field">
                <label className="option-check">
                  <input
                    type="checkbox"
                    checked={grammarCheck}
                    onChange={(e) => setGrammarCheck(e.target.checked)}
                  />{" "}
                  {t("grammar_check")}
                </label>
                <span className="help-text">{t("grammar_check_help")}</span>
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
                <label>{t("api_model_label")}</label>
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
                  <label>{t("api_model_label")}</label>
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
                  const name = confirmEntry.name;
                  setConfirmEntry(null);
                  startDownload(id, name);
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
