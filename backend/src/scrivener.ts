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
//     and an edited file's line is updated to match.
//
// Measured on Scrivener 3.1.6 for Windows (version.txt 23). Mac Scrivener 3
// uses the same format; Scrivener 1 and 2 projects do not, and are refused.

import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { DOMParser } from "@xmldom/xmldom";

import type { ParagraphMapEntry } from "./conversion.js";
import type { DocxTextIndex } from "./docxSurgery.js";
import { remapChaptersToParagraphEdits } from "./docxRemap.js";
import { widenToWords } from "./docxTracked.js";
import { indexRtf, rewriteRtf, type RtfEdit } from "./rtfText.js";

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
  paragraphs: { uuid: string; index: number }[];
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

/** A paragraph as the manuscript shows it: line breaks become spaces, so
 *  every character still lines up with the RTF's own text. */
const asLine = (text: string) => text.replace(/[\n\t]/g, " ");

export interface ReadProject {
  md: string;
  link: ScrivenerLink;
}

/**
 * Read the Draft folder into a manuscript.
 *
 * A folder holding documents is a chapter, its title the heading and its
 * documents the scenes, separated by scene breaks. A document directly in
 * the Draft folder is a chapter of its own. Documents excluded from compile
 * are left out, as Scrivener's own compile leaves them out.
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

  const walk = async (nodes: BinderNode[], chapter: { title: string; started: boolean } | null) => {
    for (const node of nodes) {
      if (!node.included) continue;
      const isFolder = node.type === "Folder";
      if (node.type !== "Text" && !isFolder) continue;
      // A folder is a chapter; a folder can also hold text of its own, read
      // as the chapter's opening. A document outside any folder is a chapter.
      const heading = isFolder ? { title: node.title, started: false } : chapter;
      const doc = await readDocument(node);
      if (doc) {
        if (!heading) block(`# ${node.title || name}`);
        else if (!heading.started) {
          block(`# ${heading.title || name}`);
          heading.started = true;
        } else block("* * *");
        scenes.push({ uuid: node.uuid, title: node.title, sha1: sha1(doc.buf) });
        for (const p of doc.usable) {
          const start = block(asLine(p.text));
          map.push({ docxParaIndex: paragraphs.length, mdStart: start, mdEnd: length, mappable: true });
          paragraphs.push({ uuid: node.uuid, index: p.index });
        }
      }
      // A document can have children too (Scrivener allows it): they belong
      // to the same chapter.
      if (node.children.length) {
        await walk(node.children, heading ?? { title: node.title, started: doc !== null });
      }
    }
  };
  await walk(draft.children, null);

  if (map.length === 0) {
    throw new ScrivenerError("The Manuscript folder has no text in it yet.", "empty");
  }
  return {
    md: parts.join(""),
    link: { version: 1, projectDir: dir, scrivx, projectName: name, linkedAt: Date.now(), scenes, paragraphs, map },
  };
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
      text: asLine(indexed.get(p.uuid)?.[p.index]?.text ?? ""),
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

  // Back into each scene's own paragraphs.
  const perScene = new Map<string, RtfEdit[]>();
  for (const [pi, list] of byParagraph) {
    const where = link.paragraphs[pi];
    if (!where) continue;
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
  if (opts.dryRun || writes.length === 0) return report;

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
    newSums.set(`${w.uuid}/content.rtf`, sha1(bytes));
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
        return newSums.has(key) ? `${key}=${newSums.get(key)}` : line;
      })
      .join("");
    const tmp = `${sumsPath}.betty-tmp`;
    await fs.writeFile(tmp, updated, "utf8");
    await fs.rename(tmp, sumsPath);
  } catch {
    // A project without the file (older 3.x) has nothing to keep true.
  }

  link.writtenAt = Date.now();
  link.backupDir = backupDir;
  return report;
}
