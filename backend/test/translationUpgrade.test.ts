// Tests for the translation upgrade stage: structural guards and the
// upgrade → fluency-review → re-polish orchestrator with injected deps.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitIntoParas,
  upgradeGuard,
} from "../src/translationUpgrade.ts";

const DRAFT =
  "Para one draft sentence.\n\nPara two draft sentence.\n\nPara three draft sentence.";
const POLISHED =
  "Para one polished sentence.\n\nPara two polished sentence.\n\nPara three polished sentence.";

test("splitIntoParas: splits on blank lines, trims, drops empties", () => {
  assert.deepEqual(splitIntoParas("a\n\n  b  \n\n\n\nc\n"), ["a", "b", "c"]);
  assert.deepEqual(splitIntoParas("   "), []);
});

test("upgradeGuard: accepts same paragraph count and sane length", () => {
  assert.deepEqual(upgradeGuard(DRAFT, POLISHED), { ok: true });
});

test("upgradeGuard: rejects empty output", () => {
  const r = upgradeGuard(DRAFT, "   ");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /empty/i);
});

test("upgradeGuard: rejects paragraph count mismatch", () => {
  const r = upgradeGuard(DRAFT, "Merged into one paragraph.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /paragraph count/i);
});

test("upgradeGuard: rejects output shorter than 60% of draft", () => {
  const r = upgradeGuard(DRAFT, "a.\n\nb.\n\nc.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /too short/i);
});

import {
  buildTranslationUpgradePrompt,
  buildFluencyReviewerPrompt,
} from "../src/prompts.ts";

test("buildTranslationUpgradePrompt: names target language, forbids meaning/paragraph changes", () => {
  const p = buildTranslationUpgradePrompt("Danish");
  assert.match(p, /native Danish line editor/i);
  assert.match(p, /Do NOT add, drop, or alter any meaning/);
  assert.match(p, /Do NOT merge, split, add, or remove paragraphs/);
  assert.doesNotMatch(p, /BINDING GLOSSARY/);
});

test("buildTranslationUpgradePrompt: includes binding glossary when style guide given", () => {
  const p = buildTranslationUpgradePrompt("Danish", "Betty → Betty (never translate)");
  assert.match(p, /BINDING GLOSSARY/);
  assert.match(p, /never translate/);
});

test("buildFluencyReviewerPrompt: JSONL contract and drift flagging", () => {
  const p = buildFluencyReviewerPrompt("Danish");
  assert.match(p, /"index": 0, "confidence": 5/);
  assert.match(p, /STRICT JSONL/);
  assert.match(p, /Meaning added, dropped, or altered/);
  assert.doesNotMatch(p, /BINDING GLOSSARY/);
});

test("buildFluencyReviewerPrompt: glossary violations become defects when style guide given", () => {
  const p = buildFluencyReviewerPrompt("Danish", "Betty → Betty (never translate)");
  assert.match(p, /BINDING GLOSSARY/);
  assert.match(p, /VIOLATION/);
});

import {
  runTranslationUpgrade,
  type UpgradeDeps,
  type UpgradeOptions,
} from "../src/translationUpgrade.ts";

function mkOpts(overrides: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    draft: DRAFT,
    upgradePrompt: "UPGRADE-PROMPT",
    reviewMode: false,
    reviewerCount: 1,
    reviewerThreshold: 3,
    chunkLabel: "1/1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function mkDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    editStream: async () => POLISHED,
    runReviewer: async () => "",
    parseScores: () => new Map(),
    log: () => {},
    setPhase: () => {},
    ...overrides,
  };
}

test("orchestrator: without reviewMode returns the polished text", async () => {
  const out = await runTranslationUpgrade(mkOpts(), mkDeps());
  assert.equal(out, POLISHED);
});

test("orchestrator: guard rejection falls back to the draft", async () => {
  const out = await runTranslationUpgrade(
    mkOpts(),
    mkDeps({ editStream: async () => "Everything merged into one paragraph." }),
  );
  assert.equal(out, DRAFT);
});

test("orchestrator: upgrade pass throwing falls back to the draft", async () => {
  const out = await runTranslationUpgrade(
    mkOpts(),
    mkDeps({
      editStream: async () => {
        throw new Error("slot exhausted");
      },
    }),
  );
  assert.equal(out, DRAFT);
});

test("orchestrator: abort re-throws instead of falling back", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    runTranslationUpgrade(
      mkOpts({ signal: ctl.signal }),
      mkDeps({
        editStream: async () => {
          throw new Error("aborted");
        },
      }),
    ),
    /aborted/,
  );
});

