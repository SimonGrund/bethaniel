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

/**
 * Rules that never found a real error in the benchmark and only ever
 * misfired. Deterministic corrections bypass the editor prompt entirely —
 * they are injected straight into the correction set — so the prompt's
 * DO-NOT-FLAG list cannot restrain them however well it is written. Two of
 * these produce exactly the mistakes that list forbids by name.
 *
 * Measured per-rule on stress100 (errored + clean fixtures), after the
 * parser's existing category filters:
 *
 *   rule                                       finds  misfires  on clean
 *   PCT_SINGULAR_NOUN_PLURAL_VERB_AGREEMENT        0         2         2
 *   NOUN_AROUND_IT                                 0         1         1
 *   RB_RB_COMMA                                    0         1         0
 *   BEEN_PART_AGREEMENT                            0         1         0
 *
 * Eight false positives removed, no true positives lost. The bar for adding
 * to this list is that ledger: zero real errors found, at least one invented.
 * A rule that misfires but also earns its keep stays on —
 * MORFOLOGIK_RULE_EN_US misfires six times and finds thirty-seven, and
 * disabling it would gut the grammar pass.
 *
 * What each one does when it fires:
 *   - PCT_SINGULAR_NOUN_PLURAL_VERB_AGREEMENT breaks the subjunctive ("as
 *     though the story were returning" -> "was") and misreads an adjective as
 *     a verb ("his coat still damp from" -> "damps"). The copy-edit prompt
 *     forbids the first in those words. Worse, the reviewer AGREED with it at
 *     confidence 5, so nothing downstream catches it either.
 *   - NOUN_AROUND_IT rewords correct prose ("the shop around her" -> "the
 *     surrounding shop"), which the prompt also forbids by name.
 *   - RB_RB_COMMA and BEEN_PART_AGREEMENT had no hits and one misfire each.
 *   - COMILLAS_TIPOGRAFICAS converts every straight quote in Spanish to an
 *     angle quote (" -> «»). Ledger across all eight fixtures: 248 invented,
 *     0 real errors found — the worst offender in the list by two orders of
 *     magnitude. It fired 124 times on a single clean Spanish fixture, once
 *     per quotation mark, which for a novel means every line of dialogue.
 *     That alone put Spanish copy-edit precision at 31% against 63-79% for
 *     the other three languages.
 *
 *     It went unnoticed because it is a picky-tier rule and the old Spanish
 *     fixture had almost no dialogue; the measurement above recorded "0 flags
 *     on clean text" in good faith. It is also not an error in the first
 *     place: « » versus " " is a house style, which this codebase already
 *     treats as one — quoteRepair.ts normalises quotation marks
 *     deterministically, and a style guide is where a publisher asks for
 *     angle quotes. LanguageTool should not be overruling that pass.
 */
export const ALWAYS_DISABLED_RULES = [
  "PCT_SINGULAR_NOUN_PLURAL_VERB_AGREEMENT",
  "NOUN_AROUND_IT",
  "RB_RB_COMMA",
  "BEEN_PART_AGREEMENT",
  "COMILLAS_TIPOGRAFICAS",
];

/**
 * Build the /v2/check request body. Extracted so it's unit-testable.
 *
 * `level=picky` turns on LanguageTool's second tier of rules, which is almost
 * entirely comma and confusion rules — exactly where recall was weakest.
 * Measured on all five bundled fixtures (LanguageTool alone, no model):
 *
 *   fixture              recall default -> picky   flags on clean text
 *   English stress100            56% -> 60%              4 -> 4
 *   English standard             21% -> 21%              2 -> 2
 *   Danish                        4% ->  4%              0 -> 0
 *   German                       31% -> 31%              1 -> 1
 *   Spanish                      40% -> 40%              0 -> 0
 *
 * Comma recall specifically went 19% -> 30% on stress100. Nothing regressed
 * and picky added no false positives on any clean fixture, which is what
 * makes it safe to leave on: the usual objection to picky is noise, and on
 * this corpus there is none.
 */
export function buildCheckParams(
  text: string,
  language: string,
  opts?: { disabledRules?: string[] },
): URLSearchParams {
  const params = new URLSearchParams({
    text,
    language,
    enabledOnly: "false",
    level: "picky",
  });
  // Merged rather than left to the caller: ALWAYS_DISABLED_RULES exists
  // because those rules cannot be restrained any other way, so a caller
  // that passes its own disabledRules must not drop them by accident.
  const disabled = [...ALWAYS_DISABLED_RULES, ...(opts?.disabledRules ?? [])];
  if (disabled.length > 0) {
    params.set("disabledRules", disabled.join(","));
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
