// ── i18n hook — ported from ui.py TRANSLATIONS ──

import type { Lang } from "./types";

const TRANSLATIONS: Record<string, Record<Lang, string>> = {
  subtitle: {
    en: "But you can call me Betty",
    da: "Men du kan kalde mig Betty",
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
  parallel_jobs: { en: "Parallel jobs", da: "Parallelle opgaver" },
  parallel_help: {
    en: "Concurrent jobs — auto-tuned when you pick a model.",
    da: "Samtidige opgaver — auto-justeret når du vælger en model.",
  },
  advanced_settings: {
    en: "Advanced settings",
    da: "Avancerede indstillinger",
  },
  style_guide: { en: "Style guide", da: "Stilguide" },
  style_guide_tooltip: {
    en: "The style guide gives the AI unique knowledge about your manuscript. List character names, place names, invented terms, fictional languages, and any house-style rules specific to your book. The more context you provide, the fewer false corrections you'll get.",
    da: "Stilguiden giver AI'en unik viden om dit manuskript. Angiv personnavne, stednavne, opfundne termer, fiktive sprog og eventuelle stilregler, der er specifikke for din bog. Jo mere kontekst du giver, desto færre falske rettelser får du.",
  },
  style_guide_tip: {
    en: "Add character names, places, invented terms, and anything unique to your manuscript that the editor should know.",
    da: "Tilføj personnavne, steder, opfundne termer og alt unikt for dit manuskript, som redaktøren bør kende.",
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
  clear_all: { en: "Clear all", da: "Ryd alt" },
  view_latest: { en: "View latest results", da: "Vis seneste resultater" },
  clear_warning: {
    en: "This will permanently remove all completed results. Are you sure?",
    da: "Dette vil permanent fjerne alle færdige resultater. Er du sikker?",
  },
  cancel_task: { en: "Cancel task", da: "Annullér opgave" },
  retry_task: { en: "Retry", da: "Forsøg igen" },
  retry_failed_chapters: {
    en: "Retry failed chapters",
    da: "Forsøg fejlede kapitler igen",
  },
  partial_failure_title: {
    en: "Some chapters did not complete cleanly",
    da: "Nogle kapitler blev ikke gennemført korrekt",
  },
  partial_failure_body: {
    en: "These chapters had chunks that failed even after retries and should be re-run",
    da: "Disse kapitler havde dele, der fejlede selv efter forsøg, og bør køres igen",
  },
  partial_failure_hint: {
    en: "Edited output for failed chunks falls back to the original text. Analysis output may be incomplete. Re-run the affected chapters from the upload screen.",
    da: "Redigeret output for fejlede dele falder tilbage til den oprindelige tekst. Analyseoutput kan være ufuldstændigt. Kør de berørte kapitler igen fra upload-skærmen.",
  },
  btn_cancel: { en: "Cancel", da: "Annuller" },
  n_pending: { en: "pending", da: "afventer" },
  n_running: { en: "running", da: "kører" },
  n_done: { en: "done", da: "færdige" },
  warn_unload: {
    en: "Editing is in progress. If you leave or refresh now, the queue will be lost.",
    da: "Redigering er i gang. Forlader du siden, mistes køen.",
  },
  sec_review: { en: "Review & Export", da: "Gennemgang & Eksport" },
  review_empty: {
    en: "Nothing here yet — results will appear once you run an edit.",
    da: "Tomt endnu — resultater vises når du kører en redigering.",
  },
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
    en: "No local models found — download one from setup.",
    da: "Ingen lokale modeller fundet — download én fra opsætning.",
  },
  retry: { en: "Retry", da: "Prøv igen" },
  download_md: { en: "Download Markdown", da: "Download Markdown" },
  download_docx: { en: "Download DOCX", da: "Download DOCX" },
  download_diff: { en: "Download diff report", da: "Download diff-rapport" },

  // ── Model setup ──
  model_section_title: { en: "Models", da: "Modeller" },
  model_needed_banner: {
    en: "No AI model installed — open Models below to download one before editing.",
    da: "Ingen AI-model installeret — åbn Modeller herunder for at downloade én før redigering.",
  },
  model_setup_title: {
    en: "Choose a model",
    da: "Vælg en model",
  },
  model_setup_desc: {
    en: "Bethaniel runs AI locally — your manuscripts never leave your computer. Download a model to get started.",
    da: "Bethaniel kører AI lokalt — dine manuskripter forlader aldrig din computer. Download en model for at komme i gang.",
  },
  model_requires: { en: "Requires", da: "Kræver" },
  model_your_machine: { en: "your machine has", da: "din maskine har" },
  model_installed: { en: "Installed", da: "Installeret" },
  model_download: { en: "Download", da: "Download" },
  model_delete: { en: "Delete", da: "Slet" },
  model_cancel_download: { en: "Cancel download", da: "Annullér download" },
  model_download_warning: {
    en: "Downloading {name} will use approximately {size} of disk space and internet data. Continue?",
    da: "{name} fylder ca. {size} og kræver tilsvarende dataforbrug at downloade. Fortsæt?",
  },
  model_insufficient_ram: {
    en: "Insufficient RAM",
    da: "Utilstrækkelig RAM",
  },
  model_recommended: {
    en: "Recommended",
    da: "Anbefalet",
  },
  model_continue: {
    en: "Continue to Bethaniel",
    da: "Fortsæt til Bethaniel",
  },
  model_vip_coming_soon: { en: "Not Available", da: "Ikke tilgængelig" },
  no_models_warning: {
    en: "No models installed. Download one from the initial setup.",
    da: "Ingen modeller installeret. Download én fra den indledende opsætning.",
  },

  // ── Section headings ──
  sec_model: {
    en: "Choose your Betty",
    da: "Vælg din Betty",
  },
  sec_mode: { en: "How can I help you?", da: "Hvordan kan jeg hjælpe dig?" },
  sec_content: {
    en: "Let's have a look at your content",
    da: "Lad os kigge på dit indhold",
  },
  sec_output: { en: "Output", da: "Output" },
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
    en: "Extract a catalog of all characters, locations, and important events.",
    da: "Udtræk et katalog over alle personer, steder og vigtige begivenheder.",
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
  opt_englishDialect: {
    en: "English dialect",
    da: "Engelsk dialekt",
  },
  opt_american: { en: "American", da: "Amerikansk" },
  opt_british: { en: "British", da: "Britisk" },
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

  // ── Tooltips ──
  tooltip_manuscript: {
    en: "Upload your manuscript as a .docx or Markdown file. Bethaniel will split it into chapters automatically. Your file never leaves your computer.",
    da: "Upload dit manuskript som .docx eller Markdown. Bethaniel opdeler det automatisk i kapitler. Din fil forlader aldrig din computer.",
  },
  tooltip_scope: {
    en: "Choose how much of your manuscript to process — the whole book, specific chapters, or just the first few thousand words for a quick test run.",
    da: "Vælg hvor meget af dit manuskript der skal behandles — hele bogen, udvalgte kapitler eller blot de første par tusinde ord som en hurtig testkørsel.",
  },
  tooltip_mode: {
    en: "Pick one or more tasks. Copy edit fixes grammar and spelling. Line edit improves prose quality. Analysis extracts characters, locations, or timelines. You can combine multiple tasks in one run.",
    da: "Vælg én eller flere opgaver. Korrektur retter grammatik og stavning. Stilredigering forbedrer prosastil. Analyse udtrækker personer, steder eller tidslinjer. Du kan kombinere flere opgaver i én kørsel.",
  },
  tooltip_queue: {
    en: "The queue shows all running and completed tasks. Each chapter is processed independently and you can track progress in real time.",
    da: "Køen viser alle kørende og færdige opgaver. Hvert kapitel behandles uafhængigt, og du kan følge fremskridtet i realtid.",
  },
  tooltip_review: {
    en: "Review the AI's suggestions chapter by chapter. Accept or dismiss individual corrections, then export the edited manuscript as DOCX or Markdown.",
    da: "Gennemgå AI'ens forslag kapitel for kapitel. Acceptér eller afvis individuelle rettelser, og eksportér derefter det redigerede manuskript som DOCX eller Markdown.",
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
