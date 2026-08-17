// Whoever speaks first owns the role.
//
// Every request was prefixed with "You are a meticulous copy editor and line
// editor." — before the task prompt, which assigns its own role. For a copy
// edit that is merely redundant. For the Final readthrough it is a straight
// contradiction: the task prompt says "proofreader… change as little as
// possible", the line above it says "copy editor", and the model does the job
// it was given first. Reported from live use on External Betty: the final
// readthrough behaved like a full copy edit.
//
// The same collision sits under translate, analysis and blurb, which are not
// editing tasks at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  BASE_SYSTEM_PROMPT,
  isLegacySystemPrompt,
} from "../src/modelCatalog.ts";
import { readModelConfig } from "../src/modelConfig.ts";
import {
  buildProofreadCorrectionsPrompt,
  buildTranslationPrompt,
} from "../src/prompts.ts";

/** The role a task prompt assigns must be the only role in the message. */
function systemMessage(taskPrompt: string): string {
  return [BASE_SYSTEM_PROMPT, taskPrompt].filter(Boolean).join("\n\n");
}

test("the shared prompt does not claim an editing role of its own", () => {
  assert.doesNotMatch(
    BASE_SYSTEM_PROMPT,
    /copy editor|line editor|proofreader/i,
    "the task prompt assigns the role; a second one only competes with it",
  );
});

test("a proofread task is never told it is a copy editor", () => {
  const msg = systemMessage(
    buildProofreadCorrectionsPrompt(undefined, undefined, "English"),
  );
  assert.match(msg, /proofreader/i, "the proofreader role must survive");
  assert.doesNotMatch(
    msg,
    /You are a meticulous copy editor/i,
    "the copy-editor role must not be asserted over it",
  );
});

test("a translation task is not told it is an editor", () => {
  const msg = systemMessage(buildTranslationPrompt("Danish", undefined));
  assert.match(msg, /translator/i);
  assert.doesNotMatch(msg, /You are a meticulous copy editor/i);
});

test("/no_think survives — it is why the shared prompt exists", () => {
  assert.match(BASE_SYSTEM_PROMPT, /\/no_think/);
});

// ── Sidecars ──
//
// A saved per-model config stores `system` verbatim, so every install that ever
// opened advanced settings has the old wording pinned to disk. Changing the
// catalogue alone would fix External Betty (which reads the catalogue directly)
// and leave every local model behaving exactly as before.

test("a sidecar holding a stale copy of our own default is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bethaniel-sidecar-"));
  try {
    const file = "Qwen3.5-4B-Q4_K_M.gguf";
    fs.writeFileSync(
      path.join(dir, "Qwen3.5-4B-Q4_K_M.json"),
      JSON.stringify({
        temperature: 0.2,
        system: "You are a meticulous copy editor and line editor. /no_think",
      }),
    );
    const cfg = readModelConfig(dir, file);
    assert.equal(
      cfg.system,
      BASE_SYSTEM_PROMPT,
      "a pinned copy of a former default must not outlive it",
    );
    assert.equal(cfg.temperature, 0.2, "real user settings must be kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a genuinely customised system prompt is still honoured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bethaniel-sidecar2-"));
  try {
    const mine = "You are my own editor with my own rules.";
    fs.writeFileSync(
      path.join(dir, "Qwen3.5-4B-Q4_K_M.json"),
      JSON.stringify({ system: mine }),
    );
    assert.equal(readModelConfig(dir, "Qwen3.5-4B-Q4_K_M.gguf").system, mine);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy detection is exact, not a guess at intent", () => {
  assert.equal(
    isLegacySystemPrompt(
      "You are a meticulous copy editor and line editor. /no_think",
    ),
    true,
  );
  assert.equal(isLegacySystemPrompt("You are my own editor."), false);
  assert.equal(isLegacySystemPrompt(undefined), false);
});
