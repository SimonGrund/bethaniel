// ── Tracked-changes DOCX export ──
//
// The surgical export (docxSurgery.ts) rewrites text inside the author's own
// <w:t> elements. This writes the same edits as Word revisions instead: each
// one becomes a <w:del> of the old words and a <w:ins> of the new ones,
// credited to Betty, so the author can accept or reject them in Word with
// Word's own tools. Optionally each carries a comment with Betty's reasoning.
//
// Same method, same guarantee. Nothing is parsed and re-serialized; the run
// holding an edit is closed at the edit, the revision runs are placed after
// it, and the run is reopened with its own <w:rPr> bytes, so the text either
// side keeps its formatting exactly and the inserted words take the
// formatting of the words they replace. An edit that would need to guess
// formatting is refused and reported exactly as the surgical export refuses
// it, and so is one inside a tracked change the document already carries:
// Word revisions do not nest.
//
// A comment is anchored around its edit's revision and lives in
// word/comments.xml, created along with its content type and relationship
// when the document has none.

import JSZip from "jszip";
import {
  excerpt,
  indexDocumentXml,
  trimBody,
  type DocxParagraph,
  type ParagraphTextEdit,
  type SkippedEdit,
  type TextNode,
} from "./docxSurgery.js";
import { stripMarkdown } from "./docxRemap.js";
import { visibleFormat } from "./emphasisSpans.js";
import { commentXml, maxId, writeComments } from "./docxComments.js";

export interface TrackedEdit extends ParagraphTextEdit {
  paragraphIndex: number;
  /** Betty's comment on this change. Edits sharing a `key` within one
   *  paragraph share one comment, spanning all of them. */
  note?: { key: string; text: string };
}

export interface TrackedOptions {
  author: string;
  initials: string;
  /** ISO 8601, as Word writes it. */
  date: string;
  /** Keep only the top-level blocks holding a paragraph in these ranges
   *  (docxRemap `scope`): an edit of some chapters exports those chapters. */
  keepParagraphs?: Array<[number, number]>;
}

export type TrackedSkip = SkippedEdit;

// ── Word widening ──

const WORD_CHAR = /[\p{L}\p{N}'’]/u;
const isWord = (c: string | undefined) => c !== undefined && WORD_CHAR.test(c);

/**
 * Widen character-level edits to whole words, and merge any that then meet.
 *
 * The surgical export shrinks an edit to the characters that differ, which is
 * right for rewriting text in place and wrong for a revision someone reads:
 * "sudenly" → "suddenly" as a tracked change would be one inserted "d". An
 * editor marks the word. A boundary is widened only where it falls INSIDE a
 * word — both the text outside and the edit's own edge are word characters —
 * so a comma added after a word stays an inserted comma.
 */
export function widenToWords(text: string, edits: ParagraphTextEdit[]): ParagraphTextEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  // Each edit's span once widened. Only the bounds are widened here; the
  // replacement is built afterwards from the untouched text, because two
  // widened edits in one word would otherwise each carry their own copy of it.
  const spans = sorted.map((e) => {
    if (e.wholeParagraph) return { start: e.start, end: e.end };
    let start = e.start;
    let end = e.end;
    const firstIn = e.start < e.end ? text[e.start] : e.replacement[0];
    if (isWord(text[start - 1]) && isWord(firstIn)) {
      while (start > 0 && isWord(text[start - 1])) start--;
    }
    const lastIn = e.start < e.end ? text[e.end - 1] : e.replacement[e.replacement.length - 1];
    if (isWord(text[end]) && isWord(lastIn)) {
      while (end < text.length && isWord(text[end])) end++;
    }
    return { start, end };
  });

  // Edits whose widened spans meet become one revision.
  const groups: { start: number; end: number; members: ParagraphTextEdit[] }[] = [];
  sorted.forEach((e, i) => {
    const last = groups[groups.length - 1];
    if (last && !e.wholeParagraph && !last.members[0].wholeParagraph && spans[i].start <= last.end) {
      last.end = Math.max(last.end, spans[i].end);
      last.members.push(e);
    } else {
      groups.push({ ...spans[i], members: [e] });
    }
  });

  return groups.map((g) => {
    if (g.members.length === 1 && g.members[0].wholeParagraph) return g.members[0];
    let replacement = "";
    let pos = g.start;
    for (const e of g.members) {
      replacement += text.slice(pos, e.start) + e.replacement;
      pos = Math.max(pos, e.end);
    }
    replacement += text.slice(pos, g.end);
    return { ...g.members[0], start: g.start, end: g.end, replacement };
  });
}

