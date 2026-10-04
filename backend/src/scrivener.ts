// ── Scrivener: link a project, and write Betty's changes back into it ──
//
// A Scrivener 3 project (.scriv) is a folder: a .scrivx XML file holding the
// binder — the outline, its order and titles — and one Files/Data/<UUID>/
// content.rtf per document. Linking reads the Draft folder ("Manuscript") in
// binder order into the manuscript Betty reviews, and records exactly what
// was read: each scene's checksum and where each paragraph came from. Nothing
// is written while linked.
//
// Writing back is its own, guarded step, because it is the one place
// Bethaniel changes a file the author's other app owns:
//
//   - never while the project is open — Scrivener writes Files/user.lock for
//     exactly as long as it has the project open, and two programs writing
//     one project is how projects are corrupted;
//   - never over a scene changed in Scrivener since Betty read it — the
//     author's newer words win, and they re-link to review them;
//   - never without a full copy of the project first, as a project of its
//     own that Scrivener opens like any other;
//   - only the text inside each RTF stretch changes (rtfText.ts), never a
//     formatting code, and anything that cannot be done that way is refused
//     and listed;
//   - Files/Data/docs.checksum is kept true: it holds a SHA-1 of every file,
//     and an edited file's line is updated to match;
//   - a corrected chapter title is written into that binder item's <Title>
//     in the .scrivx — only where it still reads as Betty read it — and into
//     Files/binder.autosave, Scrivener's second copy of the binder, so the
//     two cannot disagree.
//
// What Betty reads is the text as the author sees it: italic and bold shown
// as Markdown emphasis, a line break between words as a line break. Neither
// is ever written — an edit replaces text inside one stretch of the RTF.
//
// Measured on Scrivener 3.1.6 for Windows (version.txt 23). Mac Scrivener 3
// uses the same format; Scrivener 1 and 2 projects do not, and are refused.

import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";

import type { ParagraphMapEntry } from "./conversion.js";
import type { DocxTextIndex } from "./docxSurgery.js";
import { remapChaptersToParagraphEdits, stripMarkdown } from "./docxRemap.js";
import { widenToWords } from "./docxTracked.js";
import { indexRtf, rewriteRtf, type RtfEdit, type RtfParagraph } from "./rtfText.js";

export class ScrivenerError extends Error {
  constructor(
    message: string,
    public reason:
      | "not-found"
      | "not-a-project"
      | "unsupported-version"
      | "no-manuscript"
      | "empty"
      | "project-open"
      | "changed-since-link"
      | "already-written"
      | "not-linked",
    public detail?: string[],
  ) {
    super(message);
  }
}

export interface ScrivenerScene {
  uuid: string;
  title: string;
  /** SHA-1 of content.rtf when linked; what docs.checksum also records. */
  sha1: string;
}

export interface ScrivenerLink {
  version: 1;
  /** The .scriv folder. */
  projectDir: string;
  /** The .scrivx file's name inside it. */
  scrivx: string;
  projectName: string;
  linkedAt: number;
  scenes: ScrivenerScene[];
  /** Where each manuscript paragraph came from, in manuscript order. */
  /** `title` marks a chapter heading: the binder item's title, kept in the
   *  .scrivx, not in any RTF. `index` is then -1. */
  paragraphs: { uuid: string; index: number; title?: string }[];
  /** Manuscript offsets of each of those paragraphs. */
  map: ParagraphMapEntry[];
  /** Set once written back: the review it came from is spent. */
  writtenAt?: number;
  backupDir?: string;
}

// ── Finding the project ──

/** The .scriv folder and its .scrivx, from either the folder or the file. */
export async function resolveProject(input: string): Promise<{ dir: string; scrivx: string; name: string }> {
  let target = input.trim().replace(/^"(.*)"$/, "$1");
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new ScrivenerError(`Nothing found at ${target}.`, "not-found");
  }
  if (stat.isFile()) {
    if (!/\.scrivx$/i.test(target)) {
      throw new ScrivenerError("Choose the Scrivener project (.scriv), or the .scrivx file inside it.", "not-a-project");
    }
    target = path.dirname(target);
  }
  const files = await fs.readdir(target);
  const scrivx = files.find((f) => /\.scrivx$/i.test(f));
  if (!scrivx) {
    throw new ScrivenerError("This folder is not a Scrivener project: it has no .scrivx file.", "not-a-project");
  }
  try {
    const version = (await fs.readFile(path.join(target, "Files", "version.txt"), "utf8")).trim();
    if (Number(version) < 23) throw new Error("old");
  } catch {
    throw new ScrivenerError(
      "This project is from an older Scrivener. Open it once in Scrivener 3, which updates it, then link it again.",
      "unsupported-version",
    );
  }
  return { dir: target, scrivx, name: scrivx.replace(/\.scrivx$/i, "") };
}

