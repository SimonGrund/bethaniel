"""
consistency_checker.py — Whole-book consistency scanner.

Finds things an LLM-per-chunk editor cannot catch because each chunk is
processed in isolation:

  - Words spelled multiple ways across the manuscript
    (e.g. "grey"/"gray", "OK"/"Okay", "email"/"e-mail")
  - Proper nouns with inconsistent capitalization or spelling variants
  - Hyphenation inconsistencies ("well-known" vs "well known")
  - Numbers written inconsistently ("5" vs "five")
  - Quote/dash/ellipsis style mixing (straight vs curly, -- vs —, ... vs …)
  - Repeated words across paragraph boundaries

Pure deterministic Python — no LLM, no network, fast.

Usage:
    python consistency_checker.py book.md
    python consistency_checker.py book.md --report report.md
    python consistency_checker.py book.md --min-occurrences 3
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path


WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def find_lines_containing(text: str, needle: str) -> list[tuple[int, str]]:
    """Return list of (line_number, line) where needle appears (case-insensitive, word-bounded)."""
    pattern = re.compile(rf"\b{re.escape(needle)}\b", re.IGNORECASE)
    matches = []
    for line_no, line in enumerate(text.splitlines(), 1):
        if pattern.search(line):
            matches.append((line_no, line.strip()))
    return matches


def first_examples(text: str, needle: str, n: int = 2) -> list[str]:
    """Return up to n example lines containing the needle."""
    return [f"L{ln}: {line}" for ln, line in find_lines_containing(text, needle)[:n]]


# --------------------------------------------------------------------------
# Check 1: spelling variants of the same word (case-insensitive grouping)
# --------------------------------------------------------------------------

def check_case_variants(text: str, min_occurrences: int) -> list[str]:
    """Find words that appear with multiple capitalizations."""
    words = WORD_RE.findall(text)
    by_lower: dict[str, Counter] = defaultdict(Counter)
    for word in words:
        by_lower[word.lower()][word] += 1

    issues = []
    for lower, variants in by_lower.items():
        if len(variants) < 2:
            continue
        total = sum(variants.values())
        if total < min_occurrences:
            continue
        # Skip start-of-sentence noise: if one variant is just the capitalized
        # form and roughly matches sentence-start frequency, it's probably fine.
        # Only flag if BOTH non-trivial variants have ≥2 occurrences.
        significant = {v: c for v, c in variants.items() if c >= 2}
        if len(significant) < 2:
            continue
        breakdown = ", ".join(f"`{v}` ({c}×)" for v, c in variants.most_common())
        issues.append(f"- **{lower}**: {breakdown}")
    return sorted(issues)


# --------------------------------------------------------------------------
# Check 2: known American/British/style spelling pairs
# --------------------------------------------------------------------------

VARIANT_PAIRS = [
    ("grey", "gray"),
    ("colour", "color"),
    ("favour", "favor"),
    ("honour", "honor"),
    ("centre", "center"),
    ("theatre", "theater"),
    ("realise", "realize"),
    ("recognise", "recognize"),
    ("organisation", "organization"),
    ("travelled", "traveled"),
    ("travelling", "traveling"),
    ("cancelled", "canceled"),
    ("modelling", "modeling"),
    ("defence", "defense"),
    ("offence", "offense"),
    ("licence", "license"),
    ("practise", "practice"),
    ("aluminium", "aluminum"),
    ("ok", "okay"),
    ("email", "e-mail"),
    ("goodbye", "good-bye"),
    ("today", "to-day"),
    ("alright", "all right"),
    ("anymore", "any more"),
    ("awhile", "a while"),
]


def check_spelling_pairs(text: str) -> list[str]:
    """Flag when both members of a known variant pair appear."""
    issues = []
    lower = text.lower()
    for a, b in VARIANT_PAIRS:
        a_count = len(re.findall(rf"\b{re.escape(a)}\b", lower))
        b_count = len(re.findall(rf"\b{re.escape(b)}\b", lower))
        if a_count > 0 and b_count > 0:
            issues.append(f"- `{a}` ({a_count}×) vs `{b}` ({b_count}×)")
    return issues


# --------------------------------------------------------------------------
# Check 3: hyphenation inconsistencies
# --------------------------------------------------------------------------

def check_hyphenation(text: str) -> list[str]:
    """Find phrases that appear both hyphenated and unhyphenated."""
    hyphenated = set(re.findall(r"\b([a-zA-Z]+-[a-zA-Z]+)\b", text))
    issues = []
    for term in sorted(hyphenated):
        unhyphenated = term.replace("-", " ")
        # Word-bounded search for the unhyphenated form
        pattern = re.compile(rf"\b{re.escape(unhyphenated)}\b", re.IGNORECASE)
        unhyphen_count = len(pattern.findall(text))
        hyphen_count = len(re.findall(rf"\b{re.escape(term)}\b", text, re.IGNORECASE))
        if unhyphen_count > 0 and hyphen_count > 0:
            issues.append(f"- `{term}` ({hyphen_count}×) vs `{unhyphenated}` ({unhyphen_count}×)")
    return issues


# --------------------------------------------------------------------------
# Check 4: typography mixing (quotes, dashes, ellipses)
# --------------------------------------------------------------------------

def check_typography(text: str) -> list[str]:
    """Flag mixing of straight/curly quotes, dash styles, ellipsis styles."""
    issues = []

    straight_dq = text.count('"')
    curly_dq = text.count("\u201c") + text.count("\u201d")
    if straight_dq > 0 and curly_dq > 0:
        issues.append(f"- Double quotes: straight `\"` ({straight_dq}×) vs curly `“ ”` ({curly_dq}×)")

    # Apostrophes are tricky (contractions use them too); only warn if both styles are common.
    straight_sq = text.count("'")
    curly_sq = text.count("\u2018") + text.count("\u2019")
    if straight_sq > 5 and curly_sq > 5:
        issues.append(f"- Single quotes / apostrophes: straight `'` ({straight_sq}×) vs curly `‘ ’` ({curly_sq}×)")

    em_dash = text.count("\u2014")
    en_dash = text.count("\u2013")
    double_hyphen = text.count("--")
    dash_styles = sum(1 for v in (em_dash, en_dash, double_hyphen) if v > 0)
    if dash_styles > 1:
        parts = []
        if em_dash:
            parts.append(f"em `—` ({em_dash}×)")
        if en_dash:
            parts.append(f"en `–` ({en_dash}×)")
        if double_hyphen:
            parts.append(f"`--` ({double_hyphen}×)")
        issues.append(f"- Dashes: " + " vs ".join(parts))

    triple_dot = len(re.findall(r"\.\.\.", text))
    ellipsis_char = text.count("\u2026")
    if triple_dot > 0 and ellipsis_char > 0:
        issues.append(f"- Ellipses: `...` ({triple_dot}×) vs `…` ({ellipsis_char}×)")

    return issues


# --------------------------------------------------------------------------
# Check 5: duplicate consecutive words across line/paragraph breaks
# --------------------------------------------------------------------------

def check_duplicate_words(text: str) -> list[str]:
    """Find 'the the' style duplicates including across line breaks."""
    # Normalize all whitespace to single spaces for this check.
    flattened = re.sub(r"\s+", " ", text)
    issues = []
    seen = Counter()
    for match in re.finditer(r"\b([A-Za-z']+)\s+\1\b", flattened, re.IGNORECASE):
        word = match.group(1).lower()
        # Skip legitimate doublings
        if word in {"that", "had", "is", "do", "no", "very", "so", "now"}:
            continue
        seen[word] += 1
    for word, count in seen.most_common():
        issues.append(f"- `{word} {word}` ({count}×)")
    return issues


# --------------------------------------------------------------------------
# Check 6: numbers written both as digits and words
# --------------------------------------------------------------------------

NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
}


def check_number_style(text: str) -> list[str]:
    """Flag numbers that appear both as digits and spelled out."""
    lower = text.lower()
    issues = []
    for word, digit in NUMBER_WORDS.items():
        word_count = len(re.findall(rf"\b{word}\b", lower))
        digit_count = len(re.findall(rf"(?<!\d){digit}(?!\d)", text))
        if word_count > 0 and digit_count > 0:
            issues.append(f"- `{word}` ({word_count}×) vs `{digit}` ({digit_count}×)")
    return issues


# --------------------------------------------------------------------------
# Check 7: proper-noun-like terms appearing with multiple spellings
# --------------------------------------------------------------------------

def check_proper_nouns(text: str, min_occurrences: int) -> list[str]:
    """
    Find capitalized words (likely names) that have near-duplicates differing
    only in punctuation, hyphens, or one character — useful for catching
    "Bethaniel" vs "Bethanial" or "MacBookPro" vs "MacBook Pro".
    """
    # Find all capitalized standalone words used outside of sentence starts.
    # Heuristic: word starts with capital and is not preceded by sentence-end punct + space.
    candidates = Counter(re.findall(r"\b([A-Z][a-z]{2,})\b", text))
    issues = []
    items = [w for w, c in candidates.items() if c >= 2]
    # Compare each pair with Levenshtein distance 1 (cheap manual check).
    def edit_distance_one(a: str, b: str) -> bool:
        if abs(len(a) - len(b)) > 1:
            return False
        if a == b:
            return False
        # Same length: count differing chars
        if len(a) == len(b):
            return sum(1 for x, y in zip(a, b) if x != y) == 1
        # Differ by 1 char (insert/delete)
        shorter, longer = (a, b) if len(a) < len(b) else (b, a)
        for i in range(len(longer)):
            if shorter == longer[:i] + longer[i+1:]:
                return True
        return False

    seen_pairs = set()
    for i, w1 in enumerate(items):
        for w2 in items[i+1:]:
            if w1.lower() == w2.lower():
                continue
            if edit_distance_one(w1, w2):
                key = tuple(sorted((w1, w2)))
                if key in seen_pairs:
                    continue
                seen_pairs.add(key)
                if candidates[w1] + candidates[w2] >= min_occurrences:
                    issues.append(f"- `{w1}` ({candidates[w1]}×) vs `{w2}` ({candidates[w2]}×) — possible misspelling?")
    return sorted(issues)


# --------------------------------------------------------------------------
# Report builder
# --------------------------------------------------------------------------

def build_report(input_path: Path, text: str, min_occurrences: int) -> str:
    sections = [
        ("Spelling variant pairs (American/British/style)", check_spelling_pairs(text)),
        ("Possibly misspelled proper nouns", check_proper_nouns(text, min_occurrences)),
        ("Case variants (same word, different capitalization)", check_case_variants(text, min_occurrences)),
        ("Hyphenation inconsistencies", check_hyphenation(text)),
        ("Typography mixing (quotes / dashes / ellipses)", check_typography(text)),
        ("Numbers: digits vs spelled out", check_number_style(text)),
        ("Duplicate consecutive words", check_duplicate_words(text)),
    ]

    lines = [f"# Consistency report for {input_path.name}", ""]
    total_issues = sum(len(items) for _, items in sections)
    lines.append(f"**{total_issues} potential issues found.** Review each before accepting.")
    lines.append("")
    lines.append("> This report is heuristic — many findings will be intentional. ")
    lines.append("> Use it as a checklist, not as authoritative corrections.")
    lines.append("")

    for title, items in sections:
        lines.append(f"## {title}")
        if not items:
            lines.append("_No issues found._")
        else:
            lines.extend(items)
        lines.append("")

    return "\n".join(lines)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Whole-book consistency checker.")
    parser.add_argument("input", type=Path, help="Input .md file")
    parser.add_argument("--report", type=Path, help="Output report .md (default: <input>.consistency.md)")
    parser.add_argument("--min-occurrences", type=int, default=2,
                        help="Minimum total occurrences to flag a variant (default 2)")
    args = parser.parse_args()

    if not args.input.exists():
        sys.exit(f"File not found: {args.input}")

    report_path: Path = args.report or args.input.with_suffix(".consistency.md")
    text = args.input.read_text(encoding="utf-8")
    report = build_report(args.input, text, args.min_occurrences)
    report_path.write_text(report, encoding="utf-8")
    print(f"Wrote {report_path}")


if __name__ == "__main__":
    main()
