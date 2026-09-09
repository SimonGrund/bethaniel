// ── Provider routing ──
//
// The safety property under test: every translate-specific setting moves
// together with the translate MODEL. Decide reasoning_effort separately and an
// unset PROVIDER_MODEL_TRANSLATE sends the reasoning model with reasoning left
// on, which returns content: null after burning the whole output budget — a
// paid job billed for nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUpstream, chatCompletionsUrl } from "../src/upstream.ts";
import type { Env } from "../src/env.ts";

const OVH = {
  PROVIDER_API_BASE: "https://oai.endpoints.kepler.ai.cloud.ovh.net",
  PROVIDER_API_KEY: "ovh-key",
  PROVIDER_MODEL: "Qwen3.5-9B",
  PROVIDER_REASONING_EFFORT: "none",
};
const env = (over: Record<string, unknown> = {}) =>
  ({ ...OVH, ...over }) as unknown as Env;

test("a base without /v1 gets one, a base with /v1 does not get two", () => {
  assert.equal(
    chatCompletionsUrl("https://oai.endpoints.kepler.ai.cloud.ovh.net"),
    "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
  );
  // Scaleway hands you a base that already carries a project id and /v1.
  assert.equal(
    chatCompletionsUrl("https://api.scaleway.ai/abc-123/v1"),
    "https://api.scaleway.ai/abc-123/v1/chat/completions",
  );
  assert.equal(
    chatCompletionsUrl("https://api.scaleway.ai/abc-123/v1/"),
    "https://api.scaleway.ai/abc-123/v1/chat/completions",
  );
});

test("edit passes take the default provider", () => {
  for (const pass of [null, "edit", "anything-else"]) {
    const r = resolveUpstream(env(), pass);
    assert.equal(r.model, "Qwen3.5-9B");
    assert.equal(r.reasoningEffort, "none");
    assert.equal(r.apiKey, "ovh-key");
    assert.equal(r.label, "edit");
  }
});

test("without a translate model, translate falls back COMPLETELY", () => {
  // The dangerous case: it must fall back to the default model AND the default
  // reasoning setting, not one without the other.
  const r = resolveUpstream(env(), "translate");
  assert.equal(r.model, "Qwen3.5-9B");
  assert.equal(r.reasoningEffort, "none", "reasoning must follow the model");
  assert.equal(r.label, "edit");
});

test("same provider, different model — the original arrangement", () => {
  const r = resolveUpstream(
    env({ PROVIDER_MODEL_TRANSLATE: "Meta-Llama-3_3-70B-Instruct" }),
    "translate",
  );
  assert.equal(r.model, "Meta-Llama-3_3-70B-Instruct");
  assert.equal(r.apiKey, "ovh-key", "inherits the default key");
  assert.match(r.url, /ovh\.net/, "inherits the default base");
  assert.equal(r.reasoningEffort, "default", "omitted for a non-reasoning model");
});

test("two providers at once — editing moved, translation left on the voucher", () => {
  const r = env({
    PROVIDER_API_BASE: "https://api.scaleway.ai/proj/v1",
    PROVIDER_API_KEY: "scw-key",
    PROVIDER_MODEL: "qwen3.6-35b-a3b",
    PROVIDER_MODEL_TRANSLATE: "Meta-Llama-3_3-70B-Instruct",
    PROVIDER_API_BASE_TRANSLATE: "https://oai.endpoints.kepler.ai.cloud.ovh.net",
    PROVIDER_API_KEY_TRANSLATE: "ovh-key",
  });
  const edit = resolveUpstream(r, null);
  assert.equal(edit.apiKey, "scw-key");
  assert.equal(edit.url, "https://api.scaleway.ai/proj/v1/chat/completions");

  const tr = resolveUpstream(r, "translate");
  assert.equal(tr.apiKey, "ovh-key");
  assert.equal(tr.url, "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions");
  assert.equal(tr.model, "Meta-Llama-3_3-70B-Instruct");
});

test("a reasoning translate model can be told to switch it off", () => {
  const r = resolveUpstream(
    env({
      PROVIDER_MODEL_TRANSLATE: "some-qwen-that-reasons",
      PROVIDER_REASONING_EFFORT_TRANSLATE: "none",
    }),
    "translate",
  );
  assert.equal(r.reasoningEffort, "none");
});
