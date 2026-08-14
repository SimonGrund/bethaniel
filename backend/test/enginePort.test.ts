// Choosing the port llama-server listens on.
//
// Dev has no LLAMA_PORT env, so it falls back to a fixed 8012 — the one
// configuration where an engine left over from a previous session collides.
// The old behaviour was to launch anyway and let the bind fail, which the user
// then saw as "Model engine crashed (exit 1)".

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "net";

import { resolveEnginePort } from "../src/enginePort.ts";

const HOST = "127.0.0.1";

/** Hold a port for the duration of a callback. */
async function holding<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, HOST, r));
  const { port } = srv.address() as net.AddressInfo;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

test("a free port is used as-is", async () => {
  const port = await holding(async (p) => p); // released again, so known free
  const chosen = await resolveEnginePort({
    host: HOST,
    preferred: port,
    movable: true,
    waitMs: 500,
  });
  assert.equal(chosen.port, port);
  assert.equal(chosen.moved, false);
});

test("dev moves off a held port instead of failing to bind", async () => {
  await holding(async (busy) => {
    const chosen = await resolveEnginePort({
      host: HOST,
      preferred: busy,
      movable: true,
      waitMs: 300,
    });
    assert.notEqual(chosen.port, busy, "should not hand over the busy port");
    assert.equal(chosen.moved, true);

    // The port it picked must actually be usable.
    const probe = net.createServer();
    await new Promise<void>((res, rej) => {
      probe.once("error", rej);
      probe.listen(chosen.port, HOST, res);
    });
    await new Promise<void>((r) => probe.close(() => r()));
  });
});

test("a packaged build refuses rather than silently moving", async () => {
  // Electron already hands the backend a free port. If that one is taken,
  // something is genuinely wrong and moving would hide it.
  await holding(async (busy) => {
    await assert.rejects(
      () =>
        resolveEnginePort({
          host: HOST,
          preferred: busy,
          movable: false,
          waitMs: 300,
        }),
      /already in use/i,
    );
  });
});

test("the refusal names the port so the message is actionable", async () => {
  await holding(async (busy) => {
    const err = await resolveEnginePort({
      host: HOST,
      preferred: busy,
      movable: false,
      waitMs: 300,
    }).catch((e: Error) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, new RegExp(String(busy)));
  });
});
