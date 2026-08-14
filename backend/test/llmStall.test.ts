// A stalled response used to hang a task forever.
//
// Observed live: both chapters sat at "writing up corrections" for 12+ minutes
// at 0% CPU while llama-server was healthy and answering fresh requests. The
// reviewer's fetch was still waiting on a response that was never coming,
// because nothing in the LLM path had a timeout.
//
// The watchdog is an IDLE timeout, not a total-duration cap: a long generation
// on slow local hardware is normal and must not be cut off. It fires only when
// the connection goes silent. These tests drive the exact composition both
// fetch sites use — stallWatchdog's signal and bump handed to parseSSE — over
// a real HTTP response, so the wiring is covered and not just the timer.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import type { AddressInfo } from "net";

import { stallWatchdog, parseSSE } from "../src/llm.ts";

/** A server whose streaming behaviour each test chooses. */
async function serve(
  handler: (res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((_req, res) => handler(res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

function sse(res: http.ServerResponse, content: string) {
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
  );
}

/** Consume a stream the way chatStream does. */
async function consume(url: string): Promise<string> {
  const watchdog = stallWatchdog();
  try {
    const res = await fetch(url, { signal: watchdog.signal });
    let out = "";
    for await (const tok of parseSSE(res, watchdog.signal, "test.gguf", watchdog.bump)) {
      out += tok;
    }
    return out;
  } finally {
    watchdog.done();
  }
}

test("a stream that goes silent is abandoned instead of hanging forever", async () => {
  process.env.LLM_STALL_TIMEOUT_MS = "700";
  const srv = await serve((res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    sse(res, "first ");
    // …and then nothing, ever. No end, no error — exactly the live symptom.
  });
  try {
    const started = Date.now();
    let out = "";
    await assert.rejects(
      async () => {
        out = await consume(srv.url);
      },
      /No response from the model engine|abort/i,
      "a silent stream must abort, not hang",
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `took ${elapsed}ms — the watchdog did not fire`);
    assert.equal(out, "", "the rejection should surface, not a partial result");
  } finally {
    srv.close();
    delete process.env.LLM_STALL_TIMEOUT_MS;
  }
});

test("a slow but alive stream is NOT cut off", async () => {
  // The watchdog must never punish slow hardware. Each chunk restarts the
  // clock, so a generation lasting well beyond the timeout still completes.
  process.env.LLM_STALL_TIMEOUT_MS = "500";
  const srv = await serve((res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let n = 0;
    const t = setInterval(() => {
      if (n >= 6) {
        clearInterval(t);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      sse(res, `tok${n} `);
      n++;
    }, 200); // inside the timeout each time; total run is 3× the timeout
  });
  try {
    const out = await consume(srv.url);
    assert.match(out, /tok0/);
    assert.match(out, /tok5/, "the whole stream should have arrived");
  } finally {
    srv.close();
    delete process.env.LLM_STALL_TIMEOUT_MS;
  }
});

test("the caller's own cancellation still works", async () => {
  process.env.LLM_STALL_TIMEOUT_MS = "60000";
  const caller = new AbortController();
  const watchdog = stallWatchdog(caller.signal);
  try {
    assert.equal(watchdog.signal.aborted, false);
    caller.abort(new Error("user cancelled"));
    assert.equal(
      watchdog.signal.aborted,
      true,
      "cancelling a run must still abort the request",
    );
  } finally {
    watchdog.done();
    delete process.env.LLM_STALL_TIMEOUT_MS;
  }
});

test("done() stops the clock so a finished request cannot abort later", async () => {
  process.env.LLM_STALL_TIMEOUT_MS = "200";
  const watchdog = stallWatchdog();
  watchdog.done();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    watchdog.signal.aborted,
    false,
    "a completed request must not fire its watchdog afterwards",
  );
  delete process.env.LLM_STALL_TIMEOUT_MS;
});
