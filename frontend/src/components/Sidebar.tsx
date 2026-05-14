// ── Sidebar component ──

import { useEffect } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { fetchModels } from "../api";

export default function Sidebar() {
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
    fastMode,
    setFastMode,
    parallel,
    setParallel,
  } = useStore();
  const t = useTranslation(lang);

  useEffect(() => {
    fetchModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  const preferredModels = ["qwen3:32b", "qwen3:14b", "gemma4:27b", "betty"];
  const defaultModel =
    models.find((m) => preferredModels.includes(m)) ?? models[0] ?? "qwen3:32b";

  useEffect(() => {
    if (models.length > 0 && !models.includes(model)) {
      setModel(defaultModel);
    }
  }, [models]);

  return (
    <aside className="sidebar">
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
        <label className="section-label">{t("settings")}</label>

        {models.length > 0 ? (
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
        ) : (
          <div className="warning-box">
            <p>⚠️ {t("ollama_warning")}</p>
            <button onClick={() => fetchModels().then(setModels)}>
              🔄 {t("retry")}
            </button>
            <div className="field" style={{ marginTop: "0.5rem" }}>
              <label>{t("model")}</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="qwen3:32b"
              />
            </div>
          </div>
        )}

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

        <div className="field toggle-field">
          <label>
            <input
              type="checkbox"
              checked={fastMode}
              onChange={(e) => setFastMode(e.target.checked)}
            />
            {t("fast_mode")}
          </label>
          <span className="help-text">{t("fast_mode_help")}</span>
        </div>

        <div className="field">
          <label>
            {t("parallel_chapters")}: {parallel}
          </label>
          <input
            type="range"
            min={1}
            max={4}
            step={1}
            value={parallel}
            onChange={(e) => setParallel(Number(e.target.value))}
          />
          <span className="help-text">{t("parallel_help")}</span>
        </div>
      </div>
    </aside>
  );
}
