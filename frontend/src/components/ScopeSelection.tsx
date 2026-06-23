// ── Scope selection — Stage II ──

import { useMemo } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import type { EditUnit } from "../types";

type ScopeMode = "whole_book" | "selected_chapters" | "first_n_words";

const PROLOGUE_RE = /^(prologue|prolog|forord)/i;
const EPILOGUE_RE = /^(epilogue|epilog|efterord|afterword)/i;

export function shortChapterLabel(index: number, title: string): string {
  const trimmed = title.trim();
  if (/^frontmatter$/i.test(trimmed)) return "Frontmatter";
  if (PROLOGUE_RE.test(trimmed)) return "Prologue";
  if (EPILOGUE_RE.test(trimmed)) return "Epilogue";
  if (trimmed && !/^section\s+\d+$/i.test(trimmed)) return trimmed;
  return `Ch${index + 1}`;
}

export function buildUnits(
  md: string,
  chapters: { title: string; start: number; end: number; wordCount: number }[],
  mode: ScopeMode,
  selectedChapters: number[],
  firstNWords: number,
): EditUnit[] {
  if (
    mode === "selected_chapters" &&
    chapters.length > 0 &&
    selectedChapters.length > 0
  ) {
    return selectedChapters.map((i) => ({
      name: shortChapterLabel(i, chapters[i].title),
      original: md.slice(chapters[i].start, chapters[i].end).trim(),
    }));
  }

  if (mode === "first_n_words") {
    const words = md.split(/\s+/);
    let txt: string;
    if (firstNWords >= words.length) {
      txt = md;
    } else {
      const rough = words.slice(0, firstNWords).join(" ");
      const nb = md.indexOf("\n\n", rough.length);
      txt = nb > 0 && nb - rough.length < 2000 ? md.slice(0, nb) : rough;
    }
    return [
      {
        name: `First ${firstNWords.toLocaleString()} words`,
        original: txt.trim(),
      },
    ];
  }

  // whole_book: when chapters are detected, fan out into one unit per chapter
  // so the queue shows real progress and parallel workers can pick them up.
  if (chapters.length > 0) {
    return chapters.map((ch, i) => ({
      name: shortChapterLabel(i, ch.title),
      original: md.slice(ch.start, ch.end).trim(),
    }));
  }

  return [{ name: "Manuscript", original: md.trim() }];
}

export default function ScopeSelection() {
  const {
    lang,
    document: doc,
    documentMd,
    scopeMode,
    setScopeMode,
    selectedChapters,
    setSelectedChapters,
    firstNWords,
    setFirstNWords,
  } = useStore();
  const t = useTranslation(lang);

  const chapters = doc?.chapters ?? [];
  const units = useMemo(
    () =>
      buildUnits(
        documentMd,
        chapters,
        scopeMode,
        selectedChapters,
        firstNWords,
      ),
    [documentMd, chapters, scopeMode, selectedChapters, firstNWords],
  );
  const totalWords = useMemo(
    () =>
      units.reduce(
        (s, u) => s + u.original.split(/\s+/).filter(Boolean).length,
        0,
      ),
    [units],
  );
  const selectedSet = useMemo(
    () => new Set(selectedChapters),
    [selectedChapters],
  );

  if (!doc) return null;

  const scopeOptions: { value: ScopeMode; label: string }[] = [
    { value: "whole_book", label: t("whole_book") },
  ];
  if (chapters.length > 0) {
    scopeOptions.push({
      value: "selected_chapters",
      label: t("selected_chapters"),
    });
  }
  scopeOptions.push({ value: "first_n_words", label: t("first_n_words") });

  return (
    <section className="stage">
      <div className="section-label">
        {t("sec_scope")}
        <span className="info-tooltip" data-tip={t("tooltip_scope")}>
          ⓘ
        </span>
      </div>

      <div className="scope-options">
        {scopeOptions.map((opt) => (
          <label
            key={opt.value}
            className={`radio-option ${scopeMode === opt.value ? "active" : ""}`}
          >
            <input
              type="radio"
              name="scope"
              value={opt.value}
              checked={scopeMode === opt.value}
              onChange={() => setScopeMode(opt.value)}
            />
            {opt.label}
          </label>
        ))}
      </div>

      {scopeMode === "selected_chapters" && chapters.length > 0 && (
        <details className="chapter-select-details" open>
          <summary className="chapter-select-summary">
            {selectedChapters.length} of {chapters.length} chapters selected
          </summary>
          <div className="chapter-select">
            {chapters.map((ch, i) => (
              <label
                key={i}
                className={`chapter-option ${selectedSet.has(i) ? "selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selectedSet.has(i)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedChapters([...selectedChapters, i].sort());
                    } else {
                      setSelectedChapters(
                        selectedChapters.filter((j) => j !== i),
                      );
                    }
                  }}
                />
                {shortChapterLabel(i, ch.title)} (
                {ch.wordCount.toLocaleString()} w)
              </label>
            ))}
          </div>
        </details>
      )}

      {scopeMode === "first_n_words" && (
        <div className="field">
          <label>Words: {firstNWords.toLocaleString()}</label>
          <input
            type="range"
            min={500}
            max={Math.max(500, doc.wordCount)}
            step={500}
            value={Math.min(firstNWords, doc.wordCount)}
            onChange={(e) => setFirstNWords(Number(e.target.value))}
          />
        </div>
      )}

      {units.length > 0 && (
        <p className="small-note">
          ~ {totalWords.toLocaleString()} {t("words_selected")} {units.length}{" "}
          {t("units")}.
        </p>
      )}
    </section>
  );
}
