// Live end-to-end test for the LanguageTool integration: actually spawns the
// bundled Java server and runs a real /v2/check. Gated behind LT_LIVE_TEST so
// the normal `npm test` stays fast and hermetic (no Java process, no port).
//
// Run it with a LanguageTool distribution present in
// electron/resources/languagetool/ (or LANGUAGETOOL_JAR set):
//   LT_LIVE_TEST=1 npx tsx --test test/languageToolLive.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as net from "node:net";

import {
  isLanguageToolAvailable,
  ensureLanguageToolRunning,
  shutdownLanguageTool,
} from "../src/languageToolServer.ts";
import { checkText } from "../src/languageTool.ts";

/** Resolve once something is accepting connections on 127.0.0.1:port. */
function waitUntilBound(port: number, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => s.destroy(resolve()));
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error("port never bound"));
        else setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

const enabled = process.env.LT_LIVE_TEST === "1" && isLanguageToolAvailable();

test(
  "LanguageTool live: spawns the server and fixes a real grammar/typo error",
  { skip: enabled ? false : "set LT_LIVE_TEST=1 with a bundled LanguageTool to run" },
  async () => {
    await ensureLanguageToolRunning();
    try {
      const text =
        "She go to the store yesterday and she dont have any money.";
      const cs = await checkText(text, { lang: "en", dialect: "american" });
      // At minimum LanguageTool should fix the missing-apostrophe typo, anchored
      // with surrounding context so it applies unambiguously.
      const dont = cs.find((c) => /\bdon't\b/.test(c.corrected));
      assert.ok(dont, `expected a don't fix, got ${JSON.stringify(cs)}`);
      assert.ok(dont!.original.includes("dont"), "original keeps the misspelling in context");
      assert.ok((dont!.reason ?? "").startsWith("grammar"), "tagged as a grammar correction");
    } finally {
      await shutdownLanguageTool();
    }
  },
);

test(
  "LanguageTool live: reclaims a port held by an orphaned process and still starts",
  { skip: enabled ? false : "set LT_LIVE_TEST=1 with a bundled LanguageTool to run" },
  async () => {
    const port = Number(process.env.LANGUAGETOOL_PORT ?? 8081);
    // Squat on the port from a SEPARATE process (its own pid) to simulate an
    // orphaned LanguageTool left by an ungraceful backend exit.
    const squatter = spawn(
      process.execPath,
      ["-e", `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1e9)`],
      { detached: true, stdio: "ignore" },
    );
    squatter.unref();
    await waitUntilBound(port);
    try {
      // Without port reclaim this would die with "Address already in use".
      await ensureLanguageToolRunning();
      const cs = await checkText("she dont care at all", { lang: "en", dialect: "american" });
      assert.ok(
        cs.some((c) => /\bdon't\b/.test(c.corrected)),
        `expected a working server after reclaim, got ${JSON.stringify(cs)}`,
      );
    } finally {
      try {
        if (squatter.pid) process.kill(squatter.pid, "SIGKILL");
      } catch {}
      await shutdownLanguageTool();
    }
  },
);
