// ── No raw control bytes in source ──
//
// store.ts and ReviewDeck.tsx each carried a literal NUL — the review deck's
// key separator, typed as the byte itself rather than as an escape. It compiles, it
// runs, and the string is identical either way, so nothing ever complained.
//
// What it cost was searchability: `file` reports such a source file as
// `data`, and grep skips binary files by default, so both were invisible to
// every text search in the repo. Looking for `partialize` in the store
// returned nothing at all, which reads as "this code does not exist".
//
// The escape is the fix. This is the guard, because the failure is silent and
// the next person to type a separator will not know either.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const TREES = ["backend/src", "frontend/src", "worker/src"];
const SOURCE = /\.(ts|tsx)$/;

/** Every control byte except tab, newline and carriage return — written as
 *  escapes, because a class of raw ones would make THIS file unsearchable. */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE.test(entry)) out.push(path);
  }
  return out;
}

test("no source file carries a raw control byte", () => {
  const offences: string[] = [];
  for (const tree of TREES) {
    for (const path of sourceFiles(join(ROOT, tree))) {
      const text = readFileSync(path, "utf8");
      if (!FORBIDDEN.test(text)) continue;
      text.split("\n").forEach((line, i) => {
        const at = line.search(FORBIDDEN);
        if (at < 0) return;
        const code = line.charCodeAt(at).toString(16).padStart(4, "0");
        offences.push(
          `${relative(ROOT, path)}:${i + 1} — U+${code.toUpperCase()}; write it as \\u${code}`,
        );
      });
    }
  }
  assert.deepEqual(
    offences,
    [],
    `a raw control byte makes the whole file invisible to grep:\n${offences.join("\n")}`,
  );
});