// ── Notes ──

/** A letter or digit at either end of `needle` must not run on into a word —
 *  the rule frontend/src/correctionApply.ts places suggestions by. */
function cleanEdges(text: string, at: number, needle: string): boolean {
  const alnum = /[\p{L}\p{N}]/u;
  const wordish = /[\p{L}\p{N}'’ʼ-]/u;
  if (alnum.test(needle[0]) && at > 0 && wordish.test(text[at - 1])) return false;
  const end = at + needle.length;
  if (alnum.test(needle[needle.length - 1]) && end < text.length && wordish.test(text[end])) {
    return false;
  }
  return true;
}

/** What Betty said about one suggestion, as the export receives it. */
export interface ChangeNote {
  /** The suggestion's own text, as in the chapter's markdown. */
  original: string;
  /** The comment to show. */
  text: string;
}

/**
 * Widen each paragraph's edits to words and give each the note of the
 * suggestion it came from.
 *
 * The edits are a diff, so they do not know which suggestion made them. The
 * suggestion's original words do: an edit inside a place where they occur, in
 * the same chapter, is that suggestion's. Where two overlap, the later note
 * wins, as the later suggestion won when the text was built. Each occurrence
 * is its own comment — the same fix made in three places is three places to
 * look at.
 */
export function planTrackedEdits(
  edits: Array<{ paragraphIndex: number; chapterIndex: number } & ParagraphTextEdit>,
  paragraphText: (paragraphIndex: number) => string | undefined,
  notesByChapter: ChangeNote[][] = [],
): TrackedEdit[] {
  const byParagraph = new Map<number, typeof edits>();
  for (const e of edits) {
    const list = byParagraph.get(e.paragraphIndex) ?? [];
    list.push(e);
    byParagraph.set(e.paragraphIndex, list);
  }

  const out: TrackedEdit[] = [];
  for (const [pi, list] of byParagraph) {
    const text = paragraphText(pi);
    if (text === undefined) {
      out.push(...list);
      continue;
    }
    const chapterIndex = list[0].chapterIndex;
    const notes = notesByChapter[chapterIndex] ?? [];
    // Every place each note's words occur in this paragraph.
    const places: { key: string; text: string; start: number; end: number }[] = [];
    notes.forEach((note, ni) => {
      const needle = stripMarkdown(note.original);
      if (!needle || !note.text) return;
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
        // Whole words only, as the export itself places a suggestion: "apear"
        // must not claim the "apear" inside "apeared", or its comment lands
        // on another suggestion's change.
        if (!cleanEdges(text, at, needle)) continue;
        places.push({ key: `${ni}:${at}`, text: note.text, start: at, end: at + needle.length });
      }
    });

    for (const e of widenToWords(text, list)) {
      let note: TrackedEdit["note"];
      for (const p of places) {
        const meets =
          e.start === e.end
            ? e.start >= p.start && e.start <= p.end
            : e.start < p.end && p.start < e.end;
        // Later notes overwrite earlier ones: the later suggestion won.
        if (meets) note = { key: p.key, text: p.text };
      }
      out.push({ ...e, paragraphIndex: pi, ...(note ? { note } : {}) });
    }
  }
  return out;
}

// ── XML ──

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One piece of a node's text being replaced, in node-local offsets. */
interface NodeOp {
  from: number;
  to: number;
  insert: string;
  /** Run-level markup placed before the revision (a comment range start). */
  before: string;
  /** Run-level markup placed after it (a comment range end and reference). */
  after: string;
}

interface Splice {
  xmlStart: number;
  xmlEnd: number;
  text: string;
  /** The <w:t> open tag ends here; it needs xml:space="preserve" now. */
  preserveAt: number;
  preserve: boolean;
}

