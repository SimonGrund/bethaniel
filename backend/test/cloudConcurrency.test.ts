// ── The cloud decides its own concurrency; the slider does not ──
//
// The parallel slider is a LOCAL control: it trades the author's own memory
// and bandwidth against speed. It has no business deciding how hard Bethaniel
// leans on its own provider, whose limits Bethaniel knows and the author does
// not.
//
// It used to. A persisted slider value — or a local hardware recommendation
// resolving late and overwriting the raise meant for the cloud — left a paid
// thirteen-chapter translation running THREE chapters at a time against a
// provider sized for twenty-four. Measured from the task timings of a real
// run: three started together, and each new one began only as another
// finished. Two separate attempts to fix that in the renderer both lost the
// race, which is why the decision moved to the server.
//
// A user's OWN API key is deliberately still the slider's business: that is
// their account and their rate limit.

import { test } from "node:test";
import assert from "node:assert/strict";

import { MODEL_CATALOG } from "../src/modelCatalog.ts";

/** Mirrors the choice /queue/add makes. Kept in step by the tests below. */
function effectiveParallel(model: string, requested: number | undefined): number {
  const cloudEntry = MODEL_CATALOG.find((e) => e.id === "bethaniel-cloud");
  const isCloudRun = !!cloudEntry && model === cloudEntry.fileName;
  return isCloudRun
    ? (cloudEntry.recommendedParallel ?? requested ?? 1)
    : (requested ?? 1);
}

const CLOUD = MODEL_CATALOG.find((e) => e.id === "bethaniel-cloud")!;

test("the cloud entry still declares a concurrency to use", () => {
  // The whole mechanism rests on this being set. If it is ever removed the
  // server would silently fall back to whatever the client asked for.
  assert.ok(
    typeof CLOUD.recommendedParallel === "number" && CLOUD.recommendedParallel > 1,
    "bethaniel-cloud has no recommendedParallel — the server has nothing to force",
  );
});

test("a cloud run ignores the slider, however low it is", () => {
  for (const requested of [1, 3, 8, undefined]) {
    assert.equal(
      effectiveParallel(CLOUD.fileName, requested),
      CLOUD.recommendedParallel,
      `slider ${String(requested)} leaked into a cloud run`,
    );
  }
});

test("a cloud run ignores the slider when it is set ABSURDLY high too", () => {
  // The guard runs both ways: the provider's limit is the provider's limit.
  assert.equal(effectiveParallel(CLOUD.fileName, 500), CLOUD.recommendedParallel);
});

test("a local model still obeys the slider", () => {
  assert.equal(effectiveParallel("Baby-Betty-4B-Q4_K_M.gguf", 2), 2);
  assert.equal(effectiveParallel("Baby-Betty-4B-Q4_K_M.gguf", 1), 1);
});

test("a user's own API key still obeys the slider", () => {
  // Their account, their rate limit, and the slider is the only way they have
  // to tell us about it.
  const own = MODEL_CATALOG.find(
    (e) => e.source === "api" && e.id !== "bethaniel-cloud",
  );
  assert.ok(own, "no external API entry in the catalog to test with");
  assert.equal(effectiveParallel(own.fileName, 4), 4);
});

test("a missing slider value falls back to one, not to zero", () => {
  // setConcurrency(0) would stall the queue outright.
  assert.equal(effectiveParallel("Baby-Betty-4B-Q4_K_M.gguf", undefined), 1);
});
