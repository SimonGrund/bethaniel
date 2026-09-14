// ── Names & terms ──
//
// The manuscript's own vocabulary, harvested on upload (backend/src/lexicon.ts)
// and confirmed here. It sits above the free-text style sheet because it does
// the same job — "this is deliberate, do not correct it" — with the one
// difference that Betty filled it in. A ticked term is enforced, not advised:
// a correction that would change it is dropped before anyone reviews it.
//
// The store holds the author's answer; this component is what saves it. A
// tick is saved a moment after the last change rather than on every click,
// and a save that fails says so instead of pretending.

import { useEffect, useRef, useState } from "react";

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { putLexicon } from "../api";
import type { Lexicon, LexiconKind, LexiconTerm } from "../types";

const SAVE_DELAY_MS = 400;

const GROUPS: { kind: LexiconKind; key: string }[] = [
  { kind: "name", key: "lexicon_group_names" },
  { kind: "phrase", key: "lexicon_group_phrases" },
  { kind: "word", key: "lexicon_group_words" },
];

export default function LexiconPanel() {
  const lang = useStore((s) => s.lang);
  const docId = useStore((s) => s.document?.id ?? null);
  const lexicon = useStore((s) => s.lexicon);
  const toggleLexiconTerm = useStore((s) => s.toggleLexiconTerm);
  const setAllLexiconTerms = useStore((s) => s.setAllLexiconTerms);
  const addLexiconTerm = useStore((s) => s.addLexiconTerm);
  const removeLexiconTerm = useStore((s) => s.removeLexiconTerm);
  const markLexiconReviewed = useStore((s) => s.markLexiconReviewed);
  const t = useTranslation(lang);

  const [draft, setDraft] = useState("");
  const [addNote, setAddNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Opening the list is reviewing it: the button outside stops asking.
  useEffect(() => {
    markLexiconReviewed();
  }, [markLexiconReviewed]);

  // Save what changed, once it stops changing. The first render's value is
  // what the server already has, so it is remembered rather than re-sent.
  const lastSaved = useRef<Lexicon | null>(lexicon);
  useEffect(() => {
    if (!docId || !lexicon || lexicon === lastSaved.current) return;
    const timer = setTimeout(() => {
      putLexicon(docId, lexicon)
        .then(() => {
          lastSaved.current = lexicon;
          setSaveError(null);
        })
        .catch((err: unknown) => {
          setSaveError(err instanceof Error ? err.message : String(err));
        });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [docId, lexicon]);

  const terms = lexicon?.terms ?? [];
  const enabled = terms.filter((x) => x.enabled).length;

  const submitDraft = () => {
    const value = draft.trim();
    if (!value) return;
    if (addLexiconTerm(value)) {
      setDraft("");
      setAddNote(null);
    } else {
      setAddNote(t("lexicon_add_duplicate"));
    }
  };

  const renderPill = (term: LexiconTerm) => (
    <label
      key={term.term}
      className={`lexicon-pill${term.enabled ? " selected" : ""}`}
      title={
        term.variants && term.variants.length > 0
          ? t("lexicon_variants").replace("{list}", term.variants.join(", "))
          : undefined
      }
    >
      <input
        type="checkbox"
        checked={term.enabled}
        onChange={(e) => toggleLexiconTerm(term.term, e.target.checked)}
      />
      <span className="lexicon-pill-term">{term.term}</span>
      {term.source === "manual" ? (
        <button
          type="button"
          className="lexicon-pill-remove"
          aria-label={t("lexicon_remove")}
          title={t("lexicon_remove")}
          onClick={(e) => {
            e.preventDefault();
            removeLexiconTerm(term.term);
          }}
        >
          ×
        </button>
      ) : (
        <span className="lexicon-pill-count">×{term.count}</span>
      )}
    </label>
  );

  return (
    <section className="lexicon-panel">
      <div className="lexicon-header">
        <h3 className="lexicon-title">
          {t("lexicon_title")}
          {terms.length > 0 && (
            <span className="lexicon-count">
              {t("lexicon_count")
                .replace("{n}", String(enabled))
                .replace("{m}", String(terms.length))}
            </span>
          )}
        </h3>
        {terms.length > 1 && (
          <div className="lexicon-actions">
            <button type="button" onClick={() => setAllLexiconTerms(true)}>
              {t("lexicon_tick_all")}
            </button>
            <button type="button" onClick={() => setAllLexiconTerms(false)}>
              {t("lexicon_untick_all")}
            </button>
          </div>
        )}
      </div>
      <p className="dialog-intro">{t("lexicon_intro")}</p>

      {terms.length === 0 && <p className="small-note">{t("lexicon_empty")}</p>}

      {GROUPS.map(({ kind, key }) => {
        const group = terms.filter((x) => x.kind === kind);
        if (group.length === 0) return null;
        return (
          <div className="lexicon-group" key={kind}>
            <div className="lexicon-group-title">{t(key)}</div>
            <div className="lexicon-list">{group.map(renderPill)}</div>
          </div>
        );
      })}

      {lexicon && lexicon.nearMisses.length > 0 && (
        <details className="lexicon-near-misses">
          <summary className="small-note">
            {t("lexicon_near_misses").replace("{n}", String(lexicon.nearMisses.length))}
          </summary>
          <ul>
            {lexicon.nearMisses.map((n) => (
              <li key={`${n.of}:${n.term}`}>
                <span className="word-del">{n.term}</span>
                {" "}
                <span className="lexicon-near-of">
                  {t("lexicon_near_miss_of").replace("{of}", n.of)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="lexicon-add">
        <input
          type="text"
          className="lang-input"
          value={draft}
          placeholder={t("lexicon_add_placeholder")}
          onChange={(e) => {
            setDraft(e.target.value);
            if (addNote) setAddNote(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitDraft();
            }
          }}
        />
        <button
          type="button"
          className="btn-secondary btn-small"
          onClick={submitDraft}
          disabled={!draft.trim()}
        >
          {t("lexicon_add")}
        </button>
        {addNote && <span className="small-note">{addNote}</span>}
      </div>

      {saveError && (
        <p className="small-note lexicon-save-error">
          {t("lexicon_save_failed").replace("{error}", saveError)}
        </p>
      )}
    </section>
  );
}