/**
 * Plan one paragraph's revisions. Refusals mirror planParagraphSplices:
 * spans touching a tab or break, spans across differing formatting, and —
 * new here — spans inside a revision the document already has.
 */
function planParagraph(
  p: DocxParagraph,
  edits: TrackedEdit[],
  nextRevisionId: () => number,
  commentFor: (key: string, text: string) => number,
  opts: TrackedOptions,
): { splices: Splice[]; skipped: TrackedSkip[]; applied: number } {
  const skipped: TrackedSkip[] = [];
  const skip = (e: TrackedEdit, reason: TrackedSkip["reason"]) =>
    skipped.push({
      ...e,
      paragraphIndex: p.index,
      original: p.text.slice(e.start, e.end),
      context: excerpt(p.text, e.start, e.end),
      reason,
    });

  // Which nodes each edit touches, refusing what cannot be marked up safely.
  const planned: { e: TrackedEdit; nodes: TextNode[] }[] = [];
  for (const e of edits) {
    if (e.start < 0 || e.end > p.text.length || e.start > e.end) {
      skip(e, "out-of-range");
      continue;
    }
    if (e.start === e.end && e.replacement === "") continue;
    const nodes = p.nodes.filter((n) => {
      const nEnd = n.textStart + n.text.length;
      return e.start < nEnd && e.end > n.textStart
        ? true
        : e.start === e.end && e.start >= n.textStart && e.start <= nEnd;
    });
    // A zero-width insert at a node boundary touches both neighbours; it
    // belongs to the first, after its last character.
    if (e.start === e.end && nodes.length > 1) nodes.splice(1);
    if (nodes.length === 0) {
      skip(e, "out-of-range");
      continue;
    }
    if (nodes.some((n) => n.kind === "virtual")) {
      skip(e, "virtual-node");
      continue;
    }
    if (nodes.some((n) => n.inRevision)) {
      skip(e, "tracked-region");
      continue;
    }
    if (new Set(nodes.map((n) => visibleFormat(n.rPrXml))).size > 1) {
      skip(e, "mixed-formatting");
      continue;
    }
    planned.push({ e, nodes });
  }

  // Comment ranges: open before the first edit carrying a key, close after
  // the last. Assigned only to edits that will actually be written.
  const firstOf = new Map<string, TrackedEdit>();
  const lastOf = new Map<string, TrackedEdit>();
  for (const { e } of planned) {
    if (!e.note) continue;
    if (!firstOf.has(e.note.key)) firstOf.set(e.note.key, e);
    lastOf.set(e.note.key, e);
  }

  const ops = new Map<TextNode, NodeOp[]>();
  for (const { e, nodes } of planned) {
    let before = "";
    let after = "";
    if (e.note && firstOf.get(e.note.key) === e) {
      const id = commentFor(`${p.index}\u0000${e.note.key}`, e.note.text);
      before = `<w:commentRangeStart w:id="${id}"/>`;
    }
    if (e.note && lastOf.get(e.note.key) === e) {
      const id = commentFor(`${p.index}\u0000${e.note.key}`, e.note.text);
      after =
        `<w:commentRangeEnd w:id="${id}"/>` +
        `<w:r><w:commentReference w:id="${id}"/></w:r>`;
    }
    nodes.forEach((n, i) => {
      const nEnd = n.textStart + n.text.length;
      const list = ops.get(n) ?? [];
      list.push({
        from: Math.max(e.start, n.textStart) - n.textStart,
        to: Math.min(e.end, nEnd) - n.textStart,
        // The new words go once, where the old ones began.
        insert: i === 0 ? e.replacement : "",
        before: i === 0 ? before : "",
        after: i === nodes.length - 1 ? after : "",
      });
      ops.set(n, list);
    });
  }

  const attrs = () =>
    `w:id="${nextRevisionId()}" w:author="${esc(opts.author)}" w:date="${opts.date}"`;
  const splices: Splice[] = [];
  for (const [n, list] of ops) {
    const rPr = n.rPrXml;
    let out = "";
    let pos = 0;
    for (const op of [...list].sort((a, b) => a.from - b.from || a.to - b.to)) {
      out += esc(n.text.slice(pos, op.from));
      // Close the author's run at the edit, place the revision, reopen it.
      out += "</w:t></w:r>" + op.before;
      const removed = n.text.slice(op.from, op.to);
      if (removed) {
        out +=
          `<w:del ${attrs()}><w:r>${rPr}` +
          `<w:delText xml:space="preserve">${esc(removed)}</w:delText></w:r></w:del>`;
      }
      if (op.insert) {
        out +=
          `<w:ins ${attrs()}><w:r>${rPr}` +
          `<w:t xml:space="preserve">${esc(op.insert)}</w:t></w:r></w:ins>`;
      }
      out += op.after + `<w:r>${rPr}<w:t xml:space="preserve">`;
      pos = Math.max(pos, op.to);
    }
    out += esc(n.text.slice(pos));
    splices.push({
      xmlStart: n.xmlStart,
      xmlEnd: n.xmlEnd,
      text: out,
      preserveAt: n.openTagEnd,
      preserve: n.preserve,
    });
  }

  return { splices, skipped, applied: planned.length };
}

