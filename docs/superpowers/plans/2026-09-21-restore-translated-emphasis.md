# Restoring Translated Emphasis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a translation's emphasis back into the author's own italic run, instead of discarding it and reporting the loss.

**Architecture:** The translated Markdown already carries emphasis markers in the right places (measured: 264 of 265 paragraphs). A flattened paragraph already contains the runs needed — a base run and an emphasised one. So: parse the Markdown into pieces, fold the paragraph's runs into segments, and when the two agree in count and order, give each segment its own text instead of dumping everything into the first run. No new XML. When they disagree, fall back to exactly today's behaviour and report it.

**Tech Stack:** TypeScript, `node:test` via the `tsx` loader.

**Spec:** `docs/superpowers/specs/2026-09-21-restore-translated-emphasis-design.md`

## Global Constraints

- **Never guess an allocation.** Distribute only when segment count, emphasised-ness order, and non-emptiness all agree. A loose match italicises the *wrong* phrase, which is worse than losing the emphasis — and losing it is what already happens, so a fallback costs nothing.
- **The fallback must be byte-identical to today's output.** A test pins this.
- **Only paragraphs already flattened.** Paragraphs that export cleanly today are not touched.
- **Silent when it works.** Report only what could not be restored, counted in **phrases**, not paragraphs — one paragraph can hold two.
- i18n is four languages: `en`, `da`, `de`, `es`. `Lang` in `frontend/src/types.ts` has no `fr`; adding it is a TypeScript error.
- Verify with `cd backend && npm test`, `cd backend && npm run build`, `cd frontend && npm run build`.
- Do **not** push to `main` — a push there cuts a release. Work on a branch.
- Comments explain *why*. Do not restate the code.

---

### Task 1: Splitting Markdown into emphasised pieces

**Files:**
- Create: `backend/src/emphasisSpans.ts`
- Test: `backend/test/emphasisSpans.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `backend/src/emphasisSpans.ts`:
  - `interface EmphasisPiece { text: string; emphasised: boolean }`
  - `function splitEmphasis(md: string): EmphasisPiece[]`

- [ ] **Step 1: Write the failing test**

Create `backend/test/emphasisSpans.test.ts`:

```ts
// ── Reading a translated paragraph's emphasis out of its Markdown ──
//
// The model preserves the emphasis markers it is given, and wraps the TARGET
// language's words in them — measured at 264 of 265 paragraphs on a real
// French translation. This is the half that reads them back out.
//
// Everything here is plain text in, plain data out: no docx, no runs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { splitEmphasis } from "../src/emphasisSpans.ts";

test("plain text is one unemphasised piece", () => {
  assert.deepEqual(splitEmphasis("Just a sentence."), [
    { text: "Just a sentence.", emphasised: false },
  ]);
});

test("an emphasised phrase splits into three pieces", () => {
  assert.deepEqual(splitEmphasis("I said _love multiplies_ here."), [
    { text: "I said ", emphasised: false },
    { text: "love multiplies", emphasised: true },
    { text: " here.", emphasised: false },
  ]);
});

test("bold counts as emphasis too", () => {
  assert.deepEqual(splitEmphasis("A **bold** word."), [
    { text: "A ", emphasised: false },
    { text: "bold", emphasised: true },
    { text: " word.", emphasised: false },
  ]);
});

test("every marker style is recognised", () => {
  for (const md of ["a *x* b", "a _x_ b", "a **x** b", "a __x__ b", "a ***x*** b"]) {
    const pieces = splitEmphasis(md);
    assert.equal(pieces.length, 3, `not split: ${md}`);
    assert.deepEqual(pieces[1], { text: "x", emphasised: true }, `wrong middle: ${md}`);
  }
});

test("a paragraph that opens with emphasis has no empty piece before it", () => {
  // An empty leading piece would make the shape disagree with a docx whose
  // first run IS the emphasised one, and the whole paragraph would fall back.
  assert.deepEqual(splitEmphasis("_Ilse_ crossed the ice."), [
    { text: "Ilse", emphasised: true },
    { text: " crossed the ice.", emphasised: false },
  ]);
});

test("a paragraph that ends with emphasis has no empty piece after it", () => {
  assert.deepEqual(splitEmphasis("She whispered _Ilse_"), [
    { text: "She whispered ", emphasised: false },
    { text: "Ilse", emphasised: true },
  ]);
});

test("two emphasised phrases give five pieces", () => {
  const pieces = splitEmphasis("a _one_ b _two_ c");
  assert.equal(pieces.length, 5);
  assert.deepEqual(
    pieces.map((p) => p.emphasised),
    [false, true, false, true, false],
  );
});

test("adjacent emphasis does not produce an empty piece between them", () => {
  const pieces = splitEmphasis("_one__two_");
  assert.ok(
    pieces.every((p) => p.text.length > 0),
    `empty piece in ${JSON.stringify(pieces)}`,
  );
});

test("an underscore inside a word is not emphasis", () => {
  // snake_case in a manuscript is rare but a lone marker is not emphasis, and
  // treating it as such would split a word in half across two runs.
  assert.deepEqual(splitEmphasis("file_name here"), [
    { text: "file_name here", emphasised: false },
  ]);
});

