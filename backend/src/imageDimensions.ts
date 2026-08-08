// ── Image pixel dimensions, from header bytes only ──
//
// The `docx` library needs an explicit width and height for every embedded
// image. That is what `image-size` provided when html-to-docx did the embedding.
//
// This reader covers exactly the formats we extract from .docx uploads (see
// extFromContentType in conversion.ts): PNG, JPEG, GIF and WEBP. It deliberately
// does NOT implement ICNS, JXL or HEIF. The two advisories that kept CI red —
// GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq — are unbounded loops in exactly
// those parsers. Declining to implement them is the fix, not an omission.
//
// Every scan here is bounded by the buffer length, and every failure returns
// null so the caller can fall back rather than throw mid-export.

export interface ImageDimensions {
  width: number;
  height: number;
}

function ok(width: number, height: number): ImageDimensions | null {
  // A zero or negative dimension would produce an invalid ImageRun.
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readPng(buf: Buffer): ImageDimensions | null {
  // 8-byte signature, then a 4-byte length, "IHDR", width, height.
  if (buf.length < 24) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
}

function readGif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
}

function readWebp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    // Canvas size is stored minus one, 24-bit little-endian.
    return ok(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
  }
  if (chunk === "VP8 ") {
    // Lossy: 14-bit dimensions after the 3-byte start code.
    if (buf.length < 30) return null;
    return ok(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (buf.length < 25) return null;
    const bits = buf.readUInt32LE(21);
    return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

function readJpeg(buf: Buffer): ImageDimensions | null {
  // Walk the marker segments looking for a start-of-frame. The loop is bounded
  // by the buffer length and every step advances, so a malformed file
  // terminates rather than spinning — the failure mode the advisories describe.
  let offset = 2; // past SOI
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null; // not a marker: give up
    const marker = buf[offset + 1];
    // SOF0..SOF15, excluding the non-frame markers DHT (c4), JPG (c8), DAC (cc).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return ok(buf.readUInt16BE(offset + 7), buf.readUInt16BE(offset + 5));
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    // A length below 2 would not advance the cursor; refuse rather than loop.
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * Pixel dimensions from an image's header, or null when the format is
 * unsupported, the header is truncated, or the declared size is unusable.
 */
export function readImageDimensions(buf: Buffer): ImageDimensions | null {
  try {
    if (buf.length < 10) return null;

    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return readPng(buf);
    }
    if (buf.toString("ascii", 0, 3) === "GIF") return readGif(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return readJpeg(buf);
    if (
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP"
    ) {
      return readWebp(buf);
    }
    // Anything else — ICNS, JXL, HEIF, TIFF, SVG — is not parsed here.
    return null;
  } catch {
    // Truncated buffers make the readUInt* calls throw; that is a "don't know",
    // not an error worth failing an export over.
    return null;
  }
}
