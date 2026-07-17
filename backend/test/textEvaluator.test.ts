// Tests for the text-evaluator orchestrator. The LLM is scripted (same
// pattern as storyAnalysis.test.ts): each test queues responses and asserts
// on passage sampling, correction digestion, quote fidelity, checkpoint
// resume, and the final report/structuredData shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  samplePassages,
  digestCorrections,
  runTextEvaluation,
  type TextEvaluatorState,
} from "../src/textEvaluator.ts";
import type { Correction, EditUnit } from "../src/types.ts";

type Call = { system: string; user: string };

/** Scripted LLM: returns queued responses in order, records every call. */
function scriptedLlm(responses: (string | Error)[]) {
  const calls: Call[] = [];
  const llm = async (system: string, user: string): Promise<string> => {
    calls.push({ system, user });
    const next = responses.shift();
    if (next === undefined) throw new Error("scripted LLM ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { llm, calls };
}

const j = (o: unknown) => JSON.stringify(o);

/** Synthetic prose: `n` words in ~40-word paragraphs, each containing a
 *  distinctive sentence so quote-fidelity checks have known text to match. */
function prose(n: number, seed = "harbor"): string {
  const paragraphs: string[] = [];
  let words = 0;
  let p = 0;
  while (words < n) {
    const sentence = `The ${seed} lantern number ${p} glowed softly over the quiet water tonight.`;
    const filler = Array.from(
      { length: 28 },
      (_, k) => `word${p}x${k}`,
    ).join(" ");
    paragraphs.push(`${sentence} ${filler}.`);
    words += 40;
    p++;
  }
  return paragraphs.join("\n\n");
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ── samplePassages ──

test("sampling is deterministic", () => {
  const units = [{ name: "Chapter 1", original: prose(5000) }];
  assert.deepEqual(samplePassages(units), samplePassages(units));
});

test("passage count scales with manuscript size and is capped", () => {
  const big = [{ name: "Chapter 1", original: prose(100_000) }];
  assert.equal(samplePassages(big).length, 14);

  const tiny = [{ name: "Chapter 1", original: prose(300) }];
  assert.equal(samplePassages(tiny).length, 1);
});

test("passages respect word bounds on uniform text", () => {
  const units = [{ name: "Chapter 1", original: prose(20_000) }];
  const passages = samplePassages(units);
  for (const p of passages) {
    assert.ok(p.wordCount >= 450, `passage too short: ${p.wordCount}`);
    assert.ok(p.wordCount <= 800, `passage too long: ${p.wordCount}`);
    assert.equal(p.wordCount, wordCount(p.text));
  }
});

test("passages spread across chapters and never cross a boundary", () => {
  const units = [
    { name: "Chapter 1", original: prose(7000, "north") },
    { name: "Chapter 2", original: prose(7000, "south") },
    { name: "Chapter 3", original: prose(7000, "east") },
  ];
  const passages = samplePassages(units);
  const chapters = new Set(passages.map((p) => p.chapter));
  assert.ok(chapters.size >= 3, `expected spread, got ${[...chapters]}`);
  for (const p of passages) {
    const unit = units.find((u) => u.name === p.chapter);
    assert.ok(unit, `unknown chapter ${p.chapter}`);
    // Every paragraph of the passage came from that one chapter.
    assert.ok(
      unit!.original.includes(p.text.trim()),
      "passage text crosses a chapter boundary or was altered",
    );
  }
});

test("passages do not overlap and skip heading-only paragraphs", () => {
  const original = `# Chapter 1\n\n${prose(4000)}`;
  const passages = samplePassages([{ name: "Chapter 1", original }]);
  assert.ok(passages.length >= 2);
  for (const p of passages) {
    assert.ok(!/^#/.test(p.text.trim()), "passage starts with a heading");
  }
  for (let i = 1; i < passages.length; i++) {
    assert.ok(
      !passages[i - 1].text.includes(passages[i].text.slice(0, 60)) &&
        !passages[i].text.includes(passages[i - 1].text.slice(0, 60)),
      "passages overlap",
    );
  }
});

// ── digestCorrections ──

test("digest groups identical reasons and keyword-buckets variants", () => {
  const corrections: Correction[] = [
    { original: "teh", corrected: "the", reason: "Spelling error" },
    { original: "recieve", corrected: "receive", reason: "spelling error." },
    { original: "wierd", corrected: "weird", reason: "Fixed a typo" },
    { original: "a, b", corrected: "a b", reason: "Unnecessary comma" },
  ];
  const digest = digestCorrections(corrections);
  assert.equal(digest.total, 4);
  const spelling = digest.patterns.find((p) => p.label === "spelling");
  assert.ok(spelling, "no spelling bucket");
  assert.equal(spelling!.count, 3);
  const punct = digest.patterns.find((p) => p.label === "punctuation");
  assert.ok(punct, "no punctuation bucket");
  assert.equal(punct!.count, 1);
});

test("digest excludes flagged corrections and caps patterns/examples", () => {
  const corrections: Correction[] = [
    { original: "x", corrected: "y", reason: "spelling", flagged: true },
  ];
  for (let i = 0; i < 15; i++) {
    corrections.push({
      original: `orig ${i} ${"pad ".repeat(60)}`,
      corrected: `fix ${i}`,
      reason: `unique habit number ${i}`,
    });
  }
  const digest = digestCorrections(corrections);
  assert.equal(digest.total, 15); // flagged one excluded
  assert.ok(digest.patterns.length <= 10);
  for (const p of digest.patterns) {
    assert.ok(p.examples.length <= 3);
    for (const ex of p.examples) {
      assert.ok(ex.original.length <= 123); // 120 + ellipsis
    }
  }
});

test("digest of nothing is empty", () => {
  assert.deepEqual(digestCorrections([]), { total: 0, patterns: [] });
});

// ── runTextEvaluation ──

// Small two-chapter book that samples to exactly 2 passages
// (3300 words → min(clamp(0→6), floor(3300/1600)=2) = 2).
const twoPassageUnits: EditUnit[] = [
  { name: "Chapter 1", original: prose(1650, "north") },
  { name: "Chapter 2", original: prose(1650, "south") },
];

// Quotes must be verbatim from the sampled passage, so derive them from the
// deterministic sampler output instead of guessing paragraph numbers.
const twoPassages = samplePassages(twoPassageUnits);

function critiqueResponse(passageIndex: number) {
  return j({
    observations: [
      {
        theme: "repetition",
        quote: twoPassages[passageIndex].text.split(/\s+/).slice(0, 8).join(" "),
        note: "The lantern image recurs in nearly every paragraph.",
      },
    ],
  });
}

const reportMd = "## Overview\n\nA promising draft.\n\n## Repetition\n\nAdvice.";

test("critique calls carry passage text; report and structuredData come back", async () => {
  const { llm, calls } = scriptedLlm([
    critiqueResponse(0),
    critiqueResponse(1),
    reportMd,
  ]);
  const { report, structuredData } = await runTextEvaluation(twoPassageUnits, {
    llm,
  });

  assert.equal(calls.length, 3);
  assert.ok(calls[0].user.includes("north lantern"));
  assert.ok(calls[1].user.includes("south lantern"));
  assert.equal(report, reportMd);

  assert.equal(structuredData.passageCount, 2);
  assert.ok(structuredData.sampledWords > 0);
  assert.equal(structuredData.themes.length, 1);
  assert.equal(structuredData.themes[0].theme, "repetition");
  assert.equal(structuredData.themes[0].observations.length, 2);
  assert.equal(structuredData.themes[0].observations[0].chapter, "Chapter 1");
});

test("fabricated quotes are dropped; verbatim quotes survive", async () => {
  const fabricated = j({
    observations: [
      {
        theme: "weak_verbs",
        quote: "purple elephants danced across the marmalade sky",
        note: "made up",
      },
    ],
  });
  const { llm } = scriptedLlm([
    critiqueResponse(0),
    fabricated,
    reportMd,
  ]);
  const { structuredData } = await runTextEvaluation(twoPassageUnits, { llm });
  const all = structuredData.themes.flatMap((t) => t.observations);
  assert.equal(all.length, 1);
  assert.equal(structuredData.themes[0].theme, "repetition");
});

test("invalid JSON is retried once with feedback; twice aborts", async () => {
  const ok = scriptedLlm([
    "not json, sorry",
    critiqueResponse(0),
    critiqueResponse(1),
    reportMd,
  ]);
  await runTextEvaluation(twoPassageUnits, { llm: ok.llm });
  assert.equal(ok.calls.length, 4);
  assert.ok(/invalid|json/i.test(ok.calls[1].user));

  const bad = scriptedLlm(["garbage", "more garbage"]);
  await assert.rejects(
    () => runTextEvaluation(twoPassageUnits, { llm: bad.llm }),
    /json/i,
  );
});

test("synthesis payload includes grouped observations and the digest", async () => {
  const digest = digestCorrections([
    { original: "teh", corrected: "the", reason: "spelling" },
  ]);
  const { llm, calls } = scriptedLlm([
    critiqueResponse(0),
    critiqueResponse(1),
    reportMd,
  ]);
  const { structuredData } = await runTextEvaluation(twoPassageUnits, {
    llm,
    correctionsDigest: digest,
  });
  const payload = calls[2].user;
  assert.ok(payload.includes("repetition"));
  assert.ok(payload.includes("correctionsDigest"));
  assert.ok(payload.includes("spelling"));
  assert.deepEqual(structuredData.correctionsDigest, digest);
});

test("checkpoints fire per passage and resume skips completed passages", async () => {
  const checkpoints: TextEvaluatorState[] = [];
  const boom = new Error("connection lost");
  const first = scriptedLlm([critiqueResponse(0), boom]);
  await assert.rejects(() =>
    runTextEvaluation(twoPassageUnits, {
      llm: first.llm,
      onCheckpoint: (s) => checkpoints.push(structuredClone(s)),
    }),
  );
  assert.ok(checkpoints.length >= 1);
  const saved = checkpoints[checkpoints.length - 1];
  assert.equal(saved.nextPassageIndex, 1);

  const second = scriptedLlm([critiqueResponse(1), reportMd]);
  const { structuredData } = await runTextEvaluation(twoPassageUnits, {
    llm: second.llm,
    resumeFrom: saved,
  });
  assert.equal(second.calls.length, 2);
  assert.equal(
    structuredData.themes.flatMap((t) => t.observations).length,
    2,
  );
});

test("an aborted signal stops the run", async () => {
  const ac = new AbortController();
  ac.abort();
  const { llm } = scriptedLlm([critiqueResponse(0)]);
  await assert.rejects(
    () => runTextEvaluation(twoPassageUnits, { llm, signal: ac.signal }),
    /cancel/i,
  );
});