test("an unclosed marker is left as text", () => {
  assert.deepEqual(splitEmphasis("a *dangling"), [
    { text: "a *dangling", emphasised: false },
  ]);
});

test("empty input gives no pieces at all", () => {
  assert.deepEqual(splitEmphasis(""), []);
  assert.deepEqual(splitEmphasis("   "), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/emphasisSpans.test.ts`
Expected: FAIL — `../src/emphasisSpans.ts` does not exist.

- [ ] **Step 3: Write the module**

Create `backend/src/emphasisSpans.ts`:

```ts
// ── Emphasis, read out of a translated paragraph and matched to its runs ──
//
// A translation replaces a whole paragraph, so the export used to give up any
// emphasis inside it. It need not: the model is given Markdown with the
// markers in, and it preserves them around the TARGET language's words —
// measured at 264 of 265 paragraphs on a real French translation, 304 spans in
// and 303 out.
//
// And the paragraph already has the runs to put them in. A paragraph is
// "flattened" precisely because it holds more than one formatting: a base run
// and an emphasised one. So nothing has to be created — the translated pieces
// only have to be handed to the runs that are already there.
//
// Pure: no docx types, no Markdown library, so the matching can be tested on
// its own.

/** One stretch of a paragraph, either emphasised or not. */
export interface EmphasisPiece {
  text: string;
  emphasised: boolean;
}

/**
 * Emphasis as turndown writes it. Longest markers first, so `***x***` is not
 * read as `*` twice. `(?=\S)` and `\S` pin the marker to non-space, which is
 * what stops an underscore inside a word — file_name — from opening a span.
 */
const EMPHASIS_RE = /(\*\*\*|___|\*\*|__|\*|_)(?=\S)([\s\S]*?\S)\1/g;

/**
 * Split a paragraph's Markdown into emphasised and unemphasised pieces.
 *
 * Empty pieces are never emitted: a paragraph that opens or closes with
 * emphasis would otherwise gain a zero-length piece, the shape would disagree
 * with a docx whose first run IS the emphasised one, and the whole paragraph
 * would fall back for no reason.
 */
export function splitEmphasis(md: string): EmphasisPiece[] {
  const pieces: EmphasisPiece[] = [];
  const push = (text: string, emphasised: boolean) => {
    if (text.length > 0) pieces.push({ text, emphasised });
  };

  let cursor = 0;
  for (const m of md.matchAll(EMPHASIS_RE)) {
    const at = m.index ?? 0;
    push(md.slice(cursor, at), false);
    push(m[2], true);
    cursor = at + m[0].length;
  }
  push(md.slice(cursor), false);

  // A paragraph of nothing but whitespace has no pieces to give.
  return pieces.length === 1 && !pieces[0].text.trim() ? [] : pieces;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx tsx --test test/emphasisSpans.test.ts`
Expected: PASS, all eleven.

- [ ] **Step 5: Commit**

```bash
git add backend/src/emphasisSpans.ts backend/test/emphasisSpans.test.ts
git commit -m "feat(translate): read a translated paragraph's emphasis out of its markdown"
```

---

### Task 2: Folding runs into segments, and the shape check

The decision that must never guess.

**Files:**
- Modify: `backend/src/emphasisSpans.ts`
- Test: `backend/test/emphasisAllocation.test.ts`

**Interfaces:**
- Consumes: `EmphasisPiece`, `splitEmphasis` (Task 1).
- Produces, from `backend/src/emphasisSpans.ts`:
  - `interface RunLike { rPrXml: string; text: string; kind: string }`
  - `interface Segment { rPrXml: string; text: string }`
  - `function foldSegments(nodes: readonly RunLike[]): Segment[]`
  - `function allocateEmphasis(segments: readonly Segment[], pieces: readonly EmphasisPiece[]): string[] | null`

`allocateEmphasis` returns one string per segment, in segment order, or `null`
when the shapes do not agree.

- [ ] **Step 1: Write the failing test**

Create `backend/test/emphasisAllocation.test.ts`:

```ts
// ── Matching a translation's emphasis to the runs already in the paragraph ──
//
// The safety argument lives here. Distributing text across runs by a loose
// match would italicise the WRONG phrase, which is worse than losing the
// emphasis — and losing it is exactly what happens today, so refusing costs
// nothing. Every test below that ends in `null` is that rule.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allocateEmphasis,
  foldSegments,
  splitEmphasis,
} from "../src/emphasisSpans.ts";

const run = (text: string, rPrXml = "") => ({ text, rPrXml, kind: "t" });

test("consecutive runs sharing formatting fold into one segment", () => {
  const segs = foldSegments([run("Hello "), run("world"), run("!", "<i/>")]);
  assert.deepEqual(segs, [
    { rPrXml: "", text: "Hello world" },
    { rPrXml: "<i/>", text: "!" },
  ]);
});

test("virtual nodes are ignored — they carry no replaceable text", () => {
  const segs = foldSegments([
    run("a"),
    { text: "\n", rPrXml: "", kind: "virtual" },
    run("b"),
  ]);
  assert.deepEqual(segs, [{ rPrXml: "", text: "ab" }]);
});

test("the real shape from the manuscript: base / emphasised / base", () => {
  const segs = foldSegments([
    run("I will be honest with you: "),
    run("love multiplies", "<i/>"),
    run("."),
  ]);
  assert.equal(segs.length, 3);
  assert.deepEqual(
    segs.map((s) => s.rPrXml !== segs[0].rPrXml),
    [false, true, false],
  );
});

test("a matching shape allocates each piece to its segment", () => {
  const segs = foldSegments([run("before "), run("middle", "<i/>"), run(" after")]);
  const pieces = splitEmphasis("avant _milieu_ après");
  assert.deepEqual(allocateEmphasis(segs, pieces), ["avant ", "milieu", " après"]);
});

test("a differing COUNT refuses rather than guessing", () => {
  // The model merged two emphasised phrases into one. Which run loses out is
  // not knowable, so nothing is placed.
  const segs = foldSegments([
    run("a "),
    run("one", "<i/>"),
    run(" b "),
    run("two", "<i/>"),
    run(" c"),
  ]);
  assert.equal(allocateEmphasis(segs, splitEmphasis("a _un_ b deux c")), null);
});

test("a differing ORDER refuses even when the count matches", () => {
  // Three segments each way, but the docx emphasises the middle and the
  // translation emphasises the first. Placing them in order would italicise
  // the wrong words.
  const segs = foldSegments([run("a "), run("b", "<i/>"), run(" c")]);
  const pieces = [
    { text: "a", emphasised: true },
    { text: "b", emphasised: false },
    { text: "c", emphasised: false },
  ];
  assert.equal(allocateEmphasis(segs, pieces), null);
});

test("an empty piece refuses — a run would be blanked", () => {
  const segs = foldSegments([run("a "), run("b", "<i/>"), run(" c")]);
  const pieces = [
    { text: "a ", emphasised: false },
    { text: "", emphasised: true },
    { text: " c", emphasised: false },
  ];
  assert.equal(allocateEmphasis(segs, pieces), null);
});

test("a paragraph with no emphasis on either side needs no allocation", () => {
  // One segment, one piece: nothing to distribute, and the ordinary path
  // already handles it.
  const segs = foldSegments([run("plain")]);
  assert.deepEqual(allocateEmphasis(segs, splitEmphasis("simple")), ["simple"]);
});

test("no segments, or no pieces, refuses", () => {
  assert.equal(allocateEmphasis([], splitEmphasis("x")), null);
  assert.equal(allocateEmphasis(foldSegments([run("x")]), []), null);
});

test("emphasis leading the paragraph matches a docx that leads with it too", () => {
  const segs = foldSegments([run("Ilse", "<i/>"), run(" crossed the ice.")]);
  const got = allocateEmphasis(segs, splitEmphasis("_Ilse_ a traversé la glace."));
  assert.deepEqual(got, ["Ilse", " a traversé la glace."]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/emphasisAllocation.test.ts`
Expected: FAIL — `foldSegments` and `allocateEmphasis` are not exported.

- [ ] **Step 3: Implement**

Append to `backend/src/emphasisSpans.ts`:

```ts
/** The part of a docx text node this module needs. Structural, so the module
 *  stays free of docxSurgery's types and can be tested on plain objects. */
export interface RunLike {
  rPrXml: string;
  text: string;
  kind: string;
}

/** Consecutive runs that share formatting, as one stretch of text. */
export interface Segment {
  rPrXml: string;
  text: string;
}

/**
 * Fold a paragraph's runs into segments.
 *
 * Word splits runs for reasons of its own — a spell-check marker, a language
 * tag — that carry no formatting difference. Folding by rPrXml means those
 * splits do not make the paragraph look more complicated than it reads.
 *
 * Virtual nodes (a tab, a line break) are dropped: they hold a character but
 * no replaceable range, so they are not a place text can be put.
 */
export function foldSegments(nodes: readonly RunLike[]): Segment[] {
  const segments: Segment[] = [];
  for (const n of nodes) {
    if (n.kind === "virtual") continue;
    const last = segments[segments.length - 1];
    if (last && last.rPrXml === n.rPrXml) last.text += n.text;
    else segments.push({ rPrXml: n.rPrXml, text: n.text });
  }
  return segments;
}

/**
 * Which text each segment should receive, or null if that cannot be known.
 *
 * A segment is "emphasised" when its formatting differs from the FIRST
 * segment's — the same rule the export already uses to decide what a flattened
 * paragraph gave up.
 *
 * Refuses unless the two shapes agree completely: same number of parts, the
 * same emphasised-ness in the same order, and nothing empty. That strictness
 * is the whole safety argument — a partial match would put French text in the
 * wrong run and italicise the wrong phrase, which is worse than losing the
 * emphasis. Losing it is what happens today, so refusing costs nothing.
 */
export function allocateEmphasis(
  segments: readonly Segment[],
  pieces: readonly EmphasisPiece[],
): string[] | null {
  if (segments.length === 0 || pieces.length === 0) return null;
  if (segments.length !== pieces.length) return null;

  const base = segments[0].rPrXml;
  for (let i = 0; i < segments.length; i++) {
    if ((segments[i].rPrXml !== base) !== pieces[i].emphasised) return null;
    if (pieces[i].text.length === 0) return null;
  }
  return pieces.map((p) => p.text);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx tsx --test test/emphasisAllocation.test.ts`
Expected: PASS, all ten.

- [ ] **Step 5: Commit**

```bash
git add backend/src/emphasisSpans.ts backend/test/emphasisAllocation.test.ts
git commit -m "feat(translate): match a translation's emphasis to the runs already there, or refuse"
```

---

### Task 3: Carry the allocation on the edit

**Files:**
- Modify: `backend/src/docxSurgery.ts` (the `ParagraphTextEdit` interface)
- Modify: `backend/src/docxRemap.ts` (the whole-paragraph emission)

**Interfaces:**
- Consumes: `splitEmphasis`, `foldSegments`, `allocateEmphasis` (Tasks 1–2).
- Produces: `ParagraphTextEdit.segments?: string[]` — one string per folded segment of the target paragraph, in order. Present only when the shapes agreed.

- [ ] **Step 1: Widen the edit type**

In `backend/src/docxSurgery.ts`, inside `export interface ParagraphTextEdit`,
after the `wholeParagraph` field, add:

```ts
  /**
   * One string per folded segment of this paragraph, in order — set only when
   * a translation's emphasis could be matched to the runs already present.
   *
   * With it, each segment's runs receive their own text and the emphasised
   * French lands in the author's own italic run, keeping their font and size.
   * Without it the paragraph is flattened as before.
   */
  segments?: string[];
```

- [ ] **Step 2: Emit it from the remap**

In `backend/src/docxRemap.ts`, add the import at the top beside the others:

```ts
import {
  allocateEmphasis,
  foldSegments,
  splitEmphasis,
} from "./emphasisSpans.js";
```

Then find, in `remapChaptersToParagraphEdits`:

```ts
      // Diff against the docx's own text, so offsets are in its coordinates
      // even when whitespace differed from the markdown.
      for (const e of paragraphEdits(paragraph.text, afterPlain)) {
        edits.push({ paragraphIndex: entry.docxParaIndex, ...e });
      }
```

Replace with:

```ts
      // Diff against the docx's own text, so offsets are in its coordinates
      // even when whitespace differed from the markdown.
      for (const e of paragraphEdits(paragraph.text, afterPlain)) {
        // Only a whole-paragraph replacement — a translation — can carry
        // emphasis across, and only it has a paragraph's worth of text to
        // distribute. A correction edits a span and leaves the rest alone.
        const segments = e.wholeParagraph
          ? (allocateEmphasis(foldSegments(paragraph.nodes), splitEmphasis(newMd)) ??
            undefined)
          : undefined;
        edits.push({ paragraphIndex: entry.docxParaIndex, ...e, segments });
      }
```

Note `newMd`, not `afterPlain`: the markers are still in `newMd` and are
exactly what is being read. `afterPlain` has had them stripped.

- [ ] **Step 3: Typecheck**

Run: `cd backend && npm run build`
Expected: silent.

If it reports that `paragraph.nodes` is not assignable to `readonly RunLike[]`,
that is `TextNode.kind` being the union `"t" | "virtual"` against `RunLike`'s
`string` — which is assignable. Any other error means the wrong `paragraph`
variable is in scope; it is the one declared as
`const paragraph = index.paragraphs[entry.docxParaIndex];`.

- [ ] **Step 4: Confirm nothing changed yet**

Run: `cd backend && npm test 2>&1 | grep -E "^.ℹ? ?(pass|fail)"`
Expected: `fail 0`. Nothing consumes `segments` yet, so output is unchanged —
this step only proves the allocation can be computed without breaking anything.

- [ ] **Step 5: Commit**

```bash
git add backend/src/docxSurgery.ts backend/src/docxRemap.ts
git commit -m "feat(translate): compute where a translation's emphasis belongs"
```

---

### Task 4: Give each segment its own text

The behavioural change.

**Files:**
- Modify: `backend/src/docxSurgery.ts` (the allocation block in `planParagraphSplices`)
- Test: `backend/test/emphasisRestored.test.ts`

**Interfaces:**
- Consumes: `ParagraphTextEdit.segments` (Task 3); `foldSegments` (Task 2).
- Produces: `rewriteDocxText` returns `restored: number` — paragraphs whose emphasis was put back — alongside the existing `flattened` and `flattenedDetail`, which from now on count only paragraphs where it was **not**.

- [ ] **Step 1: Write the failing test**

Create `backend/test/emphasisRestored.test.ts`:

```ts
// ── The translation's emphasis reaches the author's own italic run ──
//
// Not a generic <w:i/>: the emphasised text is put into the run that was
// already emphasised, so it keeps the author's font, size and highlight. That
// is why this needs no new XML — the run is already there, and was only being
// blanked.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { indexDocumentXml, rewriteDocxText } from "../src/docxSurgery.ts";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A paragraph of three runs: base, italic, base. */
const PARA =
  "<w:p>" +
  '<w:r><w:t xml:space="preserve">I will be honest: </w:t></w:r>' +
  '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">love multiplies</w:t></w:r>' +
  '<w:r><w:t xml:space="preserve">.</w:t></w:r>' +
  "</w:p>";

async function docxOf(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip
    .folder("_rels")!
    .file(
      ".rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    );
  zip
    .folder("word")!
    .file(
      "document.xml",
      `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
    );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function xmlOf(buf: Buffer): Promise<string> {
  return (
    (await (await JSZip.loadAsync(buf)).file("word/document.xml")?.async("string")) ?? ""
  );
}

const WHOLE = {
  paragraphIndex: 0,
  start: 0,
  end: "I will be honest: love multiplies.".length,
  wholeParagraph: true,
};

test("with an allocation, each run receives its own translated text", async () => {
  const input = await docxOf(PARA);
  const { buffer, restored, flattened } = await rewriteDocxText(input, [
    {
      ...WHOLE,
      replacement: "Je serai honnête : l'amour se multiplie.",
      segments: ["Je serai honnête : ", "l'amour se multiplie", "."],
    },
  ]);
  const xml = await xmlOf(buffer);
  // The emphasised French sits inside the run that carries <w:i/>.
  assert.match(xml, /<w:rPr><w:i\/><\/w:rPr><w:t[^>]*>l'amour se multiplie<\/w:t>/);
  assert.match(xml, /Je serai honnête/);
  assert.equal(restored, 1);
  assert.equal(flattened, 0, "a restored paragraph must not also count as lost");
});

test("the italic run still exists and is still italic", async () => {
  // The point of reusing the run rather than creating one: no new XML, and the
  // author's own styling survives.
  const input = await docxOf(PARA);
  const { buffer } = await rewriteDocxText(input, [
    {
      ...WHOLE,
      replacement: "a b c",
      segments: ["a ", "b", " c"],
    },
  ]);
  const out = indexDocumentXml(await xmlOf(buffer));
  const p = out.paragraphs[0];
  const fmts = new Set(
    p.nodes.filter((n) => n.kind !== "virtual").map((n) => n.rPrXml),
  );
  assert.equal(fmts.size, 2, "the paragraph lost its second formatting");
  assert.equal(p.text, "a b c");
});

test("without an allocation the paragraph is flattened exactly as before", async () => {
  const input = await docxOf(PARA);
  const { buffer, restored, flattened, flattenedDetail } = await rewriteDocxText(
    input,
    [{ ...WHOLE, replacement: "tout dans le premier run" }],
  );
  const out = indexDocumentXml(await xmlOf(buffer));
  assert.equal(out.paragraphs[0].text, "tout dans le premier run");
  assert.equal(restored, 0);
  assert.equal(flattened, 1);
  assert.equal(flattenedDetail.length, 1);
  assert.deepEqual(flattenedDetail[0].emphasised, ["love multiplies"]);
});

test("a wrong-length allocation is refused, not partly applied", async () => {
  // Defensive: docxRemap should never emit this, but a half-applied paragraph
  // would put French text in the wrong run — the one outcome worse than
  // losing the emphasis.
  const input = await docxOf(PARA);
  const { buffer, restored, flattened } = await rewriteDocxText(input, [
    { ...WHOLE, replacement: "fallback text", segments: ["only", "two"] },
  ]);
  const out = indexDocumentXml(await xmlOf(buffer));
  assert.equal(out.paragraphs[0].text, "fallback text");
  assert.equal(restored, 0);
  assert.equal(flattened, 1);
});

test("an ordinary correction is untouched by any of this", async () => {
  // No wholeParagraph, no segments: the existing path, unchanged.
  const input = await docxOf(PARA);
  const { buffer, restored } = await rewriteDocxText(input, [
    { paragraphIndex: 0, start: 0, end: 6, replacement: "I shall" },
  ]);
  const out = indexDocumentXml(await xmlOf(buffer));
  assert.match(out.paragraphs[0].text, /^I shall/);
  assert.equal(restored, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/emphasisRestored.test.ts`
Expected: FAIL — `restored` is not a property of the result.

- [ ] **Step 3: Distribute across segments**

In `backend/src/docxSurgery.ts`, add the import beside the others at the top:

```ts
import { foldSegments } from "./emphasisSpans.js";
```

Find this block in `planParagraphSplices` (it begins `if (touched.length > 1) {`):

```ts
    if (touched.length > 1) {
      const fmt = new Set(touched.map((n) => n.rPrXml));
      if (fmt.size > 1) {
        // A correction must not guess which formatting to keep — refusing is
        // the guarantee this export exists for. A translation has no such
        // choice to get wrong: the paragraph is going regardless, and
        // refusing it hands the author their own language back. Collapse to
        // the first run's formatting, and count it so they can be told.
        if (!raw.wholeParagraph) {
          skip(raw, "mixed-formatting");
          continue;
        }
        flattened++;
        // Record WHAT was given up, not just that something was. The first
        // run's formatting is the one being kept, so everything that differs
        // from it is what the author loses.
        const kept = touched[0]?.rPrXml;
        flattenedDetail.push({
          paragraphIndex: p.index,
          before: p.text,
          emphasised: touched
            .filter((n) => n.kind !== "virtual" && n.rPrXml !== kept)
            .map((n) => n.text.trim())
            .filter(Boolean),
        });
      }
    }

    // Record each node's share. The first touched node receives the whole
    // replacement; later ones simply lose their overlapped characters.
    touched.forEach((n, i) => {
      const nEnd = n.textStart + n.text.length;
      const from = Math.max(e.start, n.textStart) - n.textStart;
      const to = Math.min(e.end, nEnd) - n.textStart;
      const list = pending.get(n) ?? [];
      list.push({ from, to, insert: i === 0 ? e.replacement : "" });
      pending.set(n, list);
    });
```

Replace the whole of the above with:

```ts
    /** Text per segment, when this translation's emphasis could be placed. */
    let allocation: string[] | null = null;

    if (touched.length > 1) {
      const fmt = new Set(touched.map((n) => n.rPrXml));
      if (fmt.size > 1) {
        // A correction must not guess which formatting to keep — refusing is
        // the guarantee this export exists for. A translation has no such
        // choice to get wrong: the paragraph is going regardless, and
        // refusing it hands the author their own language back.
        if (!raw.wholeParagraph) {
          skip(raw, "mixed-formatting");
          continue;
        }

        // The translation carries its own emphasis, and this paragraph
        // already has the runs to hold it. Checked again here rather than
        // trusted: a mis-sized allocation would put text in the wrong run,
        // which is the one outcome worse than losing the emphasis.
        const segments = foldSegments(touched);
        if (raw.segments && raw.segments.length === segments.length) {
          allocation = raw.segments;
          restored++;
        } else {
          flattened++;
          // Record WHAT was given up, not just that something was. The first
          // run's formatting is the one being kept, so everything that
          // differs from it is what the author loses.
          const kept = touched[0]?.rPrXml;
          flattenedDetail.push({
            paragraphIndex: p.index,
            before: p.text,
            emphasised: touched
              .filter((n) => n.kind !== "virtual" && n.rPrXml !== kept)
              .map((n) => n.text.trim())
              .filter(Boolean),
          });
        }
      }
    }

    // Record each node's share.
    //
    // With an allocation, the first node of each SEGMENT takes that segment's
    // text and the rest of the segment is emptied — so the emphasised French
    // lands in the run that was already emphasised. Without one, the first
    // node takes everything, exactly as before.
    let segmentIndex = -1;
    let lastRPr: string | null = null;
    touched.forEach((n, i) => {
      const nEnd = n.textStart + n.text.length;
      const from = Math.max(e.start, n.textStart) - n.textStart;
      const to = Math.min(e.end, nEnd) - n.textStart;

      // No virtual-node case: an edit touching one was skipped as
      // "virtual-node" further up, so none can reach here.
      let insert: string;
      if (!allocation) {
        insert = i === 0 ? e.replacement : "";
      } else {
        const startsSegment = lastRPr === null || n.rPrXml !== lastRPr;
        if (startsSegment) segmentIndex++;
        lastRPr = n.rPrXml;
        insert = startsSegment ? (allocation[segmentIndex] ?? "") : "";
      }

      const list = pending.get(n) ?? [];
      list.push({ from, to, insert });
      pending.set(n, list);
    });
```

- [ ] **Step 4: Thread `restored` through**

In `planParagraphSplices`, beside `let flattened = 0;` add:

```ts
  /** Whole-paragraph replacements whose emphasis was put back. */
  let restored = 0;
```

Change its return type from:

```ts
): {
  splices: Splice[];
  skipped: SkippedEdit[];
  flattened: number;
  flattenedDetail: FlattenedParagraph[];
} {
```

to:

```ts
): {
  splices: Splice[];
  skipped: SkippedEdit[];
  flattened: number;
  flattenedDetail: FlattenedParagraph[];
  restored: number;
} {
```

and its `return` from `{ splices, skipped, flattened, flattenedDetail }` to
`{ splices, skipped, flattened, flattenedDetail, restored }`.

In `rewriteDocxText`, beside `let flattened = 0;` add `let restored = 0;`, add
`restored += res.restored;` beside `flattened += res.flattened;`, add
`restored: number;` to its returned type beside `flattened: number;`, and
change its `return { buffer, applied, skipped, flattened, flattenedDetail }` to
`return { buffer, applied, skipped, flattened, flattenedDetail, restored }`.

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx tsx --test test/emphasisRestored.test.ts`
Expected: PASS, all five.

- [ ] **Step 6: Run everything**

Run: `cd backend && npm run build && npm test 2>&1 | grep -E "^.ℹ? ?(pass|fail)"`
Expected: `tsc` silent, `fail 0`. The existing
`backend/test/formattedTranslation.test.ts` still passes: its fixture's
paragraphs get no `segments`, so they take the fallback path unchanged.

- [ ] **Step 7: Commit**

```bash
git add backend/src/docxSurgery.ts backend/test/emphasisRestored.test.ts
git commit -m "feat(translate): the emphasised words go into the author's own italic run"
```

---

### Task 5: Say only what could not be restored

**Files:**
- Modify: `backend/src/routes.ts` (the surgical export headers)
- Modify: `frontend/src/api.ts` (`SurgicalReport`)
- Modify: `frontend/src/exportWarningCopy.ts`
- Modify: `frontend/src/i18n.ts`
- Test: `backend/test/exportWarningCopy.test.ts`

**Interfaces:**
- Consumes: `rewriteDocxText(...).flattenedDetail` (Task 4).
- Produces: header `X-Bethaniel-Lost-Phrases`; `SurgicalReport.lostPhrases: number`.

- [ ] **Step 1: Count phrases, not paragraphs, in the header**

In `backend/src/routes.ts`, find in the `/export/docx-surgical` handler:

```ts
    const { buffer, applied, skipped, flattened } = await rewriteDocxText(
      original.value.buffer,
      edits,
    );
```

Replace with:

```ts
    const { buffer, applied, skipped, flattened, flattenedDetail } =
      await rewriteDocxText(original.value.buffer, edits);
    // Phrases, not paragraphs: one paragraph can hold two italic phrases, and
    // "2 paragraphs" would understate what the author has to put back.
    const lostPhrases = flattenedDetail.reduce(
      (n, f) => n + f.emphasised.length,
      0,
    );
```

Then find:

```ts
    res.setHeader("X-Bethaniel-Flattened", String(flattened));
```

and add beneath it:

```ts
    res.setHeader("X-Bethaniel-Lost-Phrases", String(lostPhrases));
```

- [ ] **Step 2: Read it on the client**

In `frontend/src/api.ts`, find:

```ts
      flattened: Number(res.headers.get("X-Bethaniel-Flattened") ?? 0),
```

and add beneath it:

```ts
      lostPhrases: Number(res.headers.get("X-Bethaniel-Lost-Phrases") ?? 0),
```

In the same file, inside `export interface SurgicalReport`, after the
`flattened` field, add:

```ts
  /** Emphasised phrases that could not be placed. Counted in phrases because
   *  one paragraph can hold two, and the author has to restore each. */
  lostPhrases: number;
```

- [ ] **Step 3: Write the failing copy test**

Append to `backend/test/exportWarningCopy.test.ts`:

```ts
// ── After restoration, the warning counts what is still lost ──
//
// Emphasis is now put back into the author's own italic run wherever the
// translation's shape agrees with the paragraph's runs — about 108 of 109 on
// the manuscript this was built for. So the warning is no longer "112
// paragraphs lost emphasis" but the handful that could not be placed, counted
// in PHRASES because one paragraph can hold two.

test("a translation with nothing lost warns about nothing", () => {
  assert.equal(
    exportWarningFor({ skipped: 0, flattened: 0, isTranslation: true }),
    null,
  );
});

test("a translation reports the phrases it could not place", () => {
  const v = exportWarningFor({ skipped: 0, flattened: 2, isTranslation: true });
  assert.deepEqual(v?.parts, [{ key: "surgical_flattened", count: 2 }]);
  assert.equal(v?.showUnapplied, false);
});
```

- [ ] **Step 4: Change the copy to the agreed wording**

In `frontend/src/i18n.ts`, replace the whole `surgical_flattened` entry with:

```ts
  surgical_flattened: {
    en: "{count} emphasised phrase(s) could not be placed in the translation without ambiguity. The formatting notes say where they were.",
    da: "{count} fremhævede udtryk kunne ikke placeres i oversættelsen uden tvetydighed. Formateringsnoterne viser, hvor de var.",
    de: "{count} hervorgehobene Stelle(n) ließen sich in der Übersetzung nicht eindeutig platzieren. Die Formatierungsnotizen zeigen, wo sie waren.",
    es: "{count} frase(s) resaltada(s) no se pudieron colocar en la traducción sin ambigüedad. Las notas de formato indican dónde estaban.",
  },
```

- [ ] **Step 5: Pass the phrase count to the warning**

In `frontend/src/components/ReviewExport.tsx`, find:

```ts
        const warning = exportWarningFor({
          skipped: report.skipped,
          flattened: report.flattened,
          isTranslation,
        });
```

Replace with:

```ts
        const warning = exportWarningFor({
          skipped: report.skipped,
          // Phrases, not paragraphs: the copy counts what the author has to
          // put back, and one paragraph can hold two.
          flattened: report.lostPhrases,
          isTranslation,
        });
```

- [ ] **Step 6: Run everything**

Run:
```bash
cd backend && npm run build && npm test 2>&1 | grep -E "^.ℹ? ?(pass|fail)"
cd ../frontend && npm run build
```
Expected: `fail 0`; the frontend builds.

- [ ] **Step 7: Check the sidecar shrank, without changing it**

`/export/formatting-notes` builds its list from `flattenedDetail`, which as of
Task 4 holds only paragraphs whose emphasis could NOT be placed. So the
sidecar goes from ~109 entries to a handful with no change to
`formattingNotes.ts` — that is intended, not a coincidence, and it turns the
notes from a long list of things that are now fine into a short list of real
problems.

Confirm with the measurement script from Task 6 Step 1: the `still lost` count
is exactly how many entries the sidecar will hold.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes.ts frontend/src/api.ts frontend/src/i18n.ts frontend/src/components/ReviewExport.tsx backend/test/exportWarningCopy.test.ts
git commit -m "fix(translate): the warning counts phrases that could not be placed"
```

---

### Task 6: Measure it on the real manuscript, and document

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Measure before claiming anything**

The manuscript this was built for is on this machine, with its translation
already stored. Write this to `backend/measure.ts`, run it, then delete it.

```ts
import Database from "better-sqlite3";
import JSZip from "jszip";
import { loadOriginalDocx } from "./src/docxOriginal.js";
import { docxToMarkdownMapped } from "./src/conversion.js";
import { indexDocumentXml, rewriteDocxText } from "./src/docxSurgery.js";
import { remapChaptersToParagraphEdits } from "./src/docxRemap.js";

const DOC = "bad94714-dc29-4bde-937e-0bcbd893db4d";
const db = new Database(process.env.DATA_DIR + "/bethaniel.db", { readonly: true });
const all = db.prepare("SELECT state FROM tasks").all()
  .map((r: any) => JSON.parse(r.state))
  .filter((t: any) => t.mode === "translate" && t.result?.originalText);
const jobId = all.sort((a: any, b: any) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0].jobId;
const chapters = all
  .filter((t: any) => t.jobId === jobId)
  .sort((a: any, b: any) => (a.unitIndex ?? 0) - (b.unitIndex ?? 0))
  .map((t: any) => ({ original: t.result.originalText, edited: t.result.editedText }));

const orig = await loadOriginalDocx(DOC);
if (!orig.ok) throw new Error(orig.reason);
const index = indexDocumentXml(
  await (await JSZip.loadAsync(orig.value.buffer)).file("word/document.xml")!.async("string"),
);
const fresh = await docxToMarkdownMapped(orig.value.buffer, { docId: DOC });
const { edits } = remapChaptersToParagraphEdits(fresh.md, fresh.paragraphMap, index, chapters);
const { restored, flattened, flattenedDetail } = await rewriteDocxText(orig.value.buffer, edits);
const phrases = flattenedDetail.reduce((n, f) => n + f.emphasised.length, 0);
console.log(`restored ${restored} paragraphs | still lost ${flattened} paragraphs / ${phrases} phrases`);
```

Run: `cd backend && DATA_DIR="$HOME/Library/Application Support/Bethaniel/data" npx tsx measure.ts`
Expected: roughly `restored 108 | still lost 1`. A restored count near zero
means the allocation is never matching — stop and find out why before going on.

Then: `rm backend/measure.ts`

- [ ] **Step 2: Open the result in Word**

The one thing no test can assert is that the italics landed on the right
French words. Export the manuscript from the app, open it, and check three of
the restored paragraphs against the original.

- [ ] **Step 3: Document it**

In `CLAUDE.md`, in the "Betty in the Cloud" section, beside the existing
translation notes, add:

```markdown
- **A translation keeps its emphasis.** The model preserves the Markdown
  emphasis markers it is given and wraps the TARGET language's words in them
  (measured: 264 of 265 paragraphs on a real French translation). A flattened
  paragraph already holds the runs those belong in — that is why it is
  flattened — so `emphasisSpans.ts` folds the runs into segments, splits the
  translated Markdown into pieces, and distributes one to each when the shapes
  agree in count and order. The emphasised text lands in the author's own
  italic run, keeping their font and size, and no XML is created. When the
  shapes disagree the paragraph is flattened exactly as before and the count
  is reported in phrases — a loose match would italicise the wrong words,
  which is worse than losing the emphasis.
```

- [ ] **Step 4: Full verification**

Run:
```bash
cd backend && npm run build && npm test 2>&1 | grep -E "^.ℹ? ?(pass|fail)"
cd ../frontend && npm run build
cd ../electron && npx tsc -p tsconfig.json --noEmit
```
Expected: `fail 0`; both builds silent.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(translate): how a translation's emphasis is put back"
```

---

## Verification checklist

- [ ] `cd backend && npm test` — `fail 0`
- [ ] `cd backend && npm run build` — silent
- [ ] `cd frontend && npm run build` — silent
- [ ] Measured on the real manuscript: restored ≈ 108, still lost ≈ 1
- [ ] A restored paragraph opened in Word has its italics on the right French words
- [ ] A mismatched allocation falls back rather than half-applying
- [ ] An ordinary correction is unaffected
- [ ] The warning counts phrases, not paragraphs
- [ ] No `fr` added to any i18n entry
