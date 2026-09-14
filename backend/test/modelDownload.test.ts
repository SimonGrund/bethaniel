// ── The model download survives what the network does to it ──
//
// A local server plays the model host: it honours Range, and on command it
// stalls mid-body (the connection stays open and goes quiet — the 88% case),
// drops the connection, or ignores Range altogether. The transfer must come
// out the other side with the right bytes, and a pause must keep them.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { transferWithResume, TransferPaused } from "../src/modelDownload.ts";
import type { TransferProgress } from "../src/modelDownload.ts";

const FILE = Buffer.alloc(300_000);
for (let i = 0; i < FILE.length; i++) FILE[i] = (i * 31 + 7) & 0xff;
const FILE_SHA = createHash("sha256").update(FILE).digest("hex");

// Per-request script: what the server does after sending `after` bytes.
type Script = { after: number; then: "stall" | "drop" } | { ignoreRange: true } | null;
let scripts: Script[] = [];
let requests: string[] = [];

let server: http.Server;
let url: string;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bethaniel-dl-"));
const CHUNK = 10_000;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.endsWith("/missing.gguf")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const script = scripts.shift() ?? null;
    requests.push(req.headers.range ?? "full");
    let from = 0;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (range && !(script && "ignoreRange" in script)) {
      from = Number(range[1]);
      res.writeHead(206, {
        "content-length": String(FILE.length - from),
        "content-range": `bytes ${from}-${FILE.length - 1}/${FILE.length}`,
      });
    } else {
      res.writeHead(200, { "content-length": String(FILE.length) });
    }
    let sent = 0;
    const body = FILE.subarray(from);
    const tick = () => {
      if (script && "then" in script && sent >= script.after) {
        if (script.then === "drop") res.destroy();
        // "stall": say nothing more and keep the socket open.
        return;
      }
      if (sent >= body.length) {
        res.end();
        return;
      }
      res.write(body.subarray(sent, sent + CHUNK));
      sent += CHUNK;
      setImmediate(tick);
    };
    tick();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/model.gguf`;
});

after(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function progress(): TransferProgress {
  return { bytesDownloaded: 0, totalBytes: FILE.length, status: "downloading", abort: new AbortController() };
}

function run(partial: string, p: TransferProgress, extra: Partial<Parameters<typeof transferWithResume>[0]> = {}) {
  return transferWithResume({
    url,
    partialPath: partial,
    expectedSize: FILE.length,
    progress: p,
    onProgress: () => {},
    stallMs: 150,
    backoffMs: () => 10,
    ...extra,
  });
}

test("a clean transfer arrives whole with the right checksum", async () => {
  scripts = [null];
  requests = [];
  const partial = path.join(tmp, "clean.partial");
  const digest = await run(partial, progress());
  assert.equal(digest, FILE_SHA);
  assert.equal(fs.statSync(partial).size, FILE.length);
});

test("a stall mid-body is noticed and the transfer resumes from where it stopped", async () => {
  scripts = [{ after: 120_000, then: "stall" }, null];
  requests = [];
  const partial = path.join(tmp, "stall.partial");
  const p = progress();
  const states: string[] = [];
  const digest = await run(partial, p, { onProgress: (x) => x?.status && states.push(String(x.status)) });
  assert.equal(digest, FILE_SHA, "the bytes are right after a resume");
  assert.ok(states.includes("stalled"), "the stall was reported");
  assert.equal(requests.length, 2);
  assert.match(requests[1], /^bytes=\d+-$/, "the second request asked for the rest");
  assert.ok(Number(/\d+/.exec(requests[1])![0]) >= 120_000, "from at least where the stall hit");
});

test("a dropped connection resumes too, and a host that ignores Range starts over cleanly", async () => {
  scripts = [{ after: 50_000, then: "drop" }, { ignoreRange: true }];
  requests = [];
  const partial = path.join(tmp, "drop.partial");
  const digest = await run(partial, progress());
  assert.equal(digest, FILE_SHA, "no doubled bytes despite the 200 on resume");
  assert.equal(fs.statSync(partial).size, FILE.length);
});

test("resumes run out eventually, and what was fetched is kept", async () => {
  scripts = [{ after: 30_000, then: "drop" }, { after: 30_000, then: "drop" }, { after: 30_000, then: "drop" }];
  requests = [];
  const partial = path.join(tmp, "exhausted.partial");
  const p = progress();
  await assert.rejects(run(partial, p, { maxResumes: 2 }));
  assert.ok(fs.statSync(partial).size >= 30_000, "the partial file survives the failure");
  assert.equal(p.bytesDownloaded, fs.statSync(partial).size, "progress reflects the file, not the stream");
});

test("a pause keeps the file, and the next transfer resumes it to the same checksum", async () => {
  scripts = [{ after: 80_000, then: "stall" }, null];
  requests = [];
  const partial = path.join(tmp, "pause.partial");
  const p = progress();
  const running = run(partial, p);
  // Let it reach the stall, then pause during it.
  await new Promise((r) => setTimeout(r, 60));
  p.paused = true;
  p.abort.abort();
  await assert.rejects(running, TransferPaused);
  const kept = fs.statSync(partial).size;
  assert.ok(kept > 0 && kept < FILE.length, `paused with ${kept} bytes on disk`);

  // Resume: a fresh progress object, as a new /models/download would make.
  scripts = [null];
  const p2 = progress();
  p2.bytesDownloaded = kept;
  const digest = await run(partial, p2);
  assert.equal(digest, FILE_SHA);
  assert.match(requests[requests.length - 1], new RegExp(`^bytes=${kept}-$`), "resumed from the paused byte");
});

test("a cancel is not a pause: the transfer ends with the abort reason and no resume", async () => {
  scripts = [{ after: 40_000, then: "stall" }];
  requests = [];
  const partial = path.join(tmp, "cancel.partial");
  const p = progress();
  const running = run(partial, p);
  await new Promise((r) => setTimeout(r, 60));
  p.abort.abort();
  await assert.rejects(running, (err: unknown) => !(err instanceof TransferPaused));
  assert.equal(requests.length, 1, "no resume after a cancel");
});

test("a 404 is not retried", async () => {
  const dead = url.replace("/model.gguf", "/missing.gguf");
  scripts = [];
  requests = [];
  const p = progress();
  const partial = path.join(tmp, "missing.partial");
  await assert.rejects(run(partial, p, { url: dead }), /HTTP 404/);
});
