// ── What an exported file is called ──
//
// Named from the manuscript, not from the pipeline. A French translation of
// "book 2.docx" arrived as "book 2.docx.full.docx": the import extension kept,
// a word from the export code appended, and nothing saying which language it
// is in — which is the one thing an author with four translations in a folder
// needs to see at a glance. Its sidecar inherited all of that and added
// ".formatting-notes".
//
// Pure, so the naming can be tested without a browser; the frontend has no
// test runner of its own.

/** Extensions a manuscript arrives with, and must not leave carrying. */
const IMPORT_EXT = /\.(docx|doc|epub|md|markdown|txt|pdf|rtf)$/i;

/**
 * Illegal or troublesome in a file name.
 *
 * The colon is the reason this exists: chapter titles carry them — "Chapter 5:
 * The Building Blocks of Non-Monogamy" — and it is the path separator in
 * Finder's own display and outright illegal on Windows.
 */
const UNSAFE = /[/\\:*?"<>|]/g;

/** Long enough for a real chapter title, short enough to read in a file list. */
const MAX_LENGTH = 80;

export interface ExportNameInput {
  /** The uploaded document's name, extension and all. */
  source: string;
  /** Everything, a selection, or a single chapter. */
  scope: "full" | "chapters" | "one";
  /** The chapter's own title, for scope "one". */
  chapterName?: string;
  /** Set only for a translation, and then it is the point of the name. */
  targetLang?: string;
}

function clean(name: string): string {
  const safe = name.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  // Trailing dots and spaces are dropped silently by Windows, which turns a
  // deliberate name into a slightly different one.
  return safe.slice(0, MAX_LENGTH).replace(/[ .]+$/, "");
}

/** The name an export is offered under, without its extension. */
export function exportBaseName(input: ExportNameInput): string {
  const { source, scope, chapterName, targetLang } = input;
  const stem = clean(source.replace(IMPORT_EXT, "")) || "manuscript";
  const subject = scope === "one" ? clean(chapterName ?? "") || stem : stem;

  if (targetLang) {
    // The language goes in parentheses after the title, the way a publisher's
    // edition would say it — and never as a suffix like ".full", which
    // describes how Betty ran rather than what the file is.
    const named = clean(`${subject} (${targetLang})`);
    return scope === "chapters" ? clean(`${named} chapters`) : named;
  }

  if (scope === "one") return clean(`${subject}.edited`);
  return clean(`${stem}.${scope === "chapters" ? "chapters" : "full"}`);
}

/**
 * A companion file's name, from the name of the file it belongs to.
 *
 * Built on the manuscript's own name so the two sort together in a folder and
 * it is obvious which export the notes describe.
 */
export function sidecarName(base: string, label: string): string {
  return clean(`${base} ${label}`);
}