const contentPath = (dir: string, uuid: string) => path.join(dir, "Files", "Data", uuid, "content.rtf");
const sha1 = (buf: Buffer) => createHash("sha1").update(buf).digest("hex");

/** Scrivener writes Files/user.lock for as long as the project is open. */
export async function isProjectOpen(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "Files", "user.lock"));
    return true;
  } catch {
    return false;
  }
}

// ── Reading the manuscript ──

interface BinderNode {
  uuid: string;
  type: string;
  title: string;
  included: boolean;
  children: BinderNode[];
}

function childElements(el: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).nodeName === name) out.push(n as Element);
  }
  return out;
}

function toNode(el: Element): BinderNode {
  const title = childElements(el, "Title")[0]?.textContent ?? "";
  const meta = childElements(el, "MetaData")[0];
  const include = meta ? childElements(meta, "IncludeInCompile")[0]?.textContent : undefined;
  const kids = childElements(el, "Children")[0];
  return {
    uuid: el.getAttribute("UUID") ?? "",
    type: el.getAttribute("Type") ?? "",
    title: title.trim(),
    included: include !== "No",
    children: kids ? childElements(kids, "BinderItem").map(toNode) : [],
  };
}

/**
 * A paragraph's plain text as the manuscript carries it — the same length as
 * the RTF's own text, so every offset still lines up with it.
 *
 * A line break between words (Shift+Enter in Scrivener) stays a line break,
 * so Betty reads a letter or a verse as lines. What would end the paragraph
 * for the manuscript is a space instead: a break at either edge, and the
 * second of two breaks with only spaces between them, which would read as a
 * blank line and split one Scrivener paragraph into two. Tabs are spaces.
 */
export function manuscriptPlain(text: string): string {
  const chars = text.replace(/\t/g, " ").split("");
  let lastKept = -1; // index of the last "\n" kept, or of the last non-space
  let sawText = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\n") {
      // At the start, or with only spaces since the last kept break.
      if (!sawText || chars[lastKept] === "\n") chars[i] = " ";
      else lastKept = i;
    } else if (c !== " ") {
      sawText = true;
      lastKept = i;
    }
  }
  // At the end.
  for (let i = chars.length - 1; i >= 0 && (chars[i] === "\n" || chars[i] === " "); i--) {
    if (chars[i] === "\n") chars[i] = " ";
  }
  return chars.join("");
}

/** The Markdown markers for a stretch's emphasis. */
const markerFor = (italic: boolean, bold: boolean) =>
  italic && bold ? "***" : bold ? "**" : italic ? "*" : "";

/**
 * A paragraph as Markdown: its plain text with italic and bold shown as
 * `*…*` and `**…**`, as a .docx import shows them — so Betty sees what the
 * author emphasised. Markers sit inside surrounding spaces, and stretches of
 * the same emphasis split by an unrelated code (a font switch) are one span.
 *
 * Checked, not trusted: the write-back compares paragraphs with the markers
 * stripped, so a paragraph whose markers would not strip back to its exact
 * text (one with asterisks or underscores of its own) is shown plain.
 */
export function manuscriptMarkdown(p: RtfParagraph, plain: string): string {
  const runs: { start: number; end: number; marker: string }[] = [];
  for (const n of [...p.nodes].sort((a, b) => a.textStart - b.textStart)) {
    const marker = markerFor(n.italic, n.bold);
    const start = n.textStart;
    const end = n.textStart + n.text.length;
    const last = runs[runs.length - 1];
    if (last && last.end === start && last.marker === marker) last.end = end;
    else runs.push({ start, end, marker });
  }
  let md = "";
  let pos = 0;
  for (const r of runs) {
    md += plain.slice(pos, r.start);
    const seg = plain.slice(r.start, r.end);
    const core = seg.trim();
    if (!r.marker || !core) md += seg;
    else {
      const lead = seg.slice(0, seg.length - seg.trimStart().length);
      const trail = seg.slice(seg.trimEnd().length);
      md += lead + r.marker + core + r.marker + trail;
    }
    pos = r.end;
  }
  md += plain.slice(pos);
  return stripMarkdown(md) === plain ? md : plain;
}

