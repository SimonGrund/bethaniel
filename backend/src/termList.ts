// ── The author's own term list ──
//
// What an author pastes (or uploads) before a paid translation, on the first
// card after payment. Two kinds of content come in through the same field:
//
//   - rows: "term = translation", tab- or comma-separated columns, a Markdown
//     table. These are read HERE, by code, exactly as written. A client's
//     300-term list must not pass through a model that could reword a term,
//     and as rows it costs no model output and is not capped at the forty
//     rows Betty proposes herself.
//   - everything else: notes in the author's own words ("keep the character
//     names in English"). Betty turns those into table rows and decisions,
//     and the brief carries them verbatim so nothing the author said is lost.
//
// Being wrong about prose is the worse mistake — a sentence read as a row
// becomes a binding "term" — so a cell that looks like a sentence (too many
// words, or a full stop at the end) disqualifies its line.

import type { SavedGlossaryEntry } from "./translationBrief.js";

export interface ParsedTermList {
  rows: SavedGlossaryEntry[];
  /** The lines that were not rows, in order. */
  rest: string;
}

const MAX_TERM_WORDS = 8;
const MAX_RENDERING_WORDS = 10;
const MAX_CELL_CHARS = 80;
/** A list is CSV when this share of its lines carries the delimiter. */
const CSV_SHARE = 0.8;

/** Column headings in the languages Betty works in. */
const HEADER_WORDS = new Set(
  (
    "term terms source target translation translations rendering original word words " +
    "english danish german spanish french en da de es fr " +
    "begreb begreber ord oversættelse kilde mål " +
    "begriff begriffe übersetzung quelle ziel " +
    "término términos traducción origen destino " +
    "terme termes traduction source cible"
  ).split(" "),
);

const KEEP_WORDS = /^(keep|behold|behalten|conservar|garder|x|yes|ja|sí|oui|true)$/i;
const ARROW = /\s*(?:→|->|=>|=)\s*/;

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** A sentence, not a term: ends in sentence punctuation, unless it is a short
 *  abbreviation like "Inc." or "Dr.". */
function sentencey(s: string): boolean {
  return /[.!?]$/.test(s) && s.length > 5;
}

function toRow(cells: string[]): SavedGlossaryEntry | null {
  const [rawTerm, rawRendering = "", flag = ""] = cells.map((c) => c.trim());
  const term = rawTerm;
  if (!term || term.length > MAX_CELL_CHARS || words(term) > MAX_TERM_WORDS || sentencey(term)) return null;
  const keepFlag = KEEP_WORDS.test(flag);
  const rendering = rawRendering || (keepFlag ? term : "");
  if (!rendering || rendering.length > MAX_CELL_CHARS || words(rendering) > MAX_RENDERING_WORDS) return null;
  if (sentencey(rendering)) return null;
  const keep = keepFlag || rendering === term;
  return { term, rendering: keep ? term : rendering, keep };
}

/** One CSV line, honouring double quotes. */
function splitCsv(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delim && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvDelimiter(lines: string[]): string | null {
  if (lines.length < 2) return null;
  for (const d of [";", ","]) {
    const hits = lines.filter((l) => {
      const n = splitCsv(l, d).length;
      return n === 2 || n === 3;
    }).length;
    if (hits / lines.length >= CSV_SHARE) return d;
  }
  return null;
}

function cellsOf(line: string, csv: string | null): string[] | null {
  const t = line.trim();
  if (t.startsWith("|")) {
    if (/^\|?[\s:|-]+$/.test(t)) return []; // a Markdown table's rule line
    return t.replace(/^\||\|$/g, "").split("|");
  }
  if (t.includes("\t")) return t.split("\t");
  if (csv) return splitCsv(t, csv);
  const parts = t.split(ARROW);
  return parts.length === 2 ? parts : null;
}

function isHeader(cells: string[]): boolean {
  const filled = cells.map((c) => c.trim().toLowerCase()).filter(Boolean);
  return filled.length >= 2 && filled.every((c) => HEADER_WORDS.has(c));
}

export function parseTermList(text: string): ParsedTermList {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const csv = csvDelimiter(lines);
  const rows: SavedGlossaryEntry[] = [];
  const seen = new Set<string>();
  const rest: string[] = [];
  // Column headings can only be the first line that has columns — a Word
  // file often opens with a paragraph above its table.
  let firstColumns = true;
  lines.forEach((line) => {
    const cells = cellsOf(line, csv);
    if (cells && cells.length === 0) return; // rule line
    if (cells && firstColumns) {
      firstColumns = false;
      if (isHeader(cells)) return;
    }
    const row = cells && cells.length <= 3 ? toRow(cells) : null;
    if (!row) {
      rest.push(line.trim());
      return;
    }
    if (seen.has(row.term)) return;
    seen.add(row.term);
    rows.push(row);
  });
  return { rows, rest: rest.join("\n") };
}
