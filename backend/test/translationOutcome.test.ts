// ── A finished translation shows a file, not a review ──
//
// Tested from here because the frontend has no runner.
//
// The one thing that must not be lost when the per-chapter view goes away: a
// chapter that failed. Without it the author downloads a manuscript with
// source-language paragraphs in it and is told nothing — which is the exact
// failure this whole line of work started from.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  refundMailto,
  SUPPORT_EMAIL,
  translationOutcome,
} from "../../frontend/src/translationOutcome.ts";

const done = (name: string) => ({ name, status: "done" });

test("not settled while a chapter is still running", () => {
  const o = translationOutcome([done("One"), { name: "Two", status: "editing" }]);
  assert.equal(o.settled, false);
});

test("settled once every chapter has stopped, however it stopped", () => {
  const o = translationOutcome([
    done("One"),
    { name: "Two", status: "error", errors: ["chunk 1: boom"] },
    { name: "Three", status: "cancelled" },
  ]);
  assert.equal(o.settled, true);
});

test("an empty job is not settled — nothing has happened yet", () => {
  assert.equal(translationOutcome([]).settled, false);
});

test("a clean run reports no failures", () => {
  assert.deepEqual(translationOutcome([done("One"), done("Two")]).failures, []);
});

test("a failed chapter is reported with its error", () => {
  const o = translationOutcome([
    done("One"),
    { name: "Two", status: "error", errors: ["chunk 1: translation rejected: empty translation output"] },
  ]);
  assert.deepEqual(o.failures, [
    { name: "Two", error: "chunk 1: translation rejected: empty translation output" },
  ]);
});

test("a chapter with no loaded error reports an empty one, not its status", () => {
  // The full result is fetched lazily, so the message may simply not be here
  // yet. Printing "— error" beside the chapter name tells the author nothing
  // they cannot already see, and reads as the error itself.
  const o = translationOutcome([{ name: "Two", status: "cancelled" }]);
  assert.deepEqual(o.failures, [{ name: "Two", error: "" }]);
});

test("the refund mail lists a chapter with no message without a dangling colon", () => {
  const o = translationOutcome([{ name: "Two", status: "error" }]);
  const body = decodeURIComponent(
    refundMailto({ outcome: o, source: "b.docx" }).split("&body=")[1],
  );
  assert.ok(body.includes("- Two\n") || body.endsWith("- Two"));
  assert.ok(!body.includes("Two: "));
});

test("a very long error is truncated so the mailto survives", () => {
  const o = translationOutcome([
    { name: "Two", status: "error", errors: ["x".repeat(5000)] },
  ]);
  assert.ok(o.failures[0].error.length <= 200);
});

test("the refund mail names the manuscript, the language and every failure", () => {
  const o = translationOutcome([
    done("One"),
    { name: "Two", status: "error", errors: ["chunk 1: no credit"] },
  ]);
  const url = refundMailto({
    outcome: o,
    source: "book.docx",
    targetLang: "French",
    jobId: "abc123",
  });
  assert.ok(url.startsWith(`mailto:${SUPPORT_EMAIL}?`));
  const body = decodeURIComponent(url.split("&body=")[1]);
  assert.ok(body.includes("book.docx"));
  assert.ok(body.includes("French"));
  assert.ok(body.includes("abc123"));
  assert.ok(body.includes("Two: chunk 1: no credit"));
  assert.ok(body.includes("refund"));
});

test("the refund mail omits fields it does not have, rather than printing undefined", () => {
  const o = translationOutcome([{ name: "Two", status: "error", errors: ["x"] }]);
  const body = decodeURIComponent(
    refundMailto({ outcome: o, source: "book.docx" }).split("&body=")[1],
  );
  assert.ok(!body.includes("undefined"));
  assert.ok(!body.includes("Target language"));
  assert.ok(!body.includes("Job:"));
});

test("the subject and body are URL-encoded, so quotes cannot break the link", () => {
  const o = translationOutcome([
    { name: 'Chapter "One" & Two', status: "error", errors: ["a & b"] },
  ]);
  const url = refundMailto({ outcome: o, source: "my book.docx" });
  assert.ok(!url.includes(" "), "an unencoded space would truncate the mailto");
  assert.ok(decodeURIComponent(url).includes('Chapter "One" & Two'));
});
