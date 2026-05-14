"""
book_editor.py — Overnight CORRECTIONS pass for long Markdown documents.

Runs a Markdown file through a local Ollama model in chunks and produces:
  1. A corrected .md file
  2. A diff .md showing every change

This script is intentionally conservative. It is meant for OBJECTIVE
CORRECTIONS only:
  - spelling errors
  - duplicate words ("the the")
  - clearly incorrect word use ("their" vs "there", "affect" vs "effect")
  - missing/extra punctuation that is grammatically wrong
  - obvious typos

It will NOT:
  - rewrite for style or flow
  - rephrase sentences
  - "improve" anything subjective
  - touch dialogue, voice, or stylistic choices

Usage:
    python book_editor.py input.md
    python book_editor.py input.md --model qwen3:32b --words 2500
    python book_editor.py input.md --style-guide style.md --overlap 2
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
import time
from pathlib import Path

try:
    import ollama
except ImportError:
    sys.exit("Missing dependency. Run: pip install ollama")


# --------------------------------------------------------------------------
# System prompt — strict corrections-only mode
# --------------------------------------------------------------------------

BASE_SYSTEM_PROMPT = """You are a copy editor performing the FINAL pre-print pass on a manuscript.

YOUR ONLY JOB IS TO FIX OBJECTIVE ERRORS:
- Spelling errors and typos
- Duplicated words ("the the", "and and")
- Clearly incorrect word usage where context is unambiguous (e.g. "their" vs "there", "affect" vs "effect")
- Missing or extra punctuation that is grammatically wrong
- Capitalization errors at sentence starts and on proper nouns

LANGUAGE STANDARDS (apply consistently throughout):
- Use AMERICAN ENGLISH spelling: color (not colour), honor (not honour), center (not centre), gray (not grey), realize (not realise), organization (not organisation), traveled (not travelled), defense (not defence), license (not licence as a noun and verb), etc. If you find a British spelling, correct it to American.
- Use the OXFORD COMMA for lists of three or more items ("red, white, and blue" — not "red, white and blue"). If a list is missing the Oxford comma, add it.

YOU MUST NOT:
- Rewrite, rephrase, or restructure sentences
- "Improve" flow, clarity, or style
- Change word choice if the original word is correct
- Add, remove, split, or merge sentences
- Add, remove, split, or merge paragraphs
- Change punctuation that is merely a stylistic preference (em-dash usage, sentence fragments, comma splices used for effect in dialogue)
- Change quote style (straight " vs curly ")
- Change dash style (-, --, —)
- Change ellipsis style (... vs …)
- "Correct" intentional dialect, slang, or character voice in dialogue
- Translate anything
- Alter any proper noun (character names, place names) — even if it looks like a typo, leave names alone unless the style guide says otherwise