function applySplices(xml: string, splices: Splice[]): string {
  let out = xml;
  for (const s of [...splices].sort((a, b) => b.xmlStart - a.xmlStart)) {
    out = out.slice(0, s.xmlStart) + s.text + out.slice(s.xmlEnd);
    // The text left in the author's own <w:t> may now end in a space.
    if (!s.preserve) {
      const gt = s.preserveAt - 1;
      if (out[gt] === ">" && out[gt - 1] !== "/") {
        out = out.slice(0, gt) + ' xml:space="preserve"' + out.slice(gt);
      }
    }
  }
  return out;
}


/**
 * Write `edits` into a .docx as tracked changes, with a comment on each edit
 * that carries a note.
 */
export async function rewriteDocxTracked(
  docxBuffer: Buffer,
  edits: TrackedEdit[],
  opts: TrackedOptions,
): Promise<{
  buffer: Buffer;
  applied: number;
  skipped: TrackedSkip[];
  comments: number;
}> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("Not a Word document: word/document.xml is missing");
  const xml = await file.async("string");
  const index = indexDocumentXml(xml);

  // One counter for revisions and comments alike, starting past every id the
  // document and its comments already use, so no annotation shares an id.
  const existingComments = (await zip.file("word/comments.xml")?.async("string")) ?? "";
  let nextId = Math.max(maxId(existingComments, "w:id"), maxId(xml, "w:id")) + 1;
  const nextRevisionId = () => nextId++;
  const commentIds = new Map<string, number>();
  const comments: string[] = [];
  const commentFor = (key: string, text: string) => {
    let id = commentIds.get(key);
    if (id === undefined) {
      id = nextRevisionId();
      commentIds.set(key, id);
      comments.push(commentXml(id, text, opts));
    }
    return id;
  };

  const byParagraph = new Map<number, TrackedEdit[]>();
  const skipped: TrackedSkip[] = [];
  for (const e of edits) {
    if (!index.paragraphs[e.paragraphIndex]) {
      skipped.push({ ...e, original: "", context: "", reason: "unmappable-paragraph" });
      continue;
    }
    const list = byParagraph.get(e.paragraphIndex) ?? [];
    list.push(e);
    byParagraph.set(e.paragraphIndex, list);
  }

  const splices: Splice[] = [];
  let applied = 0;
  for (const [pi, list] of byParagraph) {
    const res = planParagraph(index.paragraphs[pi], list, nextRevisionId, commentFor, opts);
    splices.push(...res.splices);
    skipped.push(...res.skipped);
    applied += res.applied;
  }

  let out = applySplices(xml, splices);
  const ranges = opts.keepParagraphs;
  if (ranges && ranges.length > 0) out = trimBody(out, (i) => ranges.some(([a, b]) => i >= a && i <= b));
  zip.file("word/document.xml", out);
  await writeComments(zip, out, comments);
  const buffer = Buffer.from(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return { buffer, applied, skipped, comments: comments.length };
}
