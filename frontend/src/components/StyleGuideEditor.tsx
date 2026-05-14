// ── Style guide editor ──

import { useState, useRef, useEffect } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { getStyleGuide, updateStyleGuide, uploadStyleGuide } from "../api";

export default function StyleGuideEditor() {
  const { lang, styleGuide, setStyleGuide } = useStore();
  const t = useTranslation(lang);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) {
      getStyleGuide()
        .then((content) => {
          setStyleGuide(content);
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  }, [loaded]);

  const handleSave = () => {
    updateStyleGuide(styleGuide);
  };

  const handleUpload = async (file: File) => {
    try {
      const content = await uploadStyleGuide(file);
      setStyleGuide(content);
    } catch (err) {
      console.error("Style guide upload failed:", err);
    }
  };

  return (
    <div className="style-guide-section">
      <button
        className="expander-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "▾" : "▸"} {t("style_guide")}
      </button>
      <span className="info-tooltip" title={t("style_guide_tooltip")}>
        ⓘ
      </span>

      {expanded && (
        <div className="style-guide-body">
          <p className="small-note">{t("style_guide_tip")}</p>
          <div className="style-guide-layout">
            <textarea
              className="style-textarea"
              value={styleGuide}
              onChange={(e) => setStyleGuide(e.target.value)}
              onBlur={handleSave}
              rows={10}
            />
            <div className="style-upload">
              <input
                ref={fileRef}
                type="file"
                accept=".md,.txt,.docx"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUpload(file);
                }}
              />
              <button
                className="btn-secondary"
                onClick={() => fileRef.current?.click()}
              >
                {t("upload_style")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