export interface ReadProject {
  md: string;
  link: ScrivenerLink;
}

/**
 * Read the Draft folder into a manuscript.
 *
 * Each document with text is one unit under its own title, in binder order;
 * folders only order them. Documents excluded from compile are left out, as
 * Scrivener's own compile leaves them out.
 */
export async function readProject(input: string): Promise<ReadProject> {
  const { dir, scrivx, name } = await resolveProject(input);
  const xml = await fs.readFile(path.join(dir, scrivx), "utf8");
  const docEl = new DOMParser().parseFromString(xml, "text/xml").documentElement;
  const binder = docEl ? childElements(docEl, "Binder")[0] : undefined;
  const draft = binder
    ? childElements(binder, "BinderItem").map(toNode).find((n) => n.type === "DraftFolder")
    : undefined;
  if (!draft) {
    throw new ScrivenerError("This project has no Manuscript (Draft) folder to read.", "no-manuscript");
  }

  const parts: string[] = [];
  let length = 0;
  const push = (s: string) => {
    parts.push(s);
    length += s.length;
  };
  const scenes: ScrivenerScene[] = [];
  const paragraphs: ScrivenerLink["paragraphs"] = [];
  const map: ParagraphMapEntry[] = [];

  /** A blank line before every block but the first. */
  const block = (text: string): number => {
    if (length > 0) push("\n\n");
    const start = length;
    push(text);
    return start;
  };

  /** A document's text, or null when it has none (no content.rtf, or empty). */
  const readDocument = async (node: BinderNode) => {
    let buf: Buffer;
    try {
      buf = await fs.readFile(contentPath(dir, node.uuid));
    } catch {
      return null;
    }
    const usable = indexRtf(buf.toString("latin1")).filter((p) => p.text.trim() !== "");
    return usable.length ? { buf, usable } : null;
  };

  /** A chapter heading: the binder item's own title, mapped back to it so a
   *  corrected title can be written into the .scrivx. A heading made up for
   *  an untitled item is not the author's, and is not mapped. */
  const heading = (title: string, uuid: string) => {
    const start = block(`# ${title || name}`);
    if (!title) return;
    map.push({ docxParaIndex: paragraphs.length, mdStart: start, mdEnd: length, mappable: true });
    paragraphs.push({ uuid, index: -1, title });
  };

  // Every document with text is a unit of its own, under its own title.
  // Folders only order them. Projects disagree on what a folder means — a
  // chapter holding scene documents, or a part holding one document per
  // chapter — and guessing wrong turned 34 chapters into 7. The document is
  // the one thing every project has, and what write-back is done per.
  const walk = async (nodes: BinderNode[], folderTitle: string) => {
    for (const node of nodes) {
      if (!node.included) continue;
      const isFolder = node.type === "Folder";
      if (node.type !== "Text" && !isFolder) continue;
      // A folder can hold text of its own: a document like any other.
      const doc = await readDocument(node);
      if (doc) {
        if (node.title) heading(node.title, node.uuid);
        // Untitled: named after its folder for the reader, and not mapped —
        // that title is not this document's to change.
        else block(`# ${folderTitle || name}`);
        scenes.push({ uuid: node.uuid, title: node.title, sha1: sha1(doc.buf) });
        for (const p of doc.usable) {
          const plain = manuscriptPlain(p.text);
          const start = block(manuscriptMarkdown(p, plain));
          map.push({ docxParaIndex: paragraphs.length, mdStart: start, mdEnd: length, mappable: true });
          paragraphs.push({ uuid: node.uuid, index: p.index });
        }
      }
      // Folders, and documents with children (Scrivener allows both), in
      // binder order.
      if (node.children.length) await walk(node.children, node.title || folderTitle);
    }
  };
  await walk(draft.children, "");

  if (map.length === 0) {
    throw new ScrivenerError("The Manuscript folder has no text in it yet.", "empty");
  }
  return {
    md: parts.join(""),
    link: { version: 1, projectDir: dir, scrivx, projectName: name, linkedAt: Date.now(), scenes, paragraphs, map },
  };
}

