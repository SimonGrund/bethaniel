// ── LanguageTool client ──
// Talks to a locally-running LanguageTool HTTP server (see languageToolServer.ts)
// to get grammar/punctuation corrections, and maps its /v2/check matches into
// Bethaniel Corrections. The match parser is pure and independently testable;
// the network call degrades to [] when the LanguageTool server isn't available.

import type { Correction } from "./types.js";
import { widenToWords } from "./retextChecks.js";
import { filterHallucinatedCorrections } from "./llm.js";

export interface LanguageToolReplacement {
  value: string;
}

/** One entry of a LanguageTool /v2/check `matches` array (subset we use). */
export interface LanguageToolMatch {
  message: string;
  shortMessage?: string;
  offset: number;
  length: number;
  replacements: LanguageToolReplacement[];
  rule?: {
    id?: string;
    issueType?: string;
    category?: { id?: string; name?: string };
  };
}

// Categories that either duplicate Bethaniel's own handling or are too noisy
// for fiction. TYPOGRAPHY covers smart quotes / dashes, which the quote-hygiene
// pass already manages and which would otherwise fight the manuscript's style.
const DEFAULT_SKIP_CATEGORIES = new Set(["TYPOGRAPHY"]);

/**
 * LanguageTool rule ids that insert a comma after an introductory word/phrase
 * ("Finally she…" → "Finally, she…"). Disabled when the introductory-comma
 * option is off, so LanguageTool matches the LLM's behavior.
 */
export const INTRODUCTORY_COMMA_RULES = [
  "MISSING_COMMA_AFTER_INTRODUCTORY_PHRASE",
  "SENT_START_CONJUNCTIVE_LINKING_ADVERB_COMMA",
];

/** Build the /v2/check request body. Extracted so it's unit-testable. */
export function buildCheckParams(
  text: string,
  language: string,
  opts?: { disabledRules?: string[] },
): URLSearchParams {
  const params = new URLSearchParams({ text, language, enabledOnly: "false" });
  if (opts?.disabledRules && opts.disabledRules.length > 0) {
    params.set("disabledRules", opts.disabledRules.join(","));
  }
  return params;
}

/**
 * Convert LanguageTool `matches` into context-anchored Corrections. Each match
 * gives an offset+length and ranked replacements; we take the top replacement
 * and widen the span by a word on each side so the resulting `original` is
 * locatable (a bare "Its" or "a" is not unique in a chunk). Matches in a
 * skipped category, or with no replacement, are dropped.
 */
export function parseLanguageToolMatches(
  text: string,
  matches: LanguageToolMatch[],
  opts?: { skipCategories?: Set<string>; lang?: string },
): Correction[] {
  const skip = opts?.skipCategories ?? DEFAULT_SKIP_CATEGORIES;
  const out: Correction[] = [];
  const seen = new Set<string>();

  for (const m of matches) {
    const replacement = m.replacements?.[0]?.value;
    if (replacement == null) continue;
    const catId = m.rule?.category?.id;
    if (catId && skip.has(catId)) continue;
    if (
      typeof m.offset !== "number" ||
      typeof m.length !== "number" ||
      m.length <= 0
    )
      continue;

    const start = m.offset;
    const end = m.offset + m.length;
    if (end > text.length) continue;

    const [ctxStart, ctxEnd] = widenToWords(text, start, end);
    const original = text.slice(ctxStart, ctxEnd);
    const corrected =
      text.slice(ctxStart, start) + replacement + text.slice(end, ctxEnd);
    if (original === corrected) continue;

    const key = original + " " + corrected;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      original,
      corrected,
      reason: `grammar:${(catId ?? m.rule?.id ?? "lt").toLowerCase()}`,
    });
  }
  // LanguageTool's own suggestions are just as prone to the same invented-text
  // patterns as the LLM's (an unrelated "typos" replacement on a name-shaped
  // token, a "repetitions_style" rule inserting a connective) — same filter,
  // same reasoning as llm.ts's parseCorrectionsJson.
  return filterHallucinatedCorrections(out, opts?.lang);
}

/**
 * Map a Bethaniel manuscript-language code (and English dialect) to a
 * LanguageTool language code. Returns null for languages LanguageTool isn't
 * configured for here, so callers skip the grammar pass rather than guess.
 */
export function mapLangToLanguageTool(
  lang?: string,
  dialect?: string,
): string | null {
  if (!lang || lang === "en" || lang === "en_US" || lang === "en_GB") {
    if (lang === "en_GB" || dialect === "british") return "en-GB";
    return "en-US";
  }
  const MAP: Record<string, string> = { da: "da-DK", de: "de-DE", es: "es" };
  return MAP[lang] ?? null;
}

/**
 * Run text through the local LanguageTool server and return Corrections.
 * No-op ([]) when the language is unsupported or the LanguageTool server is
 * unavailable (jar/java not installed) — grammar checking is best-effort.
 */
export async function checkText(
  text: string,
  opts: {
    lang?: string;
    dialect?: string;
    disabledRules?: string[];
    signal?: AbortSignal;
  },
): Promise<Correction[]> {
  const ltLang = mapLangToLanguageTool(opts.lang, opts.dialect);
  if (!ltLang || !text.trim()) return [];

  const {
    ensureLanguageToolRunning,
    getLanguageToolBaseUrl,
    isLanguageToolAvailable,
  } = await import("./languageToolServer.js");

  if (!isLanguageToolAvailable()) return [];
  await ensureLanguageToolRunning();

  const body = buildCheckParams(text, ltLang, {
    disabledRules: opts.disabledRules,
  });
  const res = await fetch(`${getLanguageToolBaseUrl()}/v2/check`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`LanguageTool /v2/check returned ${res.status}`);
  }
  const data = (await res.json()) as { matches?: LanguageToolMatch[] };
  return parseLanguageToolMatches(text, data.matches ?? [], { lang: opts.lang });
}
