// One billing problem reached the user as eight identical lines of "editor
// agent failed after retries", with the cause — DeepSeek answering 402
// Insufficient Balance — appearing nowhere in the failure summary. They
// reasonably concluded Betty was launching the wrong agents.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ApiAccountError } from "../src/llm.ts";
import { diagnoseTaskError } from "../src/logBus.ts";
import { isRetryableHint } from "../src/retryPolicy.ts";

const BALANCE_BODY = JSON.stringify({
  error: { message: "Insufficient Balance", type: "unknown_error" },
});

test("an out-of-credit response says so, in words the user can act on", () => {
  const err = new ApiAccountError(402, BALANCE_BODY);
  assert.match(err.message, /out of credit/i);
  assert.match(err.message, /Insufficient Balance/);
  // The way out matters as much as the cause.
  assert.match(err.message, /runs on this computer/i);
});

test("a rejected key points at the setting that fixes it", () => {
  const err = new ApiAccountError(401, JSON.stringify({ error: { message: "Bad key" } }));
  assert.match(err.message, /Model settings/);
});

test("a non-JSON body still yields a usable message", () => {
  const err = new ApiAccountError(402, "<html>Payment Required</html>");
  assert.ok(err.message.length > 20);
  assert.doesNotMatch(err.message, /undefined/);
});

test("out of credit is diagnosed as an account problem", () => {
  const d = diagnoseTaskError(new ApiAccountError(402, BALANCE_BODY).message);
  assert.equal(d?.hintKey, "log_hint_api_account");
});

test("an account problem is never auto-retried", () => {
  // Three agents retrying twice per chunk turns one billing problem into
  // dozens of identical failures and a bill for none of them.
  assert.equal(isRetryableHint("log_hint_api_account"), false);
});
