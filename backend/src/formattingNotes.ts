// ── The sidecar: what the translation could not carry across ──
//
// A translation replaces a whole paragraph, so emphasis *inside* it cannot
// survive: there is no way to know which French words the italics in an
// English sentence belong to. The export says how many paragraphs that
// happened to, which told the author something was lost without saying what,
// and left reading the book against the original as the only way to find out.
//
// This is that list. A separate document on purpose — putting a hundred
// comments into a manuscript someone is about to publish is a change to the
// file they did not ask for, and the surgical export's whole promise is that
// it does not make those.

import type { FlattenedParagraph } from "./docxSurgery.js";

/** Longest excerpt shown per paragraph, so the list stays scannable. */
const EXCERPT_CHARS = 180;

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS
    ? `${flat.slice(0, EXCERPT_CHARS).trimEnd()}…`
    : flat;
}

export interface NotesStrings {
  title: string;
  intro: string;
  /** "{count} paragraph(s)" */
  summary: string;
  wasEmphasised: string;
  noneRecorded: string;
  paragraphLabel: string;
}

/**
 * The notes, as Markdown.
 *
 * Markdown rather than a built .docx directly, because the exporter already
 * turns Markdown into Word and this way the same text can be shown in-app or
 * saved as anything else without a second formatter.
 *
 * Returns null when there is nothing to say — a caller should not offer a
 * download of an empty document.
 */
export function buildFormattingNotes(
  flattened: readonly FlattenedParagraph[],
  source: string,
  s: NotesStrings,
): string | null {
  if (flattened.length === 0) return null;

  const lines: string[] = [
    `# ${s.title}`,
    "",
    `**${source}**`,
    "",
    s.intro,
    "",
    s.summary.replace("{count}", String(flattened.length)),
    "",
  ];

  for (const [i, f] of flattened.entries()) {
    lines.push(`## ${s.paragraphLabel.replace("{n}", String(i + 1))}`);
    lines.push("");
    lines.push(`> ${excerptOf(f.before)}`);
    lines.push("");
    // Filtered here as well as at the source: this is what renders the
    // bullets, so it is what must not render an empty one.
    const emphasised = f.emphasised.map(excerptOf).filter(Boolean);
    if (emphasised.length > 0) {
      lines.push(`${s.wasEmphasised}`);
      lines.push("");
      for (const e of emphasised) lines.push(`- ${e}`);
    } else {
      // The runs differed in formatting but carried no text of their own — a
      // spacing run, a bookmark. Say so rather than printing an empty list.
      lines.push(s.noneRecorded);
    }
    lines.push("");
  }

  return lines.join("\n");
}
