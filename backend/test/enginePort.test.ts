// Choosing the port llama-server listens on.
//
// The engine port must be one we can still bind *when the engine actually
// starts*, which may be many minutes after the app launched. A port taken from
// the OS ephemeral range (49152+ on macOS/Windows, 32768+ on Linux) cannot
// carry that promise: the kernel hands those out, in sequence, to every
// outbound connection and every listen(0) on the machine — including the app's
// own loopback traffic, which cycles the counter right back around during a
// long job. Reserving one by binding and closing reserves nothing.
//
// That is what produced "couldn't bind HTTP server socket ... port 59051" →
// "Model engine crashed (exit 1)", pointing the user at their model when the
// model was never involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "net";

import {
  resolveEnginePort,
  findStablePort,
  isStablePort,
  isPortBindFailure,
  EPHEMERAL_FLOOR,
} from "../src/enginePort.ts";

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

/** Prove a port can really be listened on. */
async function assertBindable(port: number): Promise<void> {
  const probe = net.createServer();
  await new Promise<void>((res, rej) => {
    probe.once("error", rej);
    probe.listen(port, HOST, res);
  });
  await new Promise<void>((r) => probe.close(() => r()));
}

test("a free port outside the ephemeral range is used as-is", async () => {
  const stable = await findStablePort(HOST, []);
  assert.ok(stable, "the machine should have a free stable port");
  const chosen = await resolveEnginePort({
    host: HOST,
    preferred: stable!,
    waitMs: 500,
  });
  assert.equal(chosen.port, stable);
  assert.equal(chosen.moved, false);
});

test("a held port is stepped around instead of launched into", async () => {
  await holding(async (busy) => {
    const chosen = await resolveEnginePort({
      host: HOST,
      preferred: busy,
      waitMs: 300,
    });
    assert.notEqual(chosen.port, busy, "should not hand over the busy port");
    assert.equal(chosen.moved, true);
    await assertBindable(chosen.port);
  });
});

test("an ephemeral-range port is refused even while it is still bindable", async () => {
  // The exact shape of the crash: the port bound fine when we checked, and was
  // gone by the time llama-server got there. Checking harder cannot fix that —
  // only leaving the range the kernel allocates from can.
  const ephemeral = await holding(async (p) => p); // released again, so free
  assert.ok(ephemeral >= EPHEMERAL_FLOOR, "sanity: listen(0) is ephemeral");

  const chosen = await resolveEnginePort({
    host: HOST,
    preferred: ephemeral,
    waitMs: 300,
  });
  assert.ok(
    isStablePort(chosen.port),
    `chose ${chosen.port}, which the OS can still hand to another process`,
  );
  assert.equal(chosen.moved, true);
  await assertBindable(chosen.port);
});

test("every offered port sits below every platform's ephemeral floor", async () => {
  const port = await findStablePort(HOST, []);
  assert.ok(port !== null);
  assert.ok(port! >= 1024 && port! < EPHEMERAL_FLOOR);
  assert.equal(isStablePort(port!), true);
  await assertBindable(port!);
});

test("a port that already lost the bind race is not offered again", async () => {
  const first = await findStablePort(HOST, []);
  assert.ok(first);
  const second = await findStablePort(HOST, [first!]);
  assert.ok(second);
  assert.notEqual(second, first);

  const chosen = await resolveEnginePort({
    host: HOST,
    preferred: first!,
    waitMs: 300,
    avoid: [first!],
  });
  assert.notEqual(chosen.port, first, "the failed port must not come back");
  await assertBindable(chosen.port);
});

test("llama-server's bind failure is recognised from its own output", () => {
  // Verbatim from a crash report on macOS.
  const tail = [
    "0.00.083.999 I srv         start: binding port with default address family",
    "0.00.084.097 E srv         start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 59051",
    "0.00.084.100 I srv    operator(): operator(): cleaning up before exit...",
    "0.00.084.106 E srv  llama_server: exiting due to HTTP server error",
  ].join("\n");
  assert.equal(isPortBindFailure(tail), true);
});

test("an unrelated engine death is not mistaken for a bind failure", () => {
  const oom = [
    "llama_model_load: error loading model: unable to allocate backend buffer",
    "common_init_from_params: failed to load model",
  ].join("\n");
  assert.equal(isPortBindFailure(oom), false);
  assert.equal(isPortBindFailure(""), false);
});