OUTPUT RULES — ABSOLUTE:
1. Output ONLY the corrected Markdown. No preamble, no commentary, no "Here is...".
2. Preserve ALL Markdown formatting EXACTLY:
   - Headings (#, ##, ###)
   - Bold (**text**) and italic (*text* or _text_)
   - Lists (-, *, 1.)
   - Block quotes (>)
   - Code blocks (```) and inline code (`)
   - Links and images
3. Preserve paragraph breaks (blank lines) EXACTLY.
4. Preserve single line breaks within paragraphs.
5. If a sentence has no objective error, output it BYTE-FOR-BYTE identically.
6. When in doubt, change NOTHING.

Remember: this is the final pass before print. The author has already done the
stylistic editing. You are only catching errors they missed.
"""


def build_system_prompt(style_guide: str | None) -> str:
    """Append a user-supplied style guide section to the base prompt."""
    if not style_guide:
        return BASE_SYSTEM_PROMPT
    return (
        BASE_SYSTEM_PROMPT
        + "\n\nAUTHOR'S STYLE GUIDE — PRESERVE THESE EXACTLY:\n"
        + style_guide.strip()
        + "\n"
    )


# --------------------------------------------------------------------------
# Corrections-only mode (FAST) — model returns JSON list of edits instead of
# the entire rewritten chunk. For mostly-clean text this is 3-10x faster
# because the model emits ~50 tokens of corrections instead of regenerating
# 3500 tokens of unchanged prose.
# --------------------------------------------------------------------------

CORRECTIONS_SYSTEM_PROMPT = """You are a copy editor performing the FINAL pre-print pass on a manuscript written in MARKDOWN.

YOUR JOB: find OBJECTIVE ERRORS in the text and return them as a JSON list of corrections.

WHAT COUNTS AS AN ERROR:
- Spelling errors and typos
- Duplicated words ("the the", "and and")
- Clearly incorrect word usage in unambiguous context (e.g. "their" vs "there", "affect" vs "effect")
- Missing or extra punctuation that is grammatically wrong
- Capitalization errors at sentence starts and on proper nouns
- British spellings — convert to AMERICAN ENGLISH (color, honor, center, gray, realize, organization, traveled, defense, etc.)
- Lists of three+ items missing the OXFORD COMMA — add it ("red, white, and blue")

ABSOLUTELY DO NOT TOUCH MARKDOWN FORMATTING:
The input is Markdown. The following characters are FORMATTING, NOT errors. NEVER remove or change them:
- `*italic*` and `_italic_` — leave the asterisks/underscores alone
- `**bold**` and `__bold__` — leave the markers alone
- `***bold italic***` — leave alone
- `# Heading`, `## Heading`, `### Heading` — leave the # marks alone
- `` `inline code` `` — leave the backticks alone
- ```` ```code blocks``` ```` — leave fence lines alone
- `> blockquote` — leave the `>` alone
- `- list item`, `* list item`, `1. list item` — leave the markers alone
- `[link text](url)` and `![alt](url)` — leave the brackets/parens alone
- `---` and `***` on their own lines (horizontal rules) — leave alone

If you see `*She whispered*`, the asterisks are italic markers — that is NOT an error. Do NOT propose a correction that removes them. The same applies to `**bold**`, `_italic_`, `# Heading`, etc.

A correction's "corrected" field MUST keep ALL surrounding markdown markers intact. If the "original" contains `*`, `_`, `**`, `#`, `` ` ``, `>`, `-`, `[`, `]`, `(`, `)`, the "corrected" MUST contain the same markers in the same positions — only the actual word(s) inside should change.

GOOD example (fixes the typo, preserves the italic markers):
  {"original": "*She wisphered softly*", "corrected": "*She whispered softly*"}
BAD example (removes the italic markers — DO NOT DO THIS):
  {"original": "*She wisphered softly*", "corrected": "She whispered softly"}

GOOD example (fixes the typo, preserves the heading marker):
  {"original": "## Chaper One", "corrected": "## Chapter One"}
BAD example (removes the heading marker — DO NOT DO THIS):
  {"original": "## Chaper One", "corrected": "Chapter One"}

DO NOT FLAG (these are NOT errors):
- ANY markdown formatting character (see above)
- Stylistic choices: em-dash usage, sentence fragments, comma splices in dialogue
- Quote style (straight vs curly), dash style, ellipsis style
- Word choice when the original word is correct
- Anything in dialogue that is intentional dialect, slang, or character voice
- Proper nouns (character/place names) — leave them alone unless the style guide says otherwise
- Anything subjective ("flow", "clarity", "improvement")

When in doubt, do NOT flag it.

OUTPUT FORMAT — STRICT JSON ONLY:
{
  "corrections": [
    {"original": "<exact verbatim phrase from input, with enough surrounding context to be UNIQUE in the text>", "corrected": "<the replacement, with all markdown markers preserved>"},
    ...
  ]
}

CRITICAL RULES FOR THE "original" FIELD:
1. It MUST appear verbatim, character-for-character, in the input text. Copy it exactly — same spaces, same punctuation, same capitalization, same markdown markers.
2. It MUST be unique within the input text. If the same error appears in multiple places with different context, include 5-10 words of surrounding text to make each "original" unique.
3. Keep it as SHORT as possible while still being unique — usually a phrase of 3-15 words containing the error.
4. Do NOT include line breaks unless absolutely necessary.

If there are NO errors, return: {"corrections": []}

Output ONLY the JSON object. No commentary, no markdown fences, no preamble.
"""


def build_corrections_system_prompt(style_guide: str | None) -> str:
    if not style_guide:
        return CORRECTIONS_SYSTEM_PROMPT
    return (
        CORRECTIONS_SYSTEM_PROMPT
        + "\n\nAUTHOR'S STYLE GUIDE — DO NOT FLAG ANYTHING THAT MATCHES THESE RULES:\n"
        + style_guide.strip()
        + "\n"
    )


def parse_corrections_json(raw: str) -> list[dict]:
    """Parse the model's JSON output into a list of {original, corrected} dicts.

    Tolerates a few common model misbehaviors:
    - Wrapping in ```json ... ``` fences
    - Leading/trailing prose before/after the JSON object
    """
    text = raw.strip()
    # Strip code fences.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    # Find the first { ... last } in case of stray commentary.
    first = text.find("{")
    last = text.rfind("}")
    if first != -1 and last != -1 and last > first:
        text = text[first:last + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    corrections = data.get("corrections", []) if isinstance(data, dict) else []
    cleaned: list[dict] = []
    for c in corrections:
        if not isinstance(c, dict):
            continue
        original = c.get("original")
        corrected = c.get("corrected")
        if isinstance(original, str) and isinstance(corrected, str) and original:
            cleaned.append({"original": original, "corrected": corrected})
    return cleaned


def apply_corrections(text: str, corrections: list[dict]) -> tuple[str, list[dict], list[dict]]:
    """Apply a list of corrections to text.

    Returns (new_text, applied, skipped). A correction is skipped if its
    "original" string is missing from the text, appears more than once
    (ambiguous — we don't know which one to fix), or would strip / mangle
    Markdown formatting markers.
    """
    applied: list[dict] = []
    skipped: list[dict] = []
    new_text = text
    for c in corrections:
        original = c["original"]
        corrected = c["corrected"]
        if original == corrected:
            skipped.append({**c, "reason": "no-op"})
            continue
        formatting_issue = _markdown_marker_violation(original, corrected)
        if formatting_issue:
            skipped.append({**c, "reason": f"would alter markdown: {formatting_issue}"})
            continue
        count = new_text.count(original)
        if count == 0:
            skipped.append({**c, "reason": "not found"})
        elif count > 1:
            skipped.append({**c, "reason": f"ambiguous ({count} matches)"})
        else:
            new_text = new_text.replace(original, corrected, 1)
            applied.append(c)
    return new_text, applied, skipped


# Markdown markers we never let the model strip via a correction.
# Each entry is (label, regex) — we count matches in original vs corrected
# and reject the correction if the count drops.
_MARKDOWN_MARKER_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("triple-asterisk", re.compile(r"\*\*\*")),
    ("double-asterisk (bold)", re.compile(r"\*\*")),
    ("single-asterisk (italic)", re.compile(r"(?<!\*)\*(?!\*)")),
    ("double-underscore (bold)", re.compile(r"__")),
    ("single-underscore (italic)", re.compile(r"(?<!_)_(?!_)")),
    ("backtick (code)", re.compile(r"`")),
    ("heading marker (#)", re.compile(r"(?m)^\s*#{1,6}\s")),
    ("blockquote (>)", re.compile(r"(?m)^\s*>")),
    ("list marker", re.compile(r"(?m)^\s*(?:[-*+]|\d+\.)\s")),
    ("link/image bracket", re.compile(r"\[|\]")),
]


def _markdown_marker_violation(original: str, corrected: str) -> str | None:
    """Return a reason string if the correction strips a markdown marker.

    Returns None if the correction preserves all markdown markers (or adds them).
    """
    for label, pattern in _MARKDOWN_MARKER_PATTERNS:
        before_count = len(pattern.findall(original))
        after_count = len(pattern.findall(corrected))
        if after_count < before_count:
            return f"removed {before_count - after_count}× {label}"
    return None


# --------------------------------------------------------------------------
# Chunking — split on chapter/section/paragraph boundaries with overlap
# --------------------------------------------------------------------------

def split_into_paragraphs(text: str) -> list[str]:
    """Split into paragraph blocks, each block keeps its trailing blank line."""
    parts = re.split(r"(\n\s*\n)", text)
    blocks: list[str] = []
    buffer = ""
    for part in parts:
        buffer += part
        if part.strip() == "":
            if buffer.strip():
                blocks.append(buffer)
            buffer = ""
    if buffer.strip():
        blocks.append(buffer)
    return blocks


def split_into_chunks(text: str, target_words: int, overlap_paragraphs: int) -> list[dict]:
    """
    Split markdown into chunks of roughly `target_words` words.

    Each chunk dict:
        {
          "body": text actually sent to the model (includes head overlap),
          "core": text used in the final output (no head overlap),
          "overlap_head_paragraphs": how many leading paragraphs are overlap context,
        }

    Overlap paragraphs let the model see the end of the previous chunk for
    continuity, then we strip them from the response so they aren't duplicated.
    Chapter boundaries (lines starting with # or ##) reset overlap to 0.
    """
    paragraphs = split_into_paragraphs(text)

    chunks: list[dict] = []
    current_indices: list[int] = []
    current_words = 0

    def words_in(idx: int) -> int:
        return len(paragraphs[idx].split())

    def flush(head_overlap: int) -> None:
        nonlocal current_indices, current_words
        if not current_indices:
            return
        body = "".join(paragraphs[i] for i in current_indices)
        core_indices = current_indices[head_overlap:]
        core = "".join(paragraphs[i] for i in core_indices)
        chunks.append({
            "body": body.strip("\n"),
            "core": core.strip("\n"),
            "overlap_head_paragraphs": head_overlap,
        })
        current_indices = []
        current_words = 0

    i = 0
    while i < len(paragraphs):
        para = paragraphs[i]
        is_top_heading = bool(re.match(r"^\s*#{1,2}\s", para))

        # Break BEFORE a top-level heading to keep chapters intact.
        if is_top_heading and current_words > 0:
            flush(head_overlap=0)  # don't bleed overlap into a new chapter

        current_indices.append(i)
        current_words += words_in(i)

        if current_words >= target_words:
            head_overlap = 0 if not chunks else min(overlap_paragraphs, len(current_indices) - 1)
            flush(head_overlap=head_overlap)
            # Seed next chunk with the last `overlap_paragraphs` paragraphs.
            if overlap_paragraphs > 0 and i + 1 < len(paragraphs):
                seed_start = max(0, i + 1 - overlap_paragraphs)
                current_indices = list(range(seed_start, i + 1))
                current_words = sum(words_in(j) for j in current_indices)
        i += 1

    head_overlap = 0 if not chunks else min(overlap_paragraphs, len(current_indices) - 1)
    flush(head_overlap=max(0, head_overlap))
    return chunks


def strip_overlap_from_response(response: str, overlap_paragraphs: int) -> str:
    """Drop the first N paragraphs from the model's response (these were overlap context)."""
    if overlap_paragraphs <= 0:
        return response
    paragraphs = split_into_paragraphs(response)
    if len(paragraphs) <= overlap_paragraphs:
        # Model returned less than expected — keep everything to avoid losing text.
        return response
    return "".join(paragraphs[overlap_paragraphs:]).strip("\n")


# --------------------------------------------------------------------------
# Formatting validators — flag dangerous structural changes
# --------------------------------------------------------------------------

def formatting_signature(text: str) -> dict:
    """Return a fingerprint of structural markdown elements."""
    return {
        "paragraphs": len(re.split(r"\n\s*\n", text.strip())),
        "headings": len(re.findall(r"(?m)^#{1,6}\s", text)),
        "bold_markers": text.count("**"),
        "code_fences": text.count("```"),
        "blockquotes": len(re.findall(r"(?m)^\s*>", text)),
        "list_items": len(re.findall(r"(?m)^\s*([-*+]|\d+\.)\s", text)),
    }


def compare_signatures(before: dict, after: dict) -> list[str]:
    warnings = []
    for key, before_value in before.items():
        after_value = after[key]
        if before_value != after_value:
            warnings.append(f"{key}: {before_value} → {after_value}")
    return warnings


# --------------------------------------------------------------------------
# Ollama call
# --------------------------------------------------------------------------

def edit_chunk(model: str, chunk_text: str, system_prompt: str) -> str:
    response = ollama.chat(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": chunk_text},
        ],
        options={
            "temperature": 0.1,   # very low — corrections only
            "top_p": 0.9,
            "num_ctx": 16384,
        },
    )
    return response["message"]["content"].strip()


def edit_chunk_stream(model: str, chunk_text: str, system_prompt: str):
    """Streaming version of edit_chunk. Yields token chunks as the model produces them."""
    stream = ollama.chat(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": chunk_text},
        ],
        options={
            "temperature": 0.1,
            "top_p": 0.9,
            "num_ctx": 16384,
        },
        stream=True,
    )
    for part in stream:
        token = part.get("message", {}).get("content", "")
        if token:
            yield token


def find_corrections_stream(model: str, chunk_text: str, system_prompt: str):
    """Streaming corrections-mode call.

    Yields raw token strings as the model produces JSON. The caller is
    responsible for accumulating the full string and then calling
    parse_corrections_json on it.

    Uses Ollama's JSON format mode for reliability.
    """
    stream = ollama.chat(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": chunk_text},
        ],
        format="json",
        options={
            "temperature": 0.0,
            "top_p": 0.9,
            "num_ctx": 16384,
        },
        stream=True,
    )
    for part in stream:
        token = part.get("message", {}).get("content", "")
        if token:
            yield token


