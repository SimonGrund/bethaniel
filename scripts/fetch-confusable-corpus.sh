#!/bin/bash
# Corpora for scoring the confusable patterns. Not checked in: the English
# texts are the author's own manuscripts, the Danish ones are 1.5 MB of
# public-domain prose.
#
# English — the two manuscripts of the 2026-09-23 runs, from the installed
# app's database. Contemporary prose, which is what makes a zero-hit result
# on them strong evidence.
#
# Danish — Project Gutenberg. 19th/early-20th century orthography (aa for å,
# capitalised nouns), so a zero-hit result is WEAKER evidence than on the
# English side. See the header of confusablePatterns.ts.
set -euo pipefail
OUT=/tmp/quote-corpus
mkdir -p "$OUT"

DB="$HOME/Library/Application Support/Bethaniel/data/bethaniel.db"
if [ -f "$DB" ]; then
  sqlite3 "$DB" "select md from documents where name like 'Rage of the Rule-r56%' order by uploaded_at desc limit 1;" > "$OUT/rage.md" || true
  sqlite3 "$DB" "select md from documents where name like 'Path of the Taker 3.5%' order by uploaded_at desc limit 1;" > "$OUT/taker.md" || true
fi

for id in 24747 33360 34178 35102 36942 41072; do
  [ -s "$OUT/da_$id.txt" ] && continue
  curl -sL -m 60 "https://www.gutenberg.org/cache/epub/$id/pg$id.txt" -o "$OUT/da_$id.txt"
done

wc -c "$OUT"/*.md "$OUT"/da_*.txt 2>/dev/null || true
