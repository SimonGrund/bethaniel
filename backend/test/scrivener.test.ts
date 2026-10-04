// Linking a Scrivener project and writing Betty's changes back (scrivener.ts).
//
// Each test builds a small project in a temp folder, shaped like the one
// Scrivener 3.1.6 for Windows wrote: a .scrivx binder, one content.rtf per
// document, Files/version.txt and Files/Data/docs.checksum. The rules pinned
// hardest are the guards — nothing is written while the project is open,
// nothing over newer words, nothing without a full copy first — and that the
// checksum file stays true.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { readProject, writeBack, ScrivenerError } from "../src/scrivener.ts";

const HEAD =
  "{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0\r\n{\\fonttbl{\\f0\\fmodern\\fcharset0\\fprq2 SitkaText;}}\r\n" +
  "\\pard\\plain \\fi360\\ltrch\\loch ";
const rtf = (body: string) => `${HEAD}{\\f0\\fs24\\b0\\i0 ${body}}}`;
const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");

const S1 = "11111111-1111-1111-1111-111111111111";
const S2 = "22222222-2222-2222-2222-222222222222";
const S3 = "33333333-3333-3333-3333-333333333333";
const OUT = "44444444-4444-4444-4444-444444444444";

const item = (uuid: string, type: string, title: string, children = "", include = "Yes") =>
  `<BinderItem UUID="${uuid}" Type="${type}"><Title>${title}</Title><MetaData><IncludeInCompile>${include}</IncludeInCompile></MetaData>${
    children ? `<Children>${children}</Children>` : ""
  }</BinderItem>`;

