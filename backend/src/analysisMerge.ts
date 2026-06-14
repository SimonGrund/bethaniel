// ── Merge partial analysis results from chunked map-reduce ──

interface CharLike {
  name: string;
  aliases?: string[];
  chapters?: string[];
  physicalDescription?: string;
  personalityTraits?: string[];
  role?: string;
}

interface LocLike {
  name: string;
  aliases?: string[];
  chapters?: string[];
  description?: string;
  significance?: string;
}

interface EventLike {
  chapter?: string;
  description?: string;
  characters?: string[];
  timeReference?: string;
}

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function uniq(arr: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (!v) continue;
    const k = norm(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

/** Pick the longer/more informative of two optional strings. */
function pickLonger(a?: string, b?: string): string | undefined {
  const av = (a ?? "").trim();
  const bv = (b ?? "").trim();
  const isPlaceholder = (s: string) =>
    !s || /^not described$|^unspecified$|^unknown$|^n\/a$/i.test(s);
  if (isPlaceholder(av)) return bv || av;
  if (isPlaceholder(bv)) return av;
  return av.length >= bv.length ? av : bv;
}

export function mergeCharacters(parts: CharLike[][]): CharLike[] {
  const byKey = new Map<string, CharLike>();
  for (const list of parts) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!c || typeof c.name !== "string") continue;
      // Expand aliases with family-term normalisation
      const expandedAliases = expandFamilyAliases(c.aliases ?? []);
      // Match on name OR any alias to consolidate cross-chunk references
      const candidateKeys = [c.name, ...expandedAliases]
        .filter(Boolean)
        .map(norm);
      let existingKey: string | undefined;
      for (const k of candidateKeys) {
        if (byKey.has(k)) {
          existingKey = k;
          break;
        }
      }
      if (!existingKey) {
        const merged: CharLike = {
          name: c.name,
          aliases: uniq(expandedAliases),
          chapters: uniq(c.chapters ?? []),
          physicalDescription: c.physicalDescription,
          personalityTraits: uniq(c.personalityTraits ?? []),
          role: c.role,
        };
        for (const k of candidateKeys) byKey.set(k, merged);
      } else {
        const existing = byKey.get(existingKey)!;
        existing.aliases = uniq([
          ...(existing.aliases ?? []),
          ...expandedAliases,
          c.name,
        ]).filter((a) => norm(a) !== norm(existing.name));
        existing.chapters = uniq([
          ...(existing.chapters ?? []),
          ...(c.chapters ?? []),
        ]);
        existing.physicalDescription = pickLonger(
          existing.physicalDescription,
          c.physicalDescription,
        );
        existing.personalityTraits = uniq([
          ...(existing.personalityTraits ?? []),
          ...(c.personalityTraits ?? []),
        ]);
        existing.role = pickLonger(existing.role, c.role);
        // Register any new aliases under the same merged record
        for (const k of candidateKeys) {
          if (!byKey.has(k)) byKey.set(k, existing);
        }
      }
    }
  }
  // Deduplicate the values (same record indexed under multiple keys)
  const seen = new Set<CharLike>();
  let result: CharLike[] = [];
  for (const v of byKey.values()) {
    if (!seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }

  // ── Heuristic merge passes (zero-cost, no LLM) ──
  result = mergeBySubNameContainment(result);
  result = mergeByAliasOverlap(result);
  result = mergeByChapterMatch(result);
  result = mergeByFamilyReferences(result);

  // Sort by chapter count descending (proxy for importance)
  result.sort((a, b) => (b.chapters?.length ?? 0) - (a.chapters?.length ?? 0));
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Heuristic merge helpers
// ═══════════════════════════════════════════════════════════════════

const FAMILY_TERMS: Record<string, string> = {
  mom: "mother", mum: "mother", mama: "mother", mother: "mother",
  dad: "father", pop: "father", papa: "father", father: "father",
  bro: "brother", brother: "brother",
  sis: "sister", sister: "sister",
};

function expandFamilyAliases(aliases: string[]): string[] {
  const out = [...aliases];
  for (const a of aliases) {
    // Normalise family terms: "mom" → add "mother" as alias
    const words = a.toLowerCase().split(/\s+/);
    for (const w of words) {
      const fam = FAMILY_TERMS[w];
      if (fam && fam !== w) out.push(fam);
    }
    // Strip possessives: "Aaron's mom" → add "mom" / "mother" as standalone
    const stripped = a.replace(/^[a-z]+'s\s+/i, "").trim();
    if (stripped && norm(stripped) !== norm(a)) {
      out.push(stripped);
      // Also try normalised versions of the stripped term
      const sWords = stripped.toLowerCase().split(/\s+/);
      for (const sw of sWords) {
        const fam = FAMILY_TERMS[sw];
        if (fam && fam !== sw) out.push(fam);
      }
    }
  }
  return uniq(out);
}

/** Merge entries where one name is fully contained in another. */
function mergeBySubNameContainment(chars: CharLike[]): CharLike[] {
  const merged = new Set<number>();
  const out: CharLike[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (merged.has(i)) continue;
    let current: CharLike = { ...chars[i], aliases: [...(chars[i].aliases ?? [])] };
    for (let j = i + 1; j < chars.length; j++) {
      if (merged.has(j)) continue;
      const ni = norm(current.name);
      const nj = norm(chars[j].name);
      if (
        ni.length > 0 && nj.length > 0 &&
        (ni.includes(nj) || nj.includes(ni))
      ) {
        current = mergeTwo(current, chars[j]);
        merged.add(j);
      }
    }
    out.push(current);
  }
  return out;
}

/** Merge entries that share ≥1 normalised alias. */
function mergeByAliasOverlap(chars: CharLike[]): CharLike[] {
  const merged = new Set<number>();
  const out: CharLike[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (merged.has(i)) continue;
    let current: CharLike = { ...chars[i], aliases: [...(chars[i].aliases ?? [])] };
    const aliasesI = new Set((current.aliases ?? []).map(norm));
    for (let j = i + 1; j < chars.length; j++) {
      if (merged.has(j)) continue;
      const aliasesJ = new Set((chars[j].aliases ?? []).map(norm));
      const overlap = [...aliasesI].some((a) => aliasesJ.has(a));
      if (overlap) {
        current = mergeTwo(current, chars[j]);
        for (const a of chars[j].aliases ?? []) aliasesI.add(norm(a));
        merged.add(j);
      }
    }
    out.push(current);
  }
  return out;
}

/** Merge entries that appear in exactly the same chapters. */
function mergeByChapterMatch(chars: CharLike[]): CharLike[] {
  const merged = new Set<number>();
  const out: CharLike[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (merged.has(i)) continue;
    let current: CharLike = { ...chars[i], aliases: [...(chars[i].aliases ?? [])] };
    const chI = new Set((chars[i].chapters ?? []).map(norm));
    const isPlaceholder =
      !chars[i].physicalDescription ||
      /^(not described|unspecified|unknown|n\/a)$/i.test(chars[i].physicalDescription?.trim() ?? "");
    // Only merge by chapter match if both entries have placeholder descriptions
    // (strong signal they're the same person labelled differently)
    if (chI.size === 0) { out.push(current); continue; }
    for (let j = i + 1; j < chars.length; j++) {
      if (merged.has(j)) continue;
      const chJ = new Set((chars[j].chapters ?? []).map(norm));
      const isPlaceholderJ =
        !chars[j].physicalDescription ||
        /^(not described|unspecified|unknown|n\/a)$/i.test(chars[j].physicalDescription?.trim() ?? "");
      if (
        isPlaceholder && isPlaceholderJ &&
        chI.size > 0 && chI.size === chJ.size &&
        [...chI].every((c) => chJ.has(c))
      ) {
        current = mergeTwo(current, chars[j]);
        merged.add(j);
      }
    }
    out.push(current);
  }
  return out;
}

/**
 * Resolve family-reference entries like "Bria's mom" by finding the parent
 * character who matches the family role.
 */
function mergeByFamilyReferences(chars: CharLike[]): CharLike[] {
  // First pass: index characters by canonical name
  const byName = new Map<string, number>();
  for (let i = 0; i < chars.length; i++) {
    byName.set(norm(chars[i].name), i);
    for (const a of chars[i].aliases ?? []) {
      if (!byName.has(norm(a))) byName.set(norm(a), i);
    }
  }

  const merged = new Set<number>();
  const out: CharLike[] = [];

  const extractPossessor = (s: string): string | null => {
    const m = s.match(/^([a-z]+)'s\s+/i);
    return m ? norm(m[1]) : null;
  };

  for (let i = 0; i < chars.length; i++) {
    if (merged.has(i)) continue;
    let current: CharLike = { ...chars[i], aliases: [...(chars[i].aliases ?? [])] };

    // Check if this is a family-reference entry
    const possessor = extractPossessor(current.name);
    if (possessor && byName.has(possessor)) {
      // Try to find a character whose aliases include a shared family term
      const refFamilyTerms = new Set<string>();
      for (const a of current.aliases ?? []) {
        const stripped = a.replace(/^[a-z]+'s\s+/i, "").trim().toLowerCase();
        if (FAMILY_TERMS[stripped]) refFamilyTerms.add(FAMILY_TERMS[stripped]);
        for (const w of stripped.split(/\s+/)) {
          if (FAMILY_TERMS[w]) refFamilyTerms.add(FAMILY_TERMS[w]);
        }
      }

      for (let j = 0; j < chars.length; j++) {
        if (j === i || merged.has(j)) continue;
        const otherFamilyTerms = new Set<string>();
        for (const a of chars[j].aliases ?? []) {
          const stripped = a.replace(/^[a-z]+'s\s+/i, "").trim().toLowerCase();
          if (FAMILY_TERMS[stripped]) otherFamilyTerms.add(FAMILY_TERMS[stripped]);
          for (const w of stripped.split(/\s+/)) {
            if (FAMILY_TERMS[w]) otherFamilyTerms.add(FAMILY_TERMS[w]);
          }
        }
        // Also check the name itself for family terms
        for (const w of norm(chars[j].name).split(/\s+/)) {
          if (FAMILY_TERMS[w]) otherFamilyTerms.add(FAMILY_TERMS[w]);
        }
        if (norm(chars[j].name) === possessor) otherFamilyTerms.add("self");

        const sharesTerm =
          [...refFamilyTerms].some((t) => otherFamilyTerms.has(t));
        if (sharesTerm) {
          current = mergeTwo(current, chars[j]);
          merged.add(j);
        }
      }
    }
    out.push(current);
  }
  return out;
}

function mergeTwo(a: CharLike, b: CharLike): CharLike {
  return {
    name: a.name.length >= b.name.length ? a.name : b.name,
    aliases: uniq([
      ...(a.aliases ?? []),
      ...(b.aliases ?? []),
      a.name !== b.name ? b.name : "",
    ].filter(Boolean)),
    chapters: uniq([...(a.chapters ?? []), ...(b.chapters ?? [])]),
    physicalDescription: pickLonger(a.physicalDescription, b.physicalDescription),
    personalityTraits: uniq([
      ...(a.personalityTraits ?? []),
      ...(b.personalityTraits ?? []),
    ]),
    role: pickLonger(a.role, b.role),
  };
}

export function mergeLocations(parts: LocLike[][]): LocLike[] {
  const byKey = new Map<string, LocLike>();
  for (const list of parts) {
    if (!Array.isArray(list)) continue;
    for (const loc of list) {
      if (!loc || typeof loc.name !== "string") continue;
      const candidateKeys = [loc.name, ...(loc.aliases ?? [])]
        .filter(Boolean)
        .map(norm);
      let existingKey: string | undefined;
      for (const k of candidateKeys) {
        if (byKey.has(k)) {
          existingKey = k;
          break;
        }
      }
      if (!existingKey) {
        const merged: LocLike = {
          name: loc.name,
          aliases: uniq(loc.aliases ?? []),
          chapters: uniq(loc.chapters ?? []),
          description: loc.description,
          significance: loc.significance,
        };
        for (const k of candidateKeys) byKey.set(k, merged);
      } else {
        const existing = byKey.get(existingKey)!;
        existing.aliases = uniq([
          ...(existing.aliases ?? []),
          ...(loc.aliases ?? []),
          loc.name,
        ]).filter((a) => norm(a) !== norm(existing.name));
        existing.chapters = uniq([
          ...(existing.chapters ?? []),
          ...(loc.chapters ?? []),
        ]);
        existing.description = pickLonger(
          existing.description,
          loc.description,
        );
        existing.significance = pickLonger(
          existing.significance,
          loc.significance,
        );
        for (const k of candidateKeys) {
          if (!byKey.has(k)) byKey.set(k, existing);
        }
      }
    }
  }
  const seen = new Set<LocLike>();
  const result: LocLike[] = [];
  for (const v of byKey.values()) {
    if (!seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }
  result.sort((a, b) => (b.chapters?.length ?? 0) - (a.chapters?.length ?? 0));
  return result;
}

export function mergeEvents(parts: EventLike[][]): EventLike[] {
  const out: EventLike[] = [];
  const seen = new Set<string>();
  for (const list of parts) {
    if (!Array.isArray(list)) continue;
    for (const ev of list) {
      if (!ev || typeof ev.description !== "string") continue;
      // Dedupe near-identical events (same description + chapter)
      const key = `${norm(ev.chapter ?? "")}::${norm(ev.description).slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        chapter: ev.chapter,
        description: ev.description,
        characters: uniq(ev.characters ?? []),
        timeReference: ev.timeReference,
      });
    }
  }
  return out;
}

/**
 * Merge partial analysis JSONs from each chunk into a single combined result.
 * Each `part` is the structured JSON returned by one chunk's LLM call. It may
 * contain any of `characters`, `locations`, `events` keys (combined_analysis)
 * or just one of them (single-mode analysis).
 */
export function mergeAnalysisParts(parts: unknown[]): Record<string, unknown> {
  const charParts: CharLike[][] = [];
  const locParts: LocLike[][] = [];
  const evParts: EventLike[][] = [];

  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    if (Array.isArray(obj.characters))
      charParts.push(obj.characters as CharLike[]);
    if (Array.isArray(obj.locations)) locParts.push(obj.locations as LocLike[]);
    if (Array.isArray(obj.events)) evParts.push(obj.events as EventLike[]);
  }

  const result: Record<string, unknown> = {};
  if (charParts.length > 0) result.characters = mergeCharacters(charParts);
  if (locParts.length > 0) result.locations = mergeLocations(locParts);
  if (evParts.length > 0) result.events = mergeEvents(evParts);
  return result;
}