// ── Binder titles ──

const decodeXml = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const encodeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The .scrivx with one binder item's title replaced, or null when that item
 * cannot be found or its title no longer reads `from`. Only the text between
 * that item's own <Title> tags changes; every other byte of the binder stays.
 */
export function replaceBinderTitle(xml: string, uuid: string, from: string, to: string): string | null {
  const open = new RegExp(`<BinderItem\\b[^>]*\\bUUID="${uuid.replace(/[^0-9A-Fa-f-]/g, "")}"[^>]*>`).exec(xml);
  if (!open) return null;
  const after = open.index + open[0].length;
  const title = /<Title>([\s\S]*?)<\/Title>/.exec(xml.slice(after));
  if (!title) return null;
  // The item's own title is its first child: one found past a nested item
  // belongs to a child.
  const nested = xml.indexOf("<BinderItem", after);
  if (nested !== -1 && after + title.index > nested) return null;
  if (decodeXml(title[1]).trim() !== from) return null;
  const start = after + title.index + "<Title>".length;
  return xml.slice(0, start) + encodeXml(to) + xml.slice(start + title[1].length);
}

/**
 * Scrivener keeps a second copy of the binder: Files/binder.autosave, a zip
 * holding the .scrivx as it was last autosaved. Scrivener opens from the
 * .scrivx — confirmed on 3.1.6 for Windows with a project whose two copies
 * disagreed: it showed the .scrivx's title. The autosave is presumably its
 * recovery copy, so a title changed in the .scrivx is changed there too —
 * the same one-title replacement, and only where the autosave still holds
 * the old title — and a recovery can never bring the old title back.
 * Anything unexpected in the autosave (not a zip, no binder in it) leaves
 * it as it was: the .scrivx is the project.
 */
async function syncAutosaveTitles(
  link: ScrivenerLink,
  changes: { uuid: string; from: string; to: string }[],
): Promise<void> {
  const autosave = path.join(link.projectDir, "Files", "binder.autosave");
  try {
    const zip = await JSZip.loadAsync(await fs.readFile(autosave));
    const name = Object.keys(zip.files).find((n) => /\.scrivx$/i.test(n));
    if (!name) return;
    let xml = await zip.file(name)!.async("string");
    let changed = false;
    for (const c of changes) {
      const next = replaceBinderTitle(xml, c.uuid, c.from, c.to);
      if (next !== null) {
        xml = next;
        changed = true;
      }
    }
    if (!changed) return;
    zip.file(name, xml);
    const tmp = `${autosave}.betty-tmp`;
    await fs.writeFile(tmp, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    await fs.rename(tmp, autosave);
  } catch {
    // No autosave, or not one this understands: left alone.
  }
}

// ── The link record ──
//
// Kept beside the document's other files (MEDIA_DIR/<docId>/), so deleting
// the document in Bethaniel deletes the link with it — and never touches the
// Scrivener project.

const LINK_FILE = "scrivener-link.json";

export async function saveLink(mediaDir: string, docId: string, link: ScrivenerLink): Promise<void> {
  const dir = path.join(mediaDir, docId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, LINK_FILE), JSON.stringify(link), "utf8");
}

export async function loadLink(mediaDir: string, docId: string): Promise<ScrivenerLink | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(mediaDir, docId, LINK_FILE), "utf8")) as ScrivenerLink;
  } catch {
    return null;
  }
}

// ── Writing back ──

export interface WriteBackReport {
  /** Changes written. */
  applied: number;
  /** Changes left out, with where they were, so the author can make them. */
  skipped: { scene: string; original: string; replacement: string; reason: string }[];
  /** Paragraphs whose changes could not be matched to the project. */
  unmapped: number;
  /** Why, for each: "chapter-not-found", "paragraph-mismatch", … and where. */
  unmappedDetail: { reason: string; detail: string }[];
  /** Scenes whose file changed. */
  scenesChanged: string[];
  /** The full copy taken before writing; absent on a dry run. */
  backupDir?: string;
}