async function makeProject(): Promise<{ root: string; dir: string; files: Record<string, string> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betty-scriv-"));
  const dir = path.join(root, "Novel.scriv");
  const files: Record<string, string> = {
    [S1]: rtf("This is scene 1. People will be fighting."),
    [S2]: rtf("And now the world is introduced\\loch\\af0\\uc1\\u8230\\'85\\par Second paragraph."),
    [S3]: rtf("Welcoem to chapter 2!"),
    [OUT]: rtf("Not in the book."),
  };
  // Folders as parts holding one document per chapter — and one document
  // untitled, which borrows its folder's name.
  const binder = item(
    "DRAFT",
    "DraftFolder",
    "Manuscript",
    item("C1", "Folder", "Part One", item(S1, "Text", "The Beginning") + item(S2, "Text", "")) +
      item("C2", "Folder", "Part Two", item(S3, "Text", "Chapter Two") + item(OUT, "Text", "Cut", "", "No")),
  );
  await fs.mkdir(path.join(dir, "Files", "Data"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "Novel.scrivx"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<ScrivenerProject Version="2.0"><Binder>${binder}</Binder></ScrivenerProject>`,
  );
  await fs.writeFile(path.join(dir, "Files", "version.txt"), "23");
  const sums: string[] = [];
  for (const [uuid, body] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, "Files", "Data", uuid));
    await fs.writeFile(path.join(dir, "Files", "Data", uuid, "content.rtf"), Buffer.from(body, "latin1"));
    sums.push(`${uuid}/content.rtf=${sha1(Buffer.from(body, "latin1"))}`);
  }
  sums.push("99999999-9999-9999-9999-999999999999/notes.rtf=abc");
  await fs.writeFile(path.join(dir, "Files", "Data", "docs.checksum"), sums.join("\n") + "\n");
  return { root, dir, files };
}

const contentOf = (dir: string, uuid: string) =>
  fs.readFile(path.join(dir, "Files", "Data", uuid, "content.rtf"), "latin1");

/** What the review hands write-back: the whole manuscript as one chapter. */
const edit = (md: string, from: string, to: string) => [{ original: md, edited: md.replace(from, to) }];

test("every document is its own unit under its own title, in binder order", async () => {
  // Folders only order documents: a project of parts holding one document
  // per chapter read as 7 "chapters" when folders were taken for chapters,
  // and it has 34.
  const { dir } = await makeProject();
  const { md, link } = await readProject(path.join(dir, "Novel.scrivx"));
  assert.equal(
    md,
    "# The Beginning\n\nThis is scene 1. People will be fighting.\n\n" +
      "# Part One\n\nAnd now the world is introduced…\n\nSecond paragraph.\n\n" +
      "# Chapter Two\n\nWelcoem to chapter 2!",
  );
  // Excluded from compile, so not in the book.
  assert.ok(!md.includes("Not in the book"));
  assert.equal(link.projectName, "Novel");
  assert.equal(link.scenes.length, 3);
  // Four paragraphs and the two documents' own titles. The untitled one's
  // heading is its folder's name, which is not its to change: not mapped.
  assert.equal(link.map.length, 6);
  assert.deepEqual(
    link.paragraphs.filter((p) => p.title !== undefined).map((p) => [p.uuid, p.title]),
    [[S1, "The Beginning"], [S3, "Chapter Two"]],
  );
});

// ── Italics, line breaks, titles ──

test("italic and bold are shown to Betty as Markdown, and written back around", async () => {
  const { dir } = await makeProject();
  // Scene 1, rewritten with an italic book title and a bold word.
  const scene = `${HEAD}{\\f0\\fs24 She read {\\i The Hobbit} and {\\b laughed}, teh end.}}`;
  await fs.writeFile(path.join(dir, "Files", "Data", S1, "content.rtf"), Buffer.from(scene, "latin1"));
  const { md, link } = await readProject(dir);
  assert.ok(md.includes("She read *The Hobbit* and **laughed**, teh end."), md);
  // A fix beside the italics lands, and the italic codes are untouched.
  const report = await writeBack(link, md, edit(md, "teh end", "the end"));
  assert.equal(report.applied, 1);
  assert.equal(await contentOf(dir, S1), scene.replace("teh end", "the end"));
});

test("a line break between words reads as a line; edges and doubles stay spaces", async () => {
  const { manuscriptPlain } = await import("../src/scrivener.ts");
  assert.equal(manuscriptPlain("Dear Anna,\nI write."), "Dear Anna,\nI write.");
  assert.equal(manuscriptPlain("A\n\nB"), "A\n B");
  assert.equal(manuscriptPlain("A\n \nB"), "A\n  B");
  assert.equal(manuscriptPlain("\nA\n"), " A ");
  assert.equal(manuscriptPlain("A\tB"), "A B");
  // Same length always: every offset still lines up with the RTF.
  for (const s of ["A\n\n\nB", "\n\nA", "A\n \n \nB"]) assert.equal(manuscriptPlain(s).length, s.length);
});

test("a paragraph with line breaks still writes back where the words are", async () => {
  const { dir } = await makeProject();
  const scene = `${HEAD}{\\f0\\fs24 Dear Anna,\\line I hoep you are well.}}`;
  await fs.writeFile(path.join(dir, "Files", "Data", S1, "content.rtf"), Buffer.from(scene, "latin1"));
  const { md, link } = await readProject(dir);
  assert.ok(md.includes("Dear Anna,\nI hoep you are well."), md);
  const report = await writeBack(link, md, edit(md, "hoep", "hope"));
  assert.equal(report.applied, 1);
  assert.equal(await contentOf(dir, S1), scene.replace("hoep", "hope"));
});

test("a corrected chapter title is written into the binder, and only it", async () => {
  const { dir } = await makeProject();
  const before = await fs.readFile(path.join(dir, "Novel.scrivx"), "utf8");
  const { md, link } = await readProject(dir);
  const report = await writeBack(link, md, edit(md, "# Chapter Two", "# Chapter 2"));
  assert.equal(report.applied, 1);
  const after = await fs.readFile(path.join(dir, "Novel.scrivx"), "utf8");
  assert.equal(after, before.replace("<Title>Chapter Two</Title>", "<Title>Chapter 2</Title>"));
  // The copy still has the old title.
  assert.ok((await fs.readFile(path.join(report.backupDir!, "Novel.scrivx"), "utf8")).includes("Chapter Two"));
});

test("Scrivener's autosaved copy of the binder gets the same title change", async () => {
  const JSZip = (await import("jszip")).default;
  const { dir } = await makeProject();
  const scrivx = await fs.readFile(path.join(dir, "Novel.scrivx"), "utf8");
  const zip = new JSZip();
  zip.file("Novel.scrivx", scrivx);
  await fs.writeFile(path.join(dir, "Files", "binder.autosave"), await zip.generateAsync({ type: "nodebuffer" }));
  const { md, link } = await readProject(dir);
  await writeBack(link, md, edit(md, "# Chapter Two", "# Chapter 2"));
  const saved = await JSZip.loadAsync(await fs.readFile(path.join(dir, "Files", "binder.autosave")));
  const inside = await saved.file("Novel.scrivx")!.async("string");
  assert.ok(inside.includes("<Title>Chapter 2</Title>"), inside);
  assert.ok(!inside.includes("Chapter Two"));
});

test("a title renamed in Scrivener since Betty read it is listed, not overwritten", async () => {
  const { dir } = await makeProject();
  const { md, link } = await readProject(dir);
  const p = path.join(dir, "Novel.scrivx");
  await fs.writeFile(p, (await fs.readFile(p, "utf8")).replace("Chapter Two", "Two: The Return"));
  const report = await writeBack(link, md, edit(md, "# Chapter Two", "# Chapter 2"));
  assert.equal(report.applied, 0);
  assert.equal(report.skipped[0]?.reason, "title-changed");
  assert.ok((await fs.readFile(p, "utf8")).includes("Two: The Return"));
});

test("the project folder or its .scrivx both link", async () => {
  const { dir } = await makeProject();
  assert.equal((await readProject(dir)).link.projectDir, dir);
});

test("a dry run plans the changes and writes nothing", async () => {
  const { dir, files } = await makeProject();
  const { md, link } = await readProject(dir);
  const report = await writeBack(link, md, edit(md, "Welcoem", "Welcome"), { dryRun: true });
  assert.equal(report.applied, 1);
  assert.equal(report.backupDir, undefined);
  assert.equal(await contentOf(dir, S3), files[S3]);
});

test("a write-back copies the project first, then changes only the text", async () => {
  const { root, dir, files } = await makeProject();
  const { md, link } = await readProject(dir);
  const report = await writeBack(link, md, edit(md, "Welcoem", "Welcome"));
  assert.equal(report.applied, 1);
  assert.deepEqual(report.scenesChanged, ["Chapter Two"]);

  // Changed: that word, nothing else.
  assert.equal(await contentOf(dir, S3), files[S3].replace("Welcoem", "Welcome"));
  assert.equal(await contentOf(dir, S1), files[S1]);

  // The copy is the project as it was, beside it, under its own name.
  assert.ok(report.backupDir!.startsWith(path.join(root, "Novel - Betty backups")));
  assert.equal(path.basename(report.backupDir!), "Novel.scriv");
  assert.equal(await contentOf(report.backupDir!, S3), files[S3]);
  await fs.access(path.join(report.backupDir!, "Novel.scrivx"));

  // The checksum file is true again for the changed file, untouched elsewhere.
  const sums = await fs.readFile(path.join(dir, "Files", "Data", "docs.checksum"), "utf8");
  const now = sha1(Buffer.from(await contentOf(dir, S3), "latin1"));
  assert.ok(sums.includes(`${S3}/content.rtf=${now}`), sums);
  assert.ok(sums.includes(`${S1}/content.rtf=${sha1(Buffer.from(files[S1], "latin1"))}`));
  assert.ok(sums.includes("99999999-9999-9999-9999-999999999999/notes.rtf=abc"));
  // No temp files left behind.
  const left = await fs.readdir(path.join(dir, "Files", "Data", S3));
  assert.deepEqual(left, ["content.rtf"]);
});

test("a Mac project's checksum file, with lowercase ids, is kept true too", async () => {
  // Found on a real Scrivener 3.5 (Mac) project: docs.checksum names the
  // folders in lowercase while the folders themselves are uppercase.
  const { dir } = await makeProject();
  const sumsPath = path.join(dir, "Files", "Data", "docs.checksum");
  await fs.writeFile(sumsPath, (await fs.readFile(sumsPath, "utf8")).toLowerCase());
  const { md, link } = await readProject(dir);
  await writeBack(link, md, edit(md, "Welcoem", "Welcome"));
  const now = sha1(Buffer.from(await contentOf(dir, S3), "latin1"));
  const sums = await fs.readFile(sumsPath, "utf8");
  assert.ok(sums.includes(`${S3.toLowerCase()}/content.rtf=${now}`), sums);
});

test("nothing is written while the project is open in Scrivener", async () => {
  const { dir, files } = await makeProject();
  const { md, link } = await readProject(dir);
  await fs.writeFile(path.join(dir, "Files", "user.lock"), "[General]\nplatform=win\n");
  await assert.rejects(
    writeBack(link, md, edit(md, "Welcoem", "Welcome")),
    (e: unknown) => e instanceof ScrivenerError && e.reason === "project-open",
  );
  assert.equal(await contentOf(dir, S3), files[S3]);
});

test("nothing is written over a scene changed in Scrivener since Betty read it", async () => {
  const { dir } = await makeProject();
  const { md, link } = await readProject(dir);
  // The author keeps writing in Scrivener.
  await fs.writeFile(path.join(dir, "Files", "Data", S3, "content.rtf"), rtf("Welcoem to chapter 2! More."));
  await assert.rejects(
    writeBack(link, md, edit(md, "Welcoem", "Welcome")),
    (e: unknown) => e instanceof ScrivenerError && e.reason === "changed-since-link",
  );
  assert.equal(await contentOf(dir, S3), rtf("Welcoem to chapter 2! More."));
});

test("a review is written back once; a second write asks for a fresh link", async () => {
  const { dir } = await makeProject();
  const { md, link } = await readProject(dir);
  await writeBack(link, md, edit(md, "Welcoem", "Welcome"));
  await assert.rejects(
    writeBack(link, md, edit(md, "Welcoem", "Welcome")),
    (e: unknown) => e instanceof ScrivenerError && e.reason === "already-written",
  );
});

test("a change that cannot be made without touching formatting is listed, not made", async () => {
  const { dir, files } = await makeProject();
  const { md, link } = await readProject(dir);
  // "introduced" and "…" sit either side of a font switch in the RTF; one
  // change rewriting both crosses it.
  const report = await writeBack(link, md, edit(md, "introduced…", "shown"));
  assert.equal(report.applied, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].reason, "spans-formatting");
  assert.equal(report.backupDir, undefined, "nothing to write, so no copy and no change");
  assert.equal(await contentOf(dir, S2), files[S2]);
});

test("a folder that is not a Scrivener project is refused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betty-notscriv-"));
  await assert.rejects(
    readProject(root),
    (e: unknown) => e instanceof ScrivenerError && e.reason === "not-a-project",
  );
});
