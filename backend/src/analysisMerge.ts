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
      // Match on name OR any alias to consolidate cross-chunk references
      const candidateKeys = [c.name, ...(c.aliases ?? [])]
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
          aliases: uniq(c.aliases ?? []),
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
          ...(c.aliases ?? []),
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
  const result: CharLike[] = [];
  for (const v of byKey.values()) {
    if (!seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }
  // Sort by chapter count descending (proxy for importance)
  result.sort((a, b) => (b.chapters?.length ?? 0) - (a.chapters?.length ?? 0));
  return result;
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
