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

import { INTRODUCTORY_COMMA_RULES } from "../src/languageTool.ts";

test(
  "LanguageTool live: disabling intro-comma rules suppresses the introductory comma",
  { skip: enabled ? false : "set LT_LIVE_TEST=1 with a bundled LanguageTool to run" },
  async () => {
    await ensureLanguageToolRunning();
    try {
      const text = "Finally Bria remembered the way home.";
      const withRule = await checkText(text, { lang: "en", dialect: "american" });
      const suppressed = await checkText(text, {
        lang: "en",
        dialect: "american",
        disabledRules: INTRODUCTORY_COMMA_RULES,
      });
      assert.ok(
        withRule.some((c) => /Finally,/.test(c.corrected)),
        `baseline should propose the comma, got ${JSON.stringify(withRule)}`,
      );
      assert.ok(
        !suppressed.some((c) => /Finally,/.test(c.corrected)),
        `disabled rules must suppress the comma, got ${JSON.stringify(suppressed)}`,
      );
    } finally {
      await shutdownLanguageTool();
    }
  },
);

test(
  "LanguageTool live: French is checked in French, and clean French stays clean",
  { skip: enabled ? false : "set LT_LIVE_TEST=1 with a bundled LanguageTool to run" },
  async () => {
    await ensureLanguageToolRunning();
    try {
      // The deterministic layer is the whole argument for adding a language:
      // French has no comma directive in prompts.ts precisely because this
      // check carries it, the way German's does. If this test ever goes quiet,
      // that argument is gone with it.
      const errored =
        "Les toits était mouillés et la café refroidissait. Sa soeur lui a dit qu'elle ne dors jamais.";
      const cs = await checkText(errored, { lang: "fr" });
      const proposed = cs.map((c) => c.corrected).join(" | ");
      assert.ok(/étaient/.test(proposed), `plural agreement, got ${proposed}`);
      assert.ok(/le café/.test(proposed), `gender agreement, got ${proposed}`);
      assert.ok(/sœur/.test(proposed), `the oe ligature, got ${proposed}`);
      assert.ok(/ne dort/.test(proposed), `conjugation, got ${proposed}`);

      // Guillemets, and a space before the semicolon and the question mark:
      // French typographic convention, and NOT something to correct. The
      // rules that would are LanguageTool's TYPOGRAPHY category, which the
      // parser skips on purpose — this is the test that keeps it skipped.
      const clean = `Elle s'était levée avant l'aube, comme toujours. « Tu ne dors jamais »,
avait dit sa sœur. Peut-être qu'elle avait raison ; peut-être qu'il fallait s'arrêter.
Qui pouvait le dire ?`;
      const noise = await checkText(clean, { lang: "fr" });
      assert.deepEqual(noise, [], `clean French must raise nothing, got ${JSON.stringify(noise)}`);
    } finally {
      await shutdownLanguageTool();
    }
  },
);
