// ── i18n translation strings — ported from ui.py ──

export type Lang = "en" | "da";

const TRANSLATIONS: Record<string, Record<Lang, string>> = {
  subtitle: {
    en: "- But you can call me Betty",
    da: " - Men du kan kalde mig Betty",
  },
  settings: { en: "Settings", da: "Indstillinger" },
  language: { en: "Language", da: "Sprog" },
  model: { en: "Local model", da: "Lokal model" },
  model_help: {
    en: "No models installed yet. Download one from the setup screen.",
    da: "Ingen modeller installeret endnu. Download én fra opsætningsskærmen.",
  },
  words_per_chunk: { en: "Words per chunk", da: "Ord pr. chunk" },
  paragraph_overlap: { en: "Paragraph overlap", da: "Paragrafoverlap" },
  fast_mode: {
    en: "⚡ Fast mode (corrections only)",
    da: "⚡ Hurtig tilstand (kun rettelser)",
  },
  fast_mode_help: {
    en: "Returns a JSON list of edits instead of rewriting the whole chunk. Typically 3–10× faster.",
    da: "Returnerer en JSON-liste af rettelser. Typisk 3–10× hurtigere.",
  },
  parallel_chapters: { en: "Parallel chapters", da: "Parallelle kapitler" },
  parallel_help: {
    en: "Max concurrent editing workers. With large 27B+ models, leave at 1.",
    da: "Maks. parallelle arbejdere. Med store 27B+ modeller, behold på 1.",
  },
  style_guide: { en: "Style guide", da: "Stilguide" },
  style_guide_tip: {
    en: "List character names, place names, and house-style rules the editor must respect. The guide is sent with every chunk. Loaded automatically from style.md — edit inline, or upload a .md / .txt / .docx to replace.",
    da: "Angiv personnavne, stednavne og stilregler korrekturlæseren skal overholde. Guiden sendes med hver chunk. Indlæses automatisk fra style.md — rediger direkte, eller upload en .md / .txt / .docx.",
  },
  upload_style: { en: "Upload style guide", da: "Upload stilguide" },
  style_rules: { en: "Style rules", da: "Stilregler" },
  sec_manuscript: { en: "Manuscript", da: "Manuskript" },
  upload_prompt: {
    en: "Upload a .docx or .md to begin.",
    da: "Upload en .docx eller .md for at starte.",
  },
  lbl_file: { en: "file", da: "fil" },
  lbl_words: { en: "words", da: "ord" },
  lbl_chapters: { en: "chapters", da: "kapitler" },
  lbl_model: { en: "model", da: "model" },
  converting: {
    en: "Converting to Markdown…",
    da: "Konverterer til Markdown…",
  },
  sec_scope: { en: "Scope", da: "Omfang" },
  whole_book: { en: "Whole book", da: "Hele bogen" },
  selected_chapters: { en: "Selected chapters", da: "Udvalgte kapitler" },
  first_n_words: { en: "First N words", da: "Første N ord" },
  pick_chapters: { en: "Pick chapters…", da: "Vælg kapitler…" },
  select_one: {
    en: "Select at least one chapter.",
    da: "Vælg mindst ét kapitel.",
  },
  words_selected: { en: "words across", da: "ord fordelt på" },
  units: { en: "unit(s)", da: "enhed(er)" },
  sec_edit: { en: "Edit", da: "Rediger" },
  btn_add_to_queue: { en: "Add to queue", da: "Tilføj til kø" },
  queue_panel: { en: "Queue", da: "Kø" },
  queue_empty: {
    en: "Queue is empty — add chapters above.",
    da: "Køen er tom — tilføj kapitler ovenfor.",
  },
  status_queued: { en: "queued", da: "i kø" },
  status_editing: { en: "editing", da: "redigerer" },
  status_done: { en: "done", da: "færdig" },
  status_error: { en: "error", da: "fejl" },
  status_cancelled: { en: "cancelled", da: "annulleret" },
  clear_done: { en: "Clear completed", da: "Ryd færdige" },
  btn_cancel: { en: "Stop queue", da: "Stop køen" },
  add_doc: { en: "Add another document", da: "Tilføj nyt dokument" },
  queue_doc_uploader: { en: "Upload .docx / .md", da: "Upload .docx / .md" },
  n_pending: { en: "pending", da: "afventer" },
  n_running: { en: "running", da: "kører" },
  n_done: { en: "done", da: "færdige" },
  warn_unload: {
    en: "Editing is in progress. If you leave or refresh now, the queue will be lost.",
    da: "Redigering er i gang. Forlader du siden, mistes køen.",
  },
  sec_review: { en: "Review & Export", da: "Gennemgang & Eksport" },
  accepted: { en: "accepted", da: "accepteret" },
  no_changes: { en: "no changes", da: "ingen rettelser" },
  accept_all: { en: "Accept all", da: "Acceptér alle" },
  dismiss_all: { en: "Dismiss all", da: "Afvis alle" },
  no_corrections_unit: {
    en: "No corrections proposed.",
    da: "Ingen rettelser foreslået.",
  },
  skipped_label: {
    en: "skipped (markdown / ambiguity)",
    da: "sprunget over (markdown / tvetydighed)",
  },
  output_reflects: { en: "Output reflects", da: "Output afspejler" },
  of: { en: "of", da: "af" },
  proposed_changes: {
    en: "proposed change(s).",
    da: "foreslåede rettelse(r).",
  },
  converting_docx: { en: "Converting to DOCX…", da: "Konverterer til DOCX…" },
  docx_fail: {
    en: "DOCX conversion failed",
    da: "DOCX-konvertering mislykkedes",
  },
  preview_md: {
    en: "Preview edited Markdown",
    da: "Forhåndsvisning af redigeret Markdown",
  },
  results_for: { en: "Results for", da: "Resultater for" },
};

export function translate(key: string, lang: Lang = "en"): string {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  return entry[lang] ?? entry.en ?? key;
}

export default TRANSLATIONS;
