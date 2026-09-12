// Tests for the enhanced language analysis. The model is scripted, so these
// pin what the orchestrator itself promises: notes with invented quotes are
// dropped, a run resumes from its checkpoint, the advice call sees both the
// counts and the notes, and the result carries no edits of any kind.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runLanguageEnhance,
  type LanguageEnhanceState,
} from "../src/languageEnhance.ts";
import { analyzeLanguage } from "../src/languageAnalysis.ts";
import { samplePassages } from "../src/textEvaluator.ts";

type Call = { system: string; user: string };

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

function prose(n: number, seed = "harbor"): string {
  const paragraphs: string[] = [];
  let words = 0;
  let p = 0;
  while (words < n) {
    const sentence = `The ${seed} lantern number ${p} glowed softly over the quiet water tonight.`;
    const filler = Array.from({ length: 28 }, (_, k) => `word${p}x${k}`).join(" ");
    paragraphs.push(`${sentence} ${filler}.`);
    words += 40;
    p++;
  }
  return paragraphs.join("\n\n");
}

const units = [
  { name: "Chapter 1", original: prose(5000) },
  { name: "Chapter 2", original: prose(5000, "orchard") },
];
const counts = analyzeLanguage(units, "en");

test("notes keep only quotes that occur in the passage, and the advice reads both", async () => {
  const passages = samplePassages(units);
  const responses: string[] = passages.map((p) =>
    j({
      notes: [
        { kind: "told", quote: p.text.split(" ").slice(0, 6).join(" "), note: "Stated flatly." },
        { kind: "shown", quote: "a line the author never wrote", note: "Invented." },
      ],
    }),
  );
  responses.push("  Keep the lanterns; watch the adverbs.  ");
  const { llm, calls } = scriptedLlm(responses);

  const { result } = await runLanguageEnhance(units, { llm, counts, manuscriptLang: "en" });

  assert.equal(calls.length, passages.length + 1);
  assert.equal(result.passageCount, passages.length);
  assert.equal(result.notes.length, passages.length);
  assert.ok(result.notes.every((n) => n.kind === "told"));
  assert.equal(result.advice, "Keep the lanterns; watch the adverbs.");

  // The advice call carries the counts and the notes, never the manuscript.
  const advicePayload = JSON.parse(calls.at(-1)!.user);
  assert.ok(Array.isArray(advicePayload.counts.flagged));
  assert.equal(advicePayload.counts.areas.rhythm, counts.sections.rhythm);
  assert.equal(advicePayload.notes.length, passages.length);
  assert.ok(!calls.at(-1)!.user.includes("word3x7"));
});

test("a fence or heading around the advice is stripped", async () => {
  const passages = samplePassages(units);
  const responses: string[] = passages.map(() => j({ notes: [] }));
  responses.push("```\n## Advice\nOne paragraph.\n```");
  const { llm } = scriptedLlm(responses);
  const { result } = await runLanguageEnhance(units, { llm, counts });
  assert.equal(result.advice, "One paragraph.");
});

test("a run resumes from its checkpoint without re-reading passages", async () => {
  const passages = samplePassages(units);
  const halfway = Math.floor(passages.length / 2);
  const resume: LanguageEnhanceState = {
    passages,
    notes: [{ kind: "shown", chapter: "Chapter 1", quote: "x", note: "kept" }],
    nextPassageIndex: halfway,
  };
  const responses: string[] = passages.slice(halfway).map(() => j({ notes: [] }));
  responses.push("Done.");
  const { llm, calls } = scriptedLlm(responses);
  const checkpoints: number[] = [];

  const { result } = await runLanguageEnhance(units, {
    llm,
    counts,
    resumeFrom: resume,
    onCheckpoint: (s) => checkpoints.push(s.nextPassageIndex),
  });

  assert.equal(calls.length, passages.length - halfway + 1);
  assert.deepEqual(checkpoints, passages.slice(halfway).map((_, i) => halfway + i + 1));
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].note, "kept");
});

test("invalid JSON is retried once, then fails the run", async () => {
  const passages = samplePassages(units);
  const { llm } = scriptedLlm(["not json", "still not json"]);
  await assert.rejects(
    runLanguageEnhance(units.slice(0, 1), { llm, counts }),
    /valid JSON after a retry/,
  );
  assert.ok(passages.length > 0);
});
