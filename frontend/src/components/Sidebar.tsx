// ── Sidebar component ──

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { fetchModels, fetchSystemRecommendation } from "../api";
import ModelSetup from "./ModelSetup";

export default function Sidebar({
  needsModel,
  onModelInstalled,
}: {
  needsModel: boolean;
  onModelInstalled: () => void;
}) {
  const {
    lang,
    setLang,
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
  const [showSettings, setShowSettings] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoInfo, setAutoInfo] = useState<string | null>(null);

  async function autoTuneParallel() {
    setAutoBusy(true);
    try {
      const r = await fetchSystemRecommendation(model);
      setParallel(r.recommendedParallel);
      setAutoInfo(
        `${r.recommendedParallel} jobs — ${r.modelSizeGb} GB model + ~${r.kvPerJobGb} GB/job, ${r.usableRamGb} GB usable RAM, ${r.cpuCount} CPUs (${r.modelSource})`,
      );
    } catch {
      setAutoInfo("Auto-tune failed");
    } finally {
      setAutoBusy(false);
    }
  }

  useEffect(() => {
    fetchModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  const preferredModels = [
    "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    "gemma-3n-E4B-it-Q4_K_M.gguf",
  ];
  const defaultModel =
    models.find((m) => preferredModels.includes(m)) ?? models[0] ?? "";

  useEffect(() => {
    if (models.length > 0 && !models.includes(model)) {
      setModel(defaultModel);
    }
  }, [models]);

  const [showModels, setShowModels] = useState(needsModel);

  return (
    <aside className="sidebar">
      {needsModel && (
        <div className="sidebar-section model-needed-banner">
          <p>⚠️ {t("model_needed_banner")}</p>
        </div>
      )}

      <div className="sidebar-section">
        <label className="sidebar-label">{t("language")}</label>
        <div className="lang-toggle">
          <button
            className={lang === "en" ? "active" : ""}
            onClick={() => setLang("en")}
          >
            English
          </button>
          <button
            className={lang === "da" ? "active" : ""}
            onClick={() => setLang("da")}
          >
            Dansk
          </button>
        </div>
      </div>

      <div className="sidebar-section">
        <button
          className="expander-toggle"
          onClick={() => setShowSettings(!showSettings)}
        >
          {showSettings ? "▾" : "▸"} {t("settings")}
        </button>

        {showSettings && models.length > 0 && (
          <div className="field">
            <label>{t("model")}</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        )}

        {showSettings && (
          <>
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
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginTop: "0.25rem",
                }}
              >
                <button
                  type="button"
                  onClick={autoTuneParallel}
                  disabled={autoBusy}
                  className="btn-secondary"
                  style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }}
                >
                  {autoBusy ? "…" : "Auto"}
                </button>
                <span className="help-text">{t("parallel_help")}</span>
              </div>
              {autoInfo && (
                <div
                  className="help-text"
                  style={{
                    marginTop: "0.25rem",
                    fontSize: "0.75rem",
                    opacity: 0.8,
                  }}
                >
                  {autoInfo}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="sidebar-section">
        <button
          className="expander-toggle"
          onClick={() => setShowModels(!showModels)}
        >
          {showModels ? "▾" : "▸"} {t("model_section_title")}
          {needsModel && <span className="needs-attention-dot" />}
        </button>

        {showModels && (
          <ModelSetup
            onModelInstalled={() => {
              onModelInstalled();
              fetchModels().then(setModels);
            }}
          />
        )}
      </div>
    </aside>
  );
}