/** The scenes that differ on disk from when Betty read them. */
export async function changedScenes(link: ScrivenerLink): Promise<string[]> {
  const changed: string[] = [];
  for (const s of link.scenes) {
    try {
      if (sha1(await fs.readFile(contentPath(link.projectDir, s.uuid))) !== s.sha1) changed.push(s.title || s.uuid);
    } catch {
      changed.push(s.title || s.uuid);
    }
  }
  return changed;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/**
 * Write the reviewed chapters back into the linked project.
 *
 * `dryRun` does every check and plans every change, and writes nothing — the
 * confirmation screen shows its report before the author agrees.
 */
export async function writeBack(
  link: ScrivenerLink,
  docMd: string,
  chapters: { original: string; edited: string }[],
  opts: { dryRun?: boolean } = {},
): Promise<WriteBackReport> {
  if (link.writtenAt) {
    throw new ScrivenerError(
      "Betty's changes from this review are already in the project. Link it again to review it again.",
      "already-written",
    );
  }
  try {
    await fs.access(path.join(link.projectDir, link.scrivx));
  } catch {
    throw new ScrivenerError(`The project is no longer at ${link.projectDir}.`, "not-found");
  }
  if (await isProjectOpen(link.projectDir)) {
    throw new ScrivenerError(
      "The project is open in Scrivener. Close it there first — two programs writing one project at once can damage it.",
      "project-open",
    );
  }
  const changed = await changedScenes(link);
  if (changed.length > 0) {
    throw new ScrivenerError(
      "These scenes were changed in Scrivener after Betty read them. Your newer text wins: link the project again to review it.",
      "changed-since-link",
      changed,
    );
  }

  // The project's paragraphs as Betty read them, shaped for the remap the
  // .docx export uses: same diffing, same verification, same refusals.
  const sources = new Map<string, string>();
  for (const s of link.scenes) {
    sources.set(s.uuid, (await fs.readFile(contentPath(link.projectDir, s.uuid))).toString("latin1"));
  }
  const indexed = new Map([...sources].map(([uuid, src]) => [uuid, indexRtf(src)]));
  const index: DocxTextIndex = {
    xml: "",
    paragraphs: link.paragraphs.map((p, i) => ({
      index: i,
      depth: 0,
      inTable: false,
      isEmpty: false,
      isPageBreak: false,
      hasObject: false,
      sawTextElement: true,
      // A heading's text is its binder title; a paragraph's is the RTF's own,
      // laid out exactly as the manuscript showed it.
      text:
        p.title !== undefined ? p.title : manuscriptPlain(indexed.get(p.uuid)?.[p.index]?.text ?? ""),
      nodes: [],
    })),
  };
  const { edits, unmapped } = remapChaptersToParagraphEdits(docMd, link.map, index, chapters);

  // Whole words, as the tracked export marks them: the diff makes "Welcoem"
  // → "Welcome" two one-letter edits, and a report counting two changes for
  // one fixed word is a report nobody can check against the review.
  const byParagraph = new Map<number, typeof edits>();
  for (const e of edits) {
    const list = byParagraph.get(e.paragraphIndex) ?? [];
    list.push(e);
    byParagraph.set(e.paragraphIndex, list);
  }

  // Back into each scene's own paragraphs — or, for a heading, into its
  // binder item's title.
  const perScene = new Map<string, RtfEdit[]>();
  const titleChanges: { uuid: string; from: string; to: string }[] = [];
  for (const [pi, list] of byParagraph) {
    const where = link.paragraphs[pi];
    if (!where) continue;
    if (where.title !== undefined) {
      let title = where.title;
      for (const e of [...list].sort((a, b) => b.start - a.start)) {
        title = title.slice(0, e.start) + e.replacement + title.slice(e.end);
      }
      if (title !== where.title) titleChanges.push({ uuid: where.uuid, from: where.title, to: title });
      continue;
    }
    for (const e of widenToWords(index.paragraphs[pi].text, list)) {
      const scene = perScene.get(where.uuid) ?? [];
      scene.push({ paragraphIndex: where.index, start: e.start, end: e.end, replacement: e.replacement });
      perScene.set(where.uuid, scene);
    }
  }

  const titleOf = (uuid: string) => link.scenes.find((s) => s.uuid === uuid)?.title || uuid;
  const report: WriteBackReport = {
    applied: 0,
    skipped: [],
    unmapped: unmapped.length,
    unmappedDetail: unmapped.slice(0, 20).map((u) => ({ reason: u.reason, detail: u.detail })),
    scenesChanged: [],
  };
  const writes: { uuid: string; rtf: string }[] = [];
  for (const [uuid, list] of perScene) {
    const res = rewriteRtf(sources.get(uuid)!, list);
    report.applied += res.applied;
    for (const s of res.skipped) {
      report.skipped.push({ scene: titleOf(uuid), original: s.original, replacement: s.replacement, reason: s.reason });
    }
    if (res.applied > 0) {
      writes.push({ uuid, rtf: res.rtf });
      report.scenesChanged.push(titleOf(uuid));
    }
  }
  // Titles live in the .scrivx, the binder itself. Each is replaced only
  // where it still reads as Betty read it; one renamed in Scrivener since is
  // the author's newer word, and is listed rather than overwritten.
  const scrivxPath = path.join(link.projectDir, link.scrivx);
  let scrivx = titleChanges.length ? await fs.readFile(scrivxPath, "utf8") : "";
  let titlesWritten = 0;
  for (const c of titleChanges) {
    const next = /[\r\n]/.test(c.to) || !c.to.trim() ? null : replaceBinderTitle(scrivx, c.uuid, c.from, c.to);
    if (next === null) {
      report.skipped.push({ scene: c.from, original: c.from, replacement: c.to, reason: "title-changed" });
      continue;
    }
    scrivx = next;
    titlesWritten++;
    report.applied++;
    report.scenesChanged.push(c.to);
  }

  if (opts.dryRun || (writes.length === 0 && titlesWritten === 0)) return report;

  // A full copy first, as a project of its own: same name, in a dated folder
  // beside the project, so it opens in Scrivener like the original.
  const backupRoot = path.join(path.dirname(link.projectDir), `${link.projectName} - Betty backups`);
  const backupDir = path.join(backupRoot, stamp(), path.basename(link.projectDir));
  await fs.mkdir(path.dirname(backupDir), { recursive: true });
  await fs.cp(link.projectDir, backupDir, { recursive: true, errorOnExist: true, force: false });
  // Checked, not assumed: every scene about to change must be in the copy,
  // byte for byte, before the original is touched.
  for (const w of writes) {
    const copy = await fs.readFile(contentPath(backupDir, w.uuid));
    if (sha1(copy) !== link.scenes.find((s) => s.uuid === w.uuid)?.sha1) {
      throw new Error(`The backup copy of "${titleOf(w.uuid)}" does not match; nothing was written.`);
    }
  }
  report.backupDir = backupDir;

  // Each file replaced whole, by rename: a crash leaves the old file or the
  // new one, never half of each.
  const newSums = new Map<string, string>();
  for (const w of writes) {
    const target = contentPath(link.projectDir, w.uuid);
    const tmp = `${target}.betty-tmp`;
    const bytes = Buffer.from(w.rtf, "latin1");
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
    // Keyed in lowercase: Scrivener for Mac writes this file's ids in
    // lowercase while the folders are uppercase (Windows writes both upper).
    newSums.set(`${w.uuid}/content.rtf`.toLowerCase(), sha1(bytes));
  }

  // docs.checksum lists "UUID/content.rtf=<sha1>" for every file; keep the
  // lines for the files just changed true.
  const sumsPath = path.join(link.projectDir, "Files", "Data", "docs.checksum");
  try {
    const sums = await fs.readFile(sumsPath, "utf8");
    const updated = sums
      .split(/(\r?\n)/)
      .map((line) => {
        const eq = line.indexOf("=");
        const key = eq > 0 ? line.slice(0, eq) : "";
        // Matched without case, written back in the line's own case.
        const sum = newSums.get(key.toLowerCase());
        return sum ? `${key}=${sum}` : line;
      })
      .join("");
    const tmp = `${sumsPath}.betty-tmp`;
    await fs.writeFile(tmp, updated, "utf8");
    await fs.rename(tmp, sumsPath);
  } catch {
    // A project without the file (older 3.x) has nothing to keep true.
  }

  // The binder, last: replaced whole by rename, like every other file.
  if (titlesWritten > 0) {
    const tmp = `${scrivxPath}.betty-tmp`;
    await fs.writeFile(tmp, scrivx, "utf8");
    await fs.rename(tmp, scrivxPath);
    await syncAutosaveTitles(link, titleChanges);
  }

  link.writtenAt = Date.now();
  link.backupDir = backupDir;
  return report;
}