def find_corrections(model: str, chunk_text: str, system_prompt: str) -> list[dict]:
    """Non-streaming corrections-mode call. Returns parsed correction dicts."""
    response = ollama.chat(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": chunk_text},
        ],
        format="json",
        options={
            "temperature": 0.0,
            "top_p": 0.9,
            "num_ctx": 16384,
        },
    )
    return parse_corrections_json(response["message"]["content"])


# --------------------------------------------------------------------------
# Diff rendering
# --------------------------------------------------------------------------

def make_diff(before: str, after: str, label: str) -> str:
    diff_lines = list(difflib.unified_diff(
        before.splitlines(),
        after.splitlines(),
        fromfile=f"{label} (original)",
        tofile=f"{label} (edited)",
        lineterm="",
        n=2,
    ))
    if not diff_lines:
        return f"### {label}\n_No changes._\n"
    return f"### {label}\n```diff\n" + "\n".join(diff_lines) + "\n```\n"


# --------------------------------------------------------------------------
# Main pipeline
# --------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Conservative local LLM copy editor for Markdown.")
    parser.add_argument("input", type=Path, help="Input .md file")
    parser.add_argument("--output", type=Path, help="Output .md (default: <input>.edited.md)")
    parser.add_argument("--diff", type=Path, help="Diff .md (default: <input>.diff.md)")
    parser.add_argument("--model", default="qwen3:32b", help="Ollama model name")
    parser.add_argument("--words", type=int, default=2500, help="Target words per chunk")
    parser.add_argument("--overlap", type=int, default=1,
                        help="Paragraphs of overlap between chunks for context (default 1)")
    parser.add_argument("--style-guide", type=Path,
                        help="Optional .md file listing names/terms/styles to preserve")
    args = parser.parse_args()

    input_path: Path = args.input
    if not input_path.exists():
        sys.exit(f"File not found: {input_path}")

    output_path: Path = args.output or input_path.with_suffix(".edited.md")
    diff_path: Path = args.diff or input_path.with_suffix(".diff.md")

    style_guide_text = None
    style_guide_source: Path | None = None
    if args.style_guide:
        if not args.style_guide.exists():
            sys.exit(f"Style guide not found: {args.style_guide}")
        style_guide_source = args.style_guide
    else:
        # Auto-load style.md next to the input file if present.
        default_guide = input_path.parent / "style.md"
        if default_guide.exists():
            style_guide_source = default_guide

    if style_guide_source:
        style_guide_text = style_guide_source.read_text(encoding="utf-8")

    system_prompt = build_system_prompt(style_guide_text)
    text = input_path.read_text(encoding="utf-8")
    chunks = split_into_chunks(text, args.words, args.overlap)
    total_words = sum(len(c["core"].split()) for c in chunks)

    print(f"Input:        {input_path}")
    print(f"Model:        {args.model}")
    print(f"Chunks:       {len(chunks)} (~{total_words:,} words total)")
    print(f"Overlap:      {args.overlap} paragraph(s)")
    print(f"Style guide:  {style_guide_source or '(none)'}")
    print(f"Output:       {output_path}")
    print(f"Diff:         {diff_path}")
    print("-" * 60)

    output_path.write_text("", encoding="utf-8")
    diff_path.write_text(f"# Edit diff for {input_path.name}\n\n", encoding="utf-8")

    start_time = time.time()

    for i, chunk in enumerate(chunks, 1):
        chunk_label = f"Chunk {i}/{len(chunks)}"
        chunk_words = len(chunk["body"].split())
        t0 = time.time()
        print(f"[{chunk_label}] {chunk_words} words ... ", end="", flush=True)

        try:
            edited_full = edit_chunk(args.model, chunk["body"], system_prompt)
            edited_core = strip_overlap_from_response(edited_full, chunk["overlap_head_paragraphs"])
        except Exception as exc:
            print(f"ERROR: {exc}")
            print("       Keeping original chunk and continuing.")
            edited_core = chunk["core"]

        elapsed = time.time() - t0
        print(f"done in {elapsed:.1f}s")

        sig_before = formatting_signature(chunk["core"])
        sig_after = formatting_signature(edited_core)
        warnings = compare_signatures(sig_before, sig_after)
        if warnings:
            print("       Formatting changed:")
            for warning in warnings:
                print(f"         ⚠ {warning}")

        with output_path.open("a", encoding="utf-8") as out:
            out.write(edited_core)
            out.write("\n\n")

        with diff_path.open("a", encoding="utf-8") as out:
            out.write(make_diff(chunk["core"], edited_core, chunk_label))
            if warnings:
                out.write("\n**Formatting warnings:**\n\n")
                for warning in warnings:
                    out.write(f"- {warning}\n")
                out.write("\n")
            out.write("\n---\n\n")

    total_elapsed = time.time() - start_time
    print("-" * 60)
    print(f"Finished in {total_elapsed/60:.1f} minutes.")
    print(f"Edited file:  {output_path}")
    print(f"Diff report:  {diff_path}")


if __name__ == "__main__":
    main()
