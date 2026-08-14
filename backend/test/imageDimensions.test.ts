// The `docx` library needs explicit pixel dimensions for every embedded image.
// That is what `image-size` used to provide, via html-to-docx.
//
// This reader deliberately supports only the formats we actually extract from
// .docx uploads (see extFromContentType in conversion.ts): PNG, JPEG, GIF, WEBP.
// It does NOT implement ICNS, JXL or HEIF — the two advisories that kept CI red
// (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq) are infinite loops in exactly those
// parsers. Not implementing them is the point: unsupported input returns null and
// the caller falls back, rather than looping.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readImageDimensions } from "../src/imageDimensions.ts";

/** Minimal 1x1-style PNG: signature + IHDR carrying the given size. */
function png(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // chunk length
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([sig, ihdr]);
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(10);
  b.write("GIF89a", 0);
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/** JPEG: SOI, a skippable APP0, then an SOF0 frame carrying the size. */
function jpeg(width: number, height: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  // Length counts itself plus the payload, so 4 means two payload bytes follow.
  const app0 = Buffer.alloc(6);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(4, 2);
  parts.push(app0);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2); // length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

/** WEBP (VP8X form): RIFF container with 24-bit little-endian dims minus one. */
function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0);
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8);
  b.write("VP8X", 12);
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

test("reads PNG dimensions", () => {
  assert.deepEqual(readImageDimensions(png(640, 480)), {
    width: 640,
    height: 480,
  });
});

test("reads GIF dimensions", () => {
  assert.deepEqual(readImageDimensions(gif(120, 90)), {
    width: 120,
    height: 90,
  });
});

test("reads JPEG dimensions from the SOF frame", () => {
  assert.deepEqual(readImageDimensions(jpeg(800, 600)), {
    width: 800,
    height: 600,
  });
});

test("reads WEBP (VP8X) dimensions", () => {
  assert.deepEqual(readImageDimensions(webp(300, 200)), {
    width: 300,
    height: 200,
  });
});

test("unsupported formats return null rather than guessing", () => {
  // An ICNS header. We must not parse it — that parser is the CVE.
  const icns = Buffer.concat([
    Buffer.from("icns"),
    Buffer.alloc(60),
  ]);
  assert.equal(readImageDimensions(icns), null);
});

test("truncated and empty input returns null, never throws", () => {
  assert.equal(readImageDimensions(Buffer.alloc(0)), null);
  assert.equal(readImageDimensions(Buffer.from([0x89, 0x50])), null);
  // PNG signature but no IHDR payload.
  assert.equal(
    readImageDimensions(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
    null,
  );
});

test("a JPEG with no SOF frame terminates instead of scanning forever", () => {
  // Marker segments that never yield a frame header. The scan must be bounded
  // by the buffer, which is the property the advisories are about.
  const b = Buffer.alloc(64);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffe0, 2);
  b.writeUInt16BE(60, 4); // length running to the end
  assert.equal(readImageDimensions(b), null);
});

test("zero-sized declarations are rejected", () => {
  // A 0-width image would produce an invalid docx ImageRun.
  assert.equal(readImageDimensions(png(0, 100)), null);
  assert.equal(readImageDimensions(gif(50, 0)), null);
});