test("orchestrator: reviewMode with no flags returns polished text", async () => {
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      runReviewer: async () => "scores",
      parseScores: () =>
        new Map([
          [0, { confidence: 5, reason: "" }],
          [1, { confidence: 4, reason: "" }],
          [2, { confidence: 5, reason: "" }],
        ]),
    }),
  );
  assert.equal(out, POLISHED);
});

test("orchestrator: flagged paragraph is re-polished from the DRAFT paragraph", async () => {
  const editCalls: { text: string; prompt: string }[] = [];
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      editStream: async (text, prompt) => {
        editCalls.push({ text, prompt });
        return editCalls.length === 1 ? POLISHED : "Para two re-polished sentence.";
      },
      runReviewer: async () => "scores",
      parseScores: () => new Map([[1, { confidence: 2, reason: "stiff phrasing" }]]),
    }),
  );
  assert.equal(
    out,
    "Para one polished sentence.\n\nPara two re-polished sentence.\n\nPara three polished sentence.",
  );
  assert.equal(editCalls.length, 2);
  assert.equal(editCalls[1].text, "Para two draft sentence.");
  assert.match(editCalls[1].prompt, /CRITICAL/);
  assert.match(editCalls[1].prompt, /stiff phrasing/);
});

test("orchestrator: empty re-polish keeps the DRAFT paragraph", async () => {
  let calls = 0;
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      editStream: async () => (++calls === 1 ? POLISHED : "   "),
      runReviewer: async () => "scores",
      parseScores: () => new Map([[1, { confidence: 1, reason: "garbled" }]]),
    }),
  );
  assert.equal(
    out,
    "Para one polished sentence.\n\nPara two draft sentence.\n\nPara three polished sentence.",
  );
});

test("orchestrator: re-polish throwing keeps the DRAFT paragraph", async () => {
  let calls = 0;
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      editStream: async () => {
        if (++calls === 1) return POLISHED;
        throw new Error("boom");
      },
      runReviewer: async () => "scores",
      parseScores: () => new Map([[0, { confidence: 1, reason: "garbled" }]]),
    }),
  );
  assert.equal(
    out,
    "Para one draft sentence.\n\nPara two polished sentence.\n\nPara three polished sentence.",
  );
});

test("orchestrator: all reviewers failing accepts the polish unreviewed", async () => {
  const warnings: string[] = [];
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true, reviewerCount: 2 }),
    mkDeps({
      runReviewer: async () => {
        throw new Error("reviewer died");
      },
      log: (level, msg) => {
        if (level === "warn") warnings.push(msg);
      },
    }),
  );
  assert.equal(out, POLISHED);
  assert.ok(warnings.some((w) => /fluency/i.test(w)));
});

test("orchestrator: unparsable reviewer output accepts the polish as-is", async () => {
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      runReviewer: async () => "<think>hmm</think> not json at all",
      parseScores: () => new Map(), // parseReviewScores finds nothing
    }),
  );
  assert.equal(out, POLISHED);
});

test("orchestrator: multiple reviewers — the minimum score wins", async () => {
  let reviewer = 0;
  const outputs = ["lenient", "strict"];
  let editCalls = 0;
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true, reviewerCount: 2 }),
    mkDeps({
      editStream: async () => (++editCalls === 1 ? POLISHED : "Para one re-polished sentence."),
      runReviewer: async () => outputs[reviewer++],
      parseScores: (raw) =>
        raw === "strict"
          ? new Map([[0, { confidence: 2, reason: "calqued idiom" }]])
          : new Map([[0, { confidence: 5, reason: "fine" }]]),
    }),
  );
  assert.equal(
    out,
    "Para one re-polished sentence.\n\nPara two polished sentence.\n\nPara three polished sentence.",
  );
});
