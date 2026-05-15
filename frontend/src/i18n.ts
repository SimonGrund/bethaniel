// ── i18n hook — ported from ui.py TRANSLATIONS ──

import type { Lang } from "./types";

const TRANSLATIONS: Record<string, Record<Lang, string>> = {
  subtitle: {
    en: "a private copy editor for pre-print",
    da: "en privat korrekturlæser",
  },
  settings: { en: "Settings", da: "Indstillinger" },
  language: { en: "Language", da: "Sprog" },
  model: { en: "Ollama model", da: "Ollama-model" },
  model_help: {
    en: "Could not detect installed models. Type the name manually.",
    da: "Kunne ikke finde installerede modeller. Indtast navnet manuelt.",
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
  parallel_jobs: { en: "Parallel jobs", da: "Parallelle opgaver" },
  parallel_help: {
    en: "Concurrent jobs. Click Auto to estimate based on RAM, CPU, and model size.",
    da: "Samtidige opgaver. Klik Auto for at estimere ud fra RAM, CPU og modelstørrelse.",
  },
  style_guide: { en: "Style guide", da: "Stilguide" },
  style_guide_tooltip: {
    en: "The style guide is sent with every text chunk to the AI editor. Use it to list character names, place names, invented terms, and house-style rules (e.g. British vs American spelling, Oxford comma preference). The more specific you are, the fewer false corrections you'll get.",
    da: "Stilguiden sendes med hver tekstdel til AI-korrekturlæseren. Brug den til at angive personnavne, stednavne, opfundne termer og stilregler (f.eks. britisk vs. amerikansk stavning, Oxford-komma). Jo mere specifik du er, desto færre falske rettelser får du.",
  },
  style_guide_tip: {
    en: "List character names, place names, and house-style rules the editor must respect. The guide is sent with every chunk.",
    da: "Angiv personnavne, stednavne og stilregler korrekturlæseren skal overholde. Guiden sendes med hver chunk.",
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
  btn_add_to_queue: { en: "Start job", da: "Start opgave" },
  btn_change_document: { en: "Change document", da: "Skift dokument" },
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
    en: "skipped",
    da: "sprunget over",
  },
  skipped_tooltip: {
    en: "These corrections were skipped because they touched markdown formatting (headings, bold, italic, links) or were ambiguous (e.g. the original text couldn't be uniquely located). This is a safety measure to avoid corrupting the document structure.",
    da: "Disse rettelser blev sprunget over fordi de berørte markdown-formattering (overskrifter, fed, kursiv, links) eller var tvetydige (f.eks. kunne originalteksten ikke entydigt lokaliseres). Dette er en sikkerhedsforanstaltning for at undgå at ødelægge dokumentstrukturen.",
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
  ollama_warning: {
    en: "Cannot reach Ollama — is it running?",
    da: "Kan ikke nå Ollama — kører den?",
  },
  retry: { en: "Retry", da: "Prøv igen" },
  download_md: { en: "Download Markdown", da: "Download Markdown" },
  download_docx: { en: "Download DOCX", da: "Download DOCX" },
  download_diff: { en: "Download diff report", da: "Download diff-rapport" },

  // ── Task mode ──
  sec_mode: { en: "Task mode", da: "Opgavetype" },
  group_editing: { en: "Editing", da: "Redigering" },
  group_analysis: { en: "Analysis", da: "Analyse" },
  group_translate: { en: "Translation", da: "Oversættelse" },
  workflow_label: { en: "Workflow", da: "Arbejdsgang" },
  mode_copy_edit: { en: "Copy edit", da: "Korrektur" },
  mode_line_edit: { en: "Line edit", da: "Stilredigering" },
  mode_translate: { en: "Translation", da: "Oversættelse" },
  mode_character_catalog: { en: "Character catalog", da: "Personkatalog" },
  mode_location_catalog: { en: "Location catalog", da: "Stedkatalog" },
  mode_timeline: { en: "Timeline", da: "Tidslinje" },
  mode_combined_analysis: {
    en: "Combined analysis",
    da: "Kombineret analyse",
  },
  mode_combined_edit: {
    en: "Combined edit",
    da: "Kombineret redigering",
  },
  mode_analysis_summary: {
    en: "Analysis summary",
    da: "Analyseopsummering",
  },
  mode_desc_copy_edit: {
    en: "Fix spelling, punctuation, and grammar.",
    da: "Ret stavning, tegnsætning og grammatik.",
  },
  mode_desc_line_edit: {
    en: "Improve prose quality, phrasing, and rhythm.",
    da: "Forbedr prosasttil, formulering og rytme.",
  },
  mode_desc_translate: {
    en: "Translate the text to a target language.",
    da: "Oversæt teksten til et målsprog.",
  },
  mode_desc_character_catalog: {
    en: "Extract a catalog of all characters.",
    da: "Udtræk et katalog over alle personer.",
  },
  mode_desc_location_catalog: {
    en: "Extract a catalog of all locations.",
    da: "Udtræk et katalog over alle steder.",
  },
  mode_desc_timeline: {
    en: "Extract a timeline of events.",
    da: "Udtræk en tidslinje over begivenheder.",
  },
  target_language: { en: "Target language", da: "Målsprog" },
  // Copy edit options
  opt_spelling: { en: "Spelling", da: "Stavning" },
  opt_punctuation: { en: "Punctuation", da: "Tegnsætning" },
  opt_capitalization: { en: "Capitalization", da: "Store/små bogstaver" },
  opt_duplicateWords: { en: "Duplicate words", da: "Duplikerede ord" },
  opt_britishToAmerican: {
    en: "British → American spelling",
    da: "Britisk → amerikansk stavning",
  },
  opt_oxfordComma: { en: "Oxford comma", da: "Oxford-komma" },
  opt_dialogueTags: { en: "Dialogue tags", da: "Dialogmarkører" },
  // Line edit options
  opt_awkwardPhrasing: { en: "Awkward phrasing", da: "Klodsede formuleringer" },
  opt_redundancy: { en: "Redundancy", da: "Redundans" },
  opt_weakVerbs: { en: "Weak verbs", da: "Svage verber" },
  opt_cliches: { en: "Clichés", da: "Klichéer" },
  opt_showDontTell: { en: "Show, don't tell", da: "Vis, fortæl ikke" },
  opt_sentenceRhythm: { en: "Sentence rhythm", da: "Sætningsrytme" },
  opt_dialogueNaturalness: {
    en: "Dialogue naturalness",
    da: "Dialognaturlighed",
  },
  opt_tightenProse: { en: "Tighten prose", da: "Stram prosa" },
  // Analysis result headings
  col_name: { en: "Name", da: "Navn" },
  col_aliases: { en: "Aliases", da: "Aliaser" },
  col_first_mention: { en: "First mention", da: "Første omtale" },
  col_description: { en: "Description", da: "Beskrivelse" },
  col_chapter: { en: "Chapter", da: "Kapitel" },
  col_event: { en: "Event", da: "Begivenhed" },
  col_characters: { en: "Characters", da: "Personer" },
  col_time_ref: { en: "Time reference", da: "Tidsreference" },
  no_structured_data: {
    en: "No structured data returned.",
    da: "Ingen strukturerede data returneret.",
  },
  aggregated_summary: {
    en: "Summary across all chapters",
    da: "Opsummering på tværs af alle kapitler",
  },
  per_chapter_breakdown: {
    en: "Per-chapter breakdown",
    da: "Opdeling pr. kapitel",
  },
  prose_summary: {
    en: "Prose summary",
    da: "Prosa-opsummering",
  },
  detailed_analysis_data: {
    en: "Detailed analysis data",
    da: "Detaljerede analysedata",
  },
};

export function useTranslation(lang: Lang) {
  return (key: string): string => {
    const entry = TRANSLATIONS[key];
    if (!entry) return key;
    return entry[lang] ?? entry.en ?? key;
  };
}

export default TRANSLATIONS;
