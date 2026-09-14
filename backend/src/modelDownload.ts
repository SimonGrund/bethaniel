// ── A resumable, stall-proof file transfer ──
//
// What the model download needed and did not have. A read from the model
// host can stop returning bytes without the connection ever closing — a CDN
// hiccup, a laptop changing networks — and a plain `await reader.read()`
// then waits forever, which is how a download sat at 88% with nothing wrong
// on either end. And every way out (cancel, error) deleted the partial file,
// so 88% of 2.5 GB was thrown away by exactly the events that make an author
// want to keep it.
//
// So: one attempt per connection, a watchdog on every read, and a resume from
// the byte the file reached whenever an attempt ends without the file being
// complete. Pause is an abort that keeps the file; the next call resumes.
// The checksum follows the file — it runs over bytes as they are written and
// is rebuilt from disk whenever the two could have parted ways.
//
// Everything that touches the network or the clock is injectable, so this is
// tested against a local server that stalls on purpose.

import { promises as fs, createWriteStream, createReadStream } from "fs";
import { once } from "events";
import { createHash } from "crypto";

export interface TransferProgress {
  bytesDownloaded: number;
  totalBytes: number;
  status: string;
  abort: AbortController;
  /** Set by the caller before aborting to mean "keep the file". */
  paused?: boolean;
}

export interface TransferOptions {
  url: string;
  /** Where the bytes accumulate; renamed by the caller once complete. */
  partialPath: string;
  /** The size the catalogue promises, used until the server says otherwise. */
  expectedSize: number;
  progress: TransferProgress;
  /** Called after every chunk and on every state change. */
  onProgress: (extra?: Record<string, unknown>) => void;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  /** A read that brings nothing for this long is a dead connection. */
  stallMs?: number;
  maxResumes?: number;
  backoffMs?: (resume: number) => number;
}

export const DEFAULT_STALL_MS = 45_000;
export const DEFAULT_MAX_RESUMES = 6;
const defaultBackoff = (n: number) => Math.min(30_000, 2_000 * 2 ** (n - 1));

export class TransferPaused extends Error {
  constructor() {
    super("Download paused");
    this.name = "TransferPaused";
  }
}

/** Hash a file on disk; the byte count comes back with it. */
export async function hashFile(
  path: string,
): Promise<{ hash: ReturnType<typeof createHash>; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    });
    rs.on("end", () => resolve());
    rs.on("error", reject);
  });
  return { hash, bytes };
}

const sizeOf = (path: string) => fs.stat(path).then((st) => st.size).catch(() => 0);

/**
 * Fetch `url` into `partialPath`, resuming across stalls and drops, and
 * return the SHA-256 of the completed file.
 *
 * Throws TransferPaused when the caller paused (the file is kept), the abort
 * reason on cancel (the caller deletes), and the last error once resumes are
 * exhausted (the file is kept, for a later attempt).
 */
export async function transferWithResume(opts: TransferOptions): Promise<string> {
  const {
    url,
    partialPath,
    progress,
    onProgress,
    fetchImpl = fetch,
    stallMs = DEFAULT_STALL_MS,
    maxResumes = DEFAULT_MAX_RESUMES,
    backoffMs = defaultBackoff,
    log = () => {},
  } = opts;
  const outer = progress.abort;

  let hash = createHash("sha256");
  let hashedBytes = 0;
  let resumes = 0;

  const rehashIfNeeded = async () => {
    const size = await sizeOf(partialPath);
    progress.bytesDownloaded = size;
    if (size !== hashedBytes) {
      const h = await hashFile(partialPath);
      hash = h.hash;
      hashedBytes = h.bytes;
    }
  };

  // A resumed download hashes what is already on disk first.
  if ((await sizeOf(partialPath)) > 0) await rehashIfNeeded();

  while (true) {
    if (outer.signal.aborted) throw progress.paused ? new TransferPaused() : new Error("Download cancelled");
    const from = progress.bytesDownloaded;
    const headers: Record<string, string> = {};
    if (from > 0) headers["Range"] = `bytes=${from}-`;

    // The attempt's own controller: a stall aborts this connection and
    // nothing else, while the outer one (pause, cancel) aborts both.
    const attempt = new AbortController();
    const onOuterAbort = () => attempt.abort();
    outer.signal.addEventListener("abort", onOuterAbort, { once: true });

    let stalled = false;
    try {
      const response = await fetchImpl(url, { signal: attempt.signal, headers });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      // A host that ignores Range answers 200 with the whole file: start
      // the file over rather than append a second copy to the first.
      const resuming = from > 0 && response.status === 206;
      if (from > 0 && !resuming) {
        await fs.unlink(partialPath).catch(() => {});
        progress.bytesDownloaded = 0;
        hash = createHash("sha256");
        hashedBytes = 0;
      }
      const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
      if (contentLength > 0) {
        progress.totalBytes = resuming ? from + contentLength : contentLength;
      }

      const fileStream = createWriteStream(partialPath, { flags: resuming ? "a" : "w" });
      const reader = response.body.getReader();
      try {
        while (true) {
          // The watchdog.
          let timer: NodeJS.Timeout | undefined;
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                stalled = true;
                attempt.abort();
                reject(new Error("stalled"));
              }, stallMs);
            }),
          ]).finally(() => clearTimeout(timer));
          if (chunk.done) break;
          const value = chunk.value;
          // Backpressure: the disk sets the pace, not the network. Without
          // this a fast link and a slow drive queue gigabytes in memory.
          if (!fileStream.write(value)) await once(fileStream, "drain");
          hash.update(value);
          hashedBytes += value.byteLength;
          progress.bytesDownloaded += value.byteLength;
          onProgress();
        }
      } finally {
        reader.cancel().catch(() => {});
        fileStream.end();
        await new Promise<void>((resolve) => {
          fileStream.on("finish", () => resolve());
          fileStream.on("error", () => resolve());
        });
      }
      // The whole body arrived: done with attempts.
      outer.signal.removeEventListener("abort", onOuterAbort);
      break;
    } catch (err) {
      outer.signal.removeEventListener("abort", onOuterAbort);
      if (outer.signal.aborted) {
        await rehashIfNeeded();
        throw progress.paused ? new TransferPaused() : err;
      }
      // A definite refusal from the server is not worth retrying; a stall,
      // a reset, or a gateway error is.
      const message = err instanceof Error ? err.message : String(err);
      const refused = /^HTTP 4\d\d$/.test(message);
      if (refused || resumes >= maxResumes) {
        await rehashIfNeeded();
        throw err;
      }
      resumes++;
      await rehashIfNeeded();
      progress.status = "stalled";
      onProgress({ status: "stalled", resumes });
      log(
        `${stalled ? "Stalled" : "Dropped"} at ${Math.round((progress.bytesDownloaded / (progress.totalBytes || 1)) * 100)}% — resuming (${resumes}/${maxResumes}).`,
      );
      await new Promise((r) => setTimeout(r, backoffMs(resumes)));
      progress.status = "downloading";
    }
  }

  // The bytes on disk must be the bytes the checksum saw.
  await rehashIfNeeded();
  return hash.digest("hex");
}
