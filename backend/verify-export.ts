// Does the export now work on a document whose stored map predates the fix?
// Uses the user's real manuscript and the stored results of their latest run.
import Database from "better-sqlite3";
import JSZip from "jszip";
import { loadOriginalDocx } from "./src/docxOriginal.js";
import { docxToMarkdownMapped } from "./src/conversion.js";
import { indexDocumentXml, rewriteDocxText } from "./src/docxSurgery.js";
import { remapChaptersToParagraphEdits } from "./src/docxRemap.js";

const DOC = "bad94714-dc29-4bde-937e-0bcbd893db4d";
const JOB = process.argv[2];
const db = new Database(process.env.DATA_DIR + "/bethaniel.db", { readonly: true });
const doc = db.prepare("SELECT md FROM documents WHERE id=?").get(DOC) as { md: string };
const tasks = (db.prepare("SELECT state FROM tasks").all() as { state: string }[])
  .map((r) => JSON.parse(r.state))
  .filter((t) => String(t.jobId).startsWith(JOB))
  .sort((a, b) => (a.unitIndex ?? 0) - (b.unitIndex ?? 0));
const chapters = tasks.map((t) => ({ original: t.result.originalText, edited: t.result.editedText }));

const orig = await loadOriginalDocx(DOC);
if (!orig.ok) throw new Error(orig.reason);
const index = indexDocumentXml(await (await JSZip.loadAsync(orig.value.buffer)).file("word/document.xml")!.async("string"));

const run = async (label: string, md: string, map: typeof orig.value.paragraphMap) => {
  const { edits, unmapped } = remapChaptersToParagraphEdits(md, map, index, chapters);
  const { buffer, applied } = await rewriteDocxText(orig.value.buffer, edits);
  const out = indexDocumentXml(await (await JSZip.loadAsync(buffer)).file("word/document.xml")!.async("string"));
  let fr = 0, en = 0;
  for (const p of out.paragraphs) {
    const t = p.text.trim(); if (t.length < 30) continue;
    const isFr = /\b(les|des|une|qui|dans|pour|est|nous|vous|plus|avec)\b/i.test(t);
    const isEn = /\b(the|and|that|with|from|this|have|been|their|would)\b/i.test(t);
    if (isFr && !isEn) fr++; else if (isEn && !isFr) en++;
  }
  console.log(`${label.padEnd(34)} unmapped ${String(unmapped.length).padStart(4)} | applied ${String(applied).padStart(4)} | FR ${String(fr).padStart(3)} | EN ${String(en).padStart(3)}`);
};

await run("STORED map (what you got)", doc.md, orig.value.paragraphMap);
const fresh = await docxToMarkdownMapped(orig.value.buffer, { docId: DOC });
await run("RE-DERIVED map (the fix)", fresh.md, fresh.paragraphMap);
