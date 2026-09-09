// ── Which provider serves which pass ──
//
// Betty in the Cloud is deliberately not tied to one inference provider: the
// Worker exists precisely so that swapping one is a config change rather than
// an app release. Two things made that less true than intended, and this file
// fixes both.
//
// First, the passes want different providers, not just different models.
// Translation genuinely benefits from a 70B (chrF 78.3 against 76.7, and five
// points on Danish) while copy and line edit are a four-way tie where speed is
// what matters. Those can legitimately live on different vendors — and during
// a migration they must, because a voucher on the old provider is worth
// spending before it expires.
//
// Second, base URLs disagree about `/v1`. OVHcloud's ends at the host;
// Scaleway's already carries `/v1` (and a project id). Appending blindly gave
// `/v1/v1/chat/completions`.

import type { Env } from "./env";

export interface UpstreamRoute {
  /** Fully-qualified chat-completions endpoint. */
  url: string;
  apiKey: string;
  model: string;
  /** "default" means omit the field entirely — see proxy.ts. */
  reasoningEffort: string;
  /** For logs and error messages. Never a secret. */
  label: string;
}

/**
 * Join a configured base to the chat-completions path without doubling `/v1`.
 *
 * Accepts either convention, because both are what providers actually hand
 * you: `https://host` (OVHcloud) and `https://host/<project>/v1` (Scaleway).
 */
export function chatCompletionsUrl(base: string): string {
  const trimmed = (base || "").replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed)
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`;
}

/**
 * Pick the upstream for this request.
 *
 * The translate route is taken ONLY when a translate model is configured. That
 * condition is load-bearing rather than tidy: every translate-specific setting
 * — provider, key, and above all `reasoning_effort` — has to move together with
 * the model. Deciding reasoning on "was translation requested" instead would,
 * when PROVIDER_MODEL_TRANSLATE is unset, send the reasoning model with
 * reasoning left ON, which by measurement returns `content: null` after burning
 * the entire output budget. The customer pays for nothing at all.
 *
 * Each translate override falls back to its default-route counterpart, so
 * "same provider, different model" (the original arrangement) still works with
 * no new configuration.
 */
export function resolveUpstream(env: Env, pass: string | null): UpstreamRoute {
  const wantsTranslate = pass === "translate";
  const translateModel = env.PROVIDER_MODEL_TRANSLATE;

  if (wantsTranslate && translateModel) {
    return {
      url: chatCompletionsUrl(env.PROVIDER_API_BASE_TRANSLATE || env.PROVIDER_API_BASE),
      apiKey: env.PROVIDER_API_KEY_TRANSLATE || env.PROVIDER_API_KEY,
      model: translateModel,
      // "default" (omit) unless told otherwise: the translation models used so
      // far have no chain-of-thought to switch off, and gpt-oss 400s on an
      // explicit "none".
      reasoningEffort: env.PROVIDER_REASONING_EFFORT_TRANSLATE || "default",
      label: "translate",
    };
  }

  return {
    url: chatCompletionsUrl(env.PROVIDER_API_BASE),
    apiKey: env.PROVIDER_API_KEY,
    model: env.PROVIDER_MODEL,
    reasoningEffort: env.PROVIDER_REASONING_EFFORT || "none",
    label: "edit",
  };
}
