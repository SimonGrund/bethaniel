// Losing the port race must cost a retry, not the job.
//
// A pre-flight bind check cannot promise the port will still be free when the
// engine gets there: our probe has to release the socket before the child can
// take it. When something slips into that gap, llama-server dies with
//
//   couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 59051
//   exiting due to HTTP server error
//
// which reached the user as "Model engine did not become ready … (code 1)" and
// failed the whole run — with the model's name on it, though the model had
// nothing to do with it. The engine should simply start somewhere else.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { findStablePort } from "../src/enginePort.ts";

const HOST = "127.0.0.1";

test(
  "a lost bind race retries on another port instead of failing the load",
  { skip: process.platform === "win32" ? "shell-script stand-in is POSIX" : false },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-port-"));
    const attempts = path.join(dir, "attempts");
    const ports = path.join(dir, "ports");
    const modelsDir = path.join(dir, "models");
    fs.mkdirSync(modelsDir);
    fs.writeFileSync(path.join(modelsDir, "Fake-Betty.gguf"), "not a real model");

    // Stands in for llama-server: the first launch loses the port race exactly
    // the way the real one does, later launches serve /health.
    const fake = path.join(dir, "fake-llama-server.mjs");
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node
import * as fs from "fs";
import * as http from "http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const n = (fs.existsSync(${JSON.stringify(attempts)})
  ? Number(fs.readFileSync(${JSON.stringify(attempts)}, "utf-8"))
  : 0) + 1;
fs.writeFileSync(${JSON.stringify(attempts)}, String(n));
fs.appendFileSync(${JSON.stringify(ports)}, port + "\\n");
if (n === 1) {
  console.error("srv start: binding port with default address family");
  console.error("srv start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: " + port);
  console.error("srv llama_server: exiting due to HTTP server error");
  process.exit(1);
}
http
  .createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404).end("{}");
  })
  .listen(port, "127.0.0.1", () => console.log("main: server is listening on port " + port));
`,
    );
    fs.chmodSync(fake, 0o755);

    const preferred = await findStablePort(HOST, []);
    assert.ok(preferred);
    process.env.LLAMA_BIN = fake;
    process.env.MODELS_DIR = modelsDir;
    process.env.LLAMA_PORT = String(preferred);
    delete process.env.LLAMA_BASE_URL;

    const { ensureModelLoaded, getLlamaBaseUrl, shutdownLlamaServer } =
      await import("../src/llamaServer.ts");

    try {
      await ensureModelLoaded("Fake-Betty.gguf");

      const tried = fs
        .readFileSync(ports, "utf-8")
        .trim()
        .split("\n")
        .map(Number);
      assert.equal(tried.length, 2, "should have retried exactly once");
      assert.equal(tried[0], preferred, "first attempt uses the preferred port");
      assert.notEqual(tried[1], tried[0], "the retry must move to another port");

      // Everything that talks to the engine has to follow it to the new port.
      assert.equal(getLlamaBaseUrl(), `http://${HOST}:${tried[1]}`);
    } finally {
      await shutdownLlamaServer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
