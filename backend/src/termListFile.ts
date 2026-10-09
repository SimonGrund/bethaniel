// ── A term list uploaded as a file ──
//
// The term-list card accepts a file as well as pasted text. Every format is
// turned into the same thing — one tab-separated line per row, plus whatever
// prose the file holds — and handed back to the paste field, so the author
// sees what was read and parseTermList (termList.ts) does the rest exactly as
// for anything typed.
//
// TBX is the exchange format Trados, memoQ and Phrase export; it holds many
// languages per entry, so the source and target are picked out by language.
// Excel is read straight from the workbook's XML with JSZip, which the
// backend already carries, rather than through another parser dependency.

import JSZip from "jszip";
import mammoth from "mammoth";
import { baseLang } from "./translationBrief.js";

export interface TermListLanguages {
  /** The manuscript language code ("en"). */
  sourceLang?: string;
  /** The target language as the wizard names it ("German"). */
  targetLang?: string;
}

/** The wizard's language names, as codes, for TBX's xml:lang. */
const TARGET_CODES: Record<string, string> = {
  english: "en",
  danish: "da",
  german: "de",
  spanish: "es",
  french: "fr",
  dutch: "nl",
  italian: "it",
  norwegian: "no",
  swedish: "sv",
  portuguese: "pt",
  polish: "pl",
  finnish: "fi",
};

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
}

function fromTbx(xml: string, langs: TermListLanguages): string {
  const src = langs.sourceLang ? baseLang(langs.sourceLang) : null;
  const tgt = langs.targetLang ? (TARGET_CODES[langs.targetLang.toLowerCase()] ?? null) : null;
  const lines: string[] = [];
  for (const entry of xml.match(/<termEntry[\s\S]*?<\/termEntry>/g) ?? []) {
    const secs = [...entry.matchAll(/<langSec[^>]*xml:lang="([^"]+)"[^>]*>([\s\S]*?)<\/langSec>/g)].map((m) => ({
      lang: baseLang(m[1]),
      term: decodeXml(m[2].match(/<term[^>]*>([\s\S]*?)<\/term>/)?.[1] ?? ""),
    }));
    const pick = (code: string | null, fallback: number) =>
      (code ? secs.find((s) => s.lang === code) : undefined) ?? secs[fallback];
    const a = pick(src, 0);
    const b = pick(tgt, 1);
    if (a?.term && b?.term && a !== b) lines.push(`${a.term}\t${b.term}`);
  }
  return lines.join("\n");
}

/** "B3" → 1 (zero-based column). */
function columnOf(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function fromXlsx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const shared: string[] = [];
  const sst = await zip.file("xl/sharedStrings.xml")?.async("string");
  for (const si of sst?.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    shared.push([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join(""));
  }
  const sheetName = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
  const sheet = sheetName ? await zip.file(sheetName)!.async("string") : "";
  const lines: string[] = [];
  for (const row of sheet.match(/<row[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    for (const c of row.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] ?? "";
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/t="([^"]+)"/)?.[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const value =
        type === "s"
          ? (shared[Number(v)] ?? "")
          : type === "inlineStr"
            ? decodeXml(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? "")
            : decodeXml(v ?? "");
      cells[ref ? columnOf(ref) : cells.length] = value;
    }
    const line = Array.from(cells, (c) => c ?? "").join("\t");
    if (line.trim()) lines.push(line);
  }
  return lines.join("\n");
}

async function fromDocx(buffer: Buffer): Promise<string> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return decodeXml(
    html
      // A table row is one line, its cells tab-separated.
      .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/g, (_, row: string) =>
        [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
          .map((m) => decodeXml(m[1]).replace(/\s+/g, " "))
          .join("\t") + "\n",
      )
      .replace(/<\/(p|h\d|li)>/g, "\n"),
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

export async function extractTermListText(
  fileName: string,
  buffer: Buffer,
  langs: TermListLanguages,
): Promise<string> {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  switch (ext) {
    case "csv":
    case "tsv":
    case "txt":
    case "md":
      return buffer.toString("utf8").replace(/^﻿/, "");
    case "tbx":
    case "xml":
      return fromTbx(buffer.toString("utf8"), langs);
    case "xlsx":
      return fromXlsx(buffer);
    case "docx":
      return fromDocx(buffer);
    default:
      throw new Error(`Betty cannot read .${ext || "?"} files as a term list — use CSV, Excel, Word, TBX or plain text`);
  }
}
