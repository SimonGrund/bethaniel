// An image's DISPLAY size is a choice the author made, and it lives in the
// document, not in the image file. A 2000px photo scaled down to two inches in
// Word is still a 2000px file on disk.
//
// Import extracted the file and discarded the display size, so export fell back
// to the intrinsic pixel count and the picture came back far larger than the
// author had set it. Reported from live use: "images are resized to larger".

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";
import { Document, Packer, Paragraph, ImageRun, TextRun } from "docx";

import {
  docxToMarkdown,
  markdownToDocx,
  MEDIA_DIR,
  DEFAULT_DOCX_EXPORT_OPTIONS,
} from "../src/conversion.ts";

/** A valid PNG of the given pixel dimensions (1x1 scaled by the IHDR header). */
function png(width: number, height: number): Buffer {
  // A real, decodable PNG: solid colour, correct CRCs, arbitrary dimensions is
  // overkill — Word only needs the bytes intact, and our reader only needs IHDR.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrBody = Buffer.alloc(17);
  ihdrBody.write("IHDR", 0);
  ihdrBody.writeUInt32BE(width, 4);
  ihdrBody.writeUInt32BE(height, 8);
  ihdrBody[12] = 8; // bit depth
  ihdrBody[13] = 6; // colour type RGBA
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  const crc = Buffer.alloc(4); // not validated by our reader or by Word's unzip
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]);
  return Buffer.concat([sig, len, ihdrBody, crc, iend]);
}

const EMU_PER_INCH = 914400;
const EMU_PER_PX = 9525; // 96 dpi, which is what `docx` transformation units are

/** A .docx holding one big image displayed small — the shape of the bug. */
async function sourceDocx(displayPx: { width: number; height: number }) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun("Before.")] }),
          new Paragraph({
            children: [
              new ImageRun({
                type: "png",
                data: png(2000, 1500),
                transformation: displayPx,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("After.")] }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function extentsOf(buf: Buffer): Promise<Array<{ cx: number; cy: number }>> {
  const zip = await JSZip.loadAsync(buf);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  return [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => ({
    cx: Number(m[1]),
    cy: Number(m[2]),
  }));
}

const DOC_SCALED = "test-imgsize-scaled";
const DOC_BARE = "test-imgsize-bare";

test("a downscaled image keeps its display size through import and export", async (t) => {
  t.after(() =>
    fs.rmSync(path.join(MEDIA_DIR, DOC_SCALED), { recursive: true, force: true }),
  );

  // Two inches wide — the author's choice, far below the 2000px intrinsic size.
  const displayPx = { width: 192, height: 144 };
  const input = await sourceDocx(displayPx);

  const before = await extentsOf(input);
  assert.equal(before.length, 1, "fixture should carry exactly one image");
  assert.equal(before[0].cx, displayPx.width * EMU_PER_PX);

  const md = await docxToMarkdown(input, { docId: DOC_SCALED });
  assert.match(md, /!\[/, "the image reference should survive import");

  const output = await markdownToDocx(md, DEFAULT_DOCX_EXPORT_OPTIONS);
  const after = await extentsOf(output);
  assert.equal(after.length, 1, "the image should survive export");

  const beforeInches = before[0].cx / EMU_PER_INCH;
  const afterInches = after[0].cx / EMU_PER_INCH;
  assert.ok(
    Math.abs(afterInches - beforeInches) < 0.02,
    `image grew from ${beforeInches.toFixed(2)}in to ${afterInches.toFixed(2)}in`,
  );
});

test("an image with no recorded display size still exports at a sane width", async (t) => {
  // Documents imported before display sizes were kept, and .md uploads, have no
  // recorded size. Those must still come out bounded, not at full pixel size.
  t.after(() =>
    fs.rmSync(path.join(MEDIA_DIR, DOC_BARE), { recursive: true, force: true }),
  );

  const mediaDir = path.join(MEDIA_DIR, DOC_BARE);
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "image1.png"), png(2000, 1500));

  const output = await markdownToDocx(
    `Text.\n\n![](media/${DOC_BARE}/image1.png)\n`,
    DEFAULT_DOCX_EXPORT_OPTIONS,
  );
  const [extent] = await extentsOf(output);
  assert.ok(extent, "image should be present");
  const inches = extent.cx / EMU_PER_INCH;
  assert.ok(
    inches > 0 && inches <= 6.5,
    `unbounded image width: ${inches.toFixed(2)}in`,
  );
});
