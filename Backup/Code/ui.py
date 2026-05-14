"""
ui.py — Minimal Streamlit UI for the book editor pipeline.

Run with:
    streamlit run Code/ui.py

Workflow in the UI:
    1. Upload a .docx (or .md)
    2. Pick chapters to edit (or "whole book")
    3. Click "Start editing"
    4. Watch the live log + progress bar
    5. Download the edited .docx and the diff .md when done
"""

from __future__ import annotations

import io
import re
import sys
import tempfile
import time
import queue
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import streamlit as st

# Make sibling modules importable when run via `streamlit run Code/ui.py`.
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from book_editor import (  # noqa: E402
    build_system_prompt,
    build_corrections_system_prompt,
    edit_chunk,
    edit_chunk_stream,
    find_corrections_stream,
    parse_corrections_json,
    apply_corrections,
    formatting_signature,
    compare_signatures,
    split_into_chunks,
    strip_overlap_from_response,
    make_diff,
)


# --------------------------------------------------------------------------
# i18n — lightweight translation layer (Danish + English)
# --------------------------------------------------------------------------

TRANSLATIONS: dict[str, dict[str, str]] = {
    # --- Masthead ---
    "subtitle": {
        "en": "a private copy editor for the final pre-print pass",
        "da": "en privat korrekturlæser til det sidste tryk-gennemsyn",
    },
    # --- Sidebar ---
    "settings": {"en": "Settings", "da": "Indstillinger"},
    "language": {"en": "Language", "da": "Sprog"},
    "model": {"en": "Ollama model", "da": "Ollama-model"},
    "model_help": {
        "en": "Could not detect installed models. Type the name manually.",
        "da": "Kunne ikke finde installerede modeller. Indtast navnet manuelt.",
    },
    "words_per_chunk": {"en": "Words per chunk", "da": "Ord pr. chunk"},
    "paragraph_overlap": {"en": "Paragraph overlap", "da": "Paragrafoverlap"},
    "fast_mode": {"en": "⚡ Fast mode (corrections only)", "da": "⚡ Hurtig tilstand (kun rettelser)"},
    "fast_mode_help": {
        "en": "Model returns just a list of edits (JSON) instead of rewriting the entire chunk. Typically 3-10x faster on clean prose. Disable to fall back to the original full-rewrite mode.",
        "da": "Modellen returnerer kun en liste af rettelser (JSON) i stedet for at omskrive hele chunk'en. Typisk 3-10× hurtigere på ren tekst. Slå fra for fuld omskrivning.",
    },
    "parallel_chapters": {"en": "Parallel chapters", "da": "Parallelle kapitler"},
    "parallel_help": {
        "en": "Process this many chapters concurrently. Helpful with small models on machines with spare RAM. With large 27B+ models, leave at 1.",
        "da": "Behandl så mange kapitler parallelt. Nyttigt med små modeller på maskiner med ekstra RAM. Med store 27B+ modeller, behold på 1.",
    },
    "style_guide": {"en": "Style guide", "da": "Stilguide"},
    "upload_style": {"en": "Upload style guide (optional)", "da": "Upload stilguide (valgfrit)"},
    "style_rules": {"en": "Style rules (preserved names, intentional choices)", "da": "Stilregler (navne, bevidste valg)"},
    # --- Step I ---
    "sec_manuscript": {"en": "Manuscript", "da": "Manuskript"},
    "upload_prompt": {"en": "Upload a .docx or .md to begin.", "da": "Upload en .docx eller .md for at starte."},
    "lbl_file": {"en": "file", "da": "fil"},
    "lbl_words": {"en": "words", "da": "ord"},
    "lbl_chapters": {"en": "chapters", "da": "kapitler"},
    "lbl_model": {"en": "model", "da": "model"},
    "converting": {"en": "Converting to Markdown...", "da": "Konverterer til Markdown..."},
    # --- Step II ---
    "sec_scope": {"en": "Scope", "da": "Omfang"},
    "whole_book": {"en": "Whole book", "da": "Hele bogen"},
    "selected_chapters": {"en": "Selected chapters", "da": "Udvalgte kapitler"},
    "first_n_words": {"en": "First N words", "da": "Første N ord"},
    "pick_chapters": {"en": "Pick chapters…", "da": "Vælg kapitler…"},
    "select_one": {"en": "Select at least one chapter to continue.", "da": "Vælg mindst ét kapitel for at fortsætte."},
    "words_selected": {"en": "words across", "da": "ord fordelt på"},
    "units": {"en": "unit(s)", "da": "enhed(er)"},
    "parallel_tag": {"en": "parallel", "da": "parallelt"},
    # --- Step III ---
    "sec_edit": {"en": "Edit", "da": "Rediger"},
    "btn_editing": {"en": "Editing in progress…", "da": "Redigering i gang…"},
    "btn_start": {"en": "Begin editing", "da": "Begynd redigering"},
    "starting": {"en": "Starting", "da": "Starter"},
    "in_parallel": {"en": "in parallel", "da": "parallelt"},
    "fast": {"en": "fast", "da": "hurtig"},
    "full_rewrite": {"en": "full-rewrite", "da": "fuld omskrivning"},
    "queued": {"en": "queued", "da": "i kø"},
    "editing": {"en": "editing", "da": "redigerer"},
    "done": {"en": "done", "da": "færdig"},
    "changes": {"en": "change(s)", "da": "rettelse(r)"},
    "units_complete": {"en": "unit(s) complete", "da": "enhed(er) færdige"},
    "min_elapsed": {"en": "min elapsed", "da": "min forløbet"},
    "finished": {"en": "Finished", "da": "Færdig"},
    "review_below": {"en": "review changes below.", "da": "gennemgå rettelser nedenfor."},
    # --- Step IV ---
    "sec_review": {"en": "Review & Export", "da": "Gennemgang & Eksport"},
    "accepted": {"en": "accepted", "da": "accepteret"},
    "no_changes": {"en": "no changes", "da": "ingen rettelser"},
    "accept_all": {"en": "Accept all", "da": "Acceptér alle"},
    "dismiss_all": {"en": "Dismiss all", "da": "Afvis alle"},
    "no_corrections_unit": {"en": "No corrections proposed for this unit.", "da": "Ingen rettelser foreslået for denne enhed."},
    "skipped_label": {"en": "skipped (markdown / ambiguity)", "da": "sprunget over (markdown / tvetydighed)"},
    "output_reflects": {"en": "Output reflects", "da": "Output afspejler"},
    "of": {"en": "of", "da": "af"},
    "proposed_changes": {"en": "proposed change(s).", "da": "foreslåede rettelse(r)."},
    "converting_docx": {"en": "Converting to DOCX…", "da": "Konverterer til DOCX…"},
    "docx_fail": {"en": "DOCX conversion failed", "da": "DOCX-konvertering mislykkedes"},
    "preview_md": {"en": "Preview edited Markdown", "da": "Forhåndsvisning af redigeret Markdown"},
    "btn_cancel": {"en": "Cancel editing", "da": "Annullér redigering"},
    "locked_notice": {"en": "Editing in progress — settings locked.", "da": "Redigering i gang — indstillinger låst."},
}


def t(key: str) -> str:
    """Translate a string key to the active language."""
    lang = st.session_state.get("lang", "en")
    entry = TRANSLATIONS.get(key)
    if entry is None:
        return key
    return entry.get(lang, entry.get("en", key))


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# Sentinel inserted into docx-derived markdown wherever the source had a
# hard page break. We treat these as the highest-priority chapter boundary,
# since most authors put one at the start of every chapter.
PAGEBREAK_MARKER = "<!-- PAGEBREAK -->"

# Multilingual chapter words — extend this list to support more languages.
# Each word should be the bare noun used to introduce a chapter (no article).
CHAPTER_WORDS = (
    # English
    "chapter", "part",
    # Danish / Norwegian / Swedish
    "kapitel", "kapittel", "del",
    # German
    "kapitel",
    # Spanish
    "capítulo", "capitulo", "parte",
    # French
    "chapitre", "partie",
    # Italian
    "capitolo",
    # Portuguese
    "capítulo",
    # Dutch
    "hoofdstuk",
)
_CHAPTER_WORD_GROUP = "|".join(sorted(set(CHAPTER_WORDS), key=len, reverse=True))

# Multilingual front/back-matter section names.
SPECIAL_SECTIONS = (
    # English
    "prologue", "epilogue", "interlude", "afterword", "foreword",
    "preface", "introduction", "appendix",
    # Danish
    "prolog", "epilog", "forord", "efterord", "indledning", "appendiks",
    # German
    "prolog", "epilog", "vorwort", "nachwort", "einleitung",
    # Spanish / Portuguese
    "prólogo", "epílogo", "prefacio", "introducción", "apéndice",
    # French
    "préface", "introduction", "annexe",
    # Italian
    "prologo", "epilogo", "prefazione", "introduzione", "appendice",
    # Dutch
    "proloog", "epiloog", "voorwoord", "nawoord", "inleiding",
)
_SPECIAL_GROUP = "|".join(sorted(set(SPECIAL_SECTIONS), key=len, reverse=True))


def _clean_title(s: str) -> str:
    """Strip markdown formatting (bold/italic markers, heading hashes) from a chapter title."""
    s = s.strip()
    s = re.sub(r'^[*_]{1,3}\s*', '', s)
    s = re.sub(r'\s*[*_]{1,3}$', '', s)
    s = s.lstrip('# ')
    return s.strip()


# Multiple patterns to detect chapter/section boundaries in various formats.
# Tried in order; first one with enough matches wins.
CHAPTER_PATTERNS = [
    # Hard page breaks pulled from the source DOCX (highest priority).
    re.compile(r"(?m)^\s*" + re.escape(PAGEBREAK_MARKER) + r"\s*$"),
    # Markdown headings: # Title or ## Title
    re.compile(r"(?m)^(#{1,2})\s+(.+)$"),
    # "Chapter 1" / "Kapitel 3" / "Capítulo IV" — multilingual, number required.
    # Allows optional bold/italic markers: **Kapitel 2**, *Chapter 3*, etc.
    # Uses [ \t] (not \s) to prevent crossing line boundaries.
    re.compile(r"(?mi)^[ \t]*[*_]{0,3}[ \t]*((?:" + _CHAPTER_WORD_GROUP + r")[ \t]+[\dIVXLCivxlc]+[.:—–-]?[^\n]*?)[ \t]*[*_]{0,3}[ \t]*$"),
    # "Chapter" / "Kapitel" on a line — with or without a number,
    # optionally followed by a short title.  Allows bold/italic wrapping.
    re.compile(r"(?mi)^[ \t]*[*_]{0,3}[ \t]*((?:" + _CHAPTER_WORD_GROUP + r")(?:[ \t]+\S[^\n]*?)?)[ \t]*[*_]{0,3}[ \t]*$"),
    # Front/back-matter sections (multilingual)
    re.compile(r"(?mi)^\s*((?:" + _SPECIAL_GROUP + r")\s*[.:—–-]?\s*.*?)$"),
    # ALL-CAPS lines of 3+ words (common in manuscripts: "THE FIRST DAWN")
    re.compile(r"(?m)^\s*([A-ZÆØÅÄÖÜÉÈÊÁÀÂÍÓÚÑÇ][A-ZÆØÅÄÖÜÉÈÊÁÀÂÍÓÚÑÇ ]{6,})$"),
    # Bold lines used as section breaks: **Chapter Title** or __Title__
    re.compile(r"(?m)^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$"),
    # Numbered sections: "1.", "1 -", "I."
    re.compile(r"(?m)^\s*(\d{1,3}[.)]\s+.+)$"),
]


def extract_pagebreaks_from_docx(docx_bytes: bytes) -> list[int]:
    """Return the indices of paragraphs that follow a hard page break.

    Reads ``word/document.xml`` from the docx zip and locates
    ``<w:br w:type="page"/>`` elements. Returns 0-based paragraph indices
    where each break occurs (the paragraph CONTAINING the page break, which
    in practice is the first paragraph of the new page in most authoring
    tools).

    Returns an empty list if the docx can't be parsed or has no page breaks.
    """
    import zipfile
    import xml.etree.ElementTree as ET

    try:
        with zipfile.ZipFile(io.BytesIO(docx_bytes)) as z:
            with z.open("word/document.xml") as f:
                xml_data = f.read()
    except (KeyError, zipfile.BadZipFile):
        return []

    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError:
        return []

    body = root.find(ns + "body")
    if body is None:
        return []

    breaks: list[int] = []
    p_index = 0
    for child in body:
        if not child.tag.endswith("}p"):
            continue
        found_break = False
        # Detect <w:br w:type="page"/> (explicit page break runs).
        for br in child.iter(ns + "br"):
            if br.get(ns + "type") == "page":
                found_break = True
                break
        # Detect page-break-before in paragraph properties:
        #   <w:pPr><w:pageBreakBefore/></w:pPr>
        # or in the paragraph's style-inherited properties.
        if not found_break:
            ppr = child.find(ns + "pPr")
            if ppr is not None:
                pbb = ppr.find(ns + "pageBreakBefore")
                if pbb is not None:
                    # Only counts if val is absent or "1" / "true".
                    val = pbb.get(ns + "val", "true")
                    if val.lower() in ("true", "1", "on"):
                        found_break = True
                # Also detect <w:sectPr> with a page-type break.
                if not found_break:
                    sect = ppr.find(ns + "sectPr")
                    if sect is not None:
                        br_type = sect.find(ns + "type")
                        if br_type is not None and br_type.get(ns + "val") in ("nextPage", "oddPage", "evenPage"):
                            found_break = True
        if found_break:
            breaks.append(p_index)
        p_index += 1
    return breaks


def docx_to_markdown(docx_bytes: bytes) -> str:
    """Convert uploaded DOCX bytes to Markdown via pandoc.

    Page breaks from the source DOCX are preserved by inserting
    ``<!-- PAGEBREAK -->`` sentinels into the resulting Markdown, which the
    chapter detector treats as the highest-priority chapter boundary.
    """
    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f_in:
        f_in.write(docx_bytes)
        in_path = Path(f_in.name)
    out_path = in_path.with_suffix(".md")
    subprocess.run(
        ["pandoc", str(in_path), "-f", "docx", "-t", "markdown",
         "-o", str(out_path), "--wrap=none"],
        check=True,
    )
    text = out_path.read_text(encoding="utf-8")
    in_path.unlink(missing_ok=True)
    out_path.unlink(missing_ok=True)

    # Re-inject page-break sentinels using paragraph indices from the DOCX XML.
    page_break_paras = extract_pagebreaks_from_docx(docx_bytes)
    if page_break_paras:
        # Pandoc's markdown separates paragraphs with blank lines. Splitting
        # on blank-line runs gives us a sequence of "blocks" that lines up
        # with DOCX paragraph order well enough for chapter detection.
        blocks = re.split(r"\n\s*\n", text)
        break_set = set(page_break_paras)
        out_blocks: list[str] = []
        for i, block in enumerate(blocks):
            if i in break_set and i > 0:
                out_blocks.append(PAGEBREAK_MARKER)
            out_blocks.append(block)
        text = "\n\n".join(out_blocks)
    return text


def markdown_to_docx(md_text: str) -> bytes:
    """Convert Markdown text to DOCX bytes via pandoc."""
    with tempfile.NamedTemporaryFile(suffix=".md", delete=False, mode="w", encoding="utf-8") as f_in:
        f_in.write(md_text)
        in_path = Path(f_in.name)
    out_path = in_path.with_suffix(".docx")
    subprocess.run(
        ["pandoc", str(in_path), "-f", "markdown", "-t", "docx",
         "-o", str(out_path), "--standalone"],
        check=True,
    )
    data = out_path.read_bytes()
    in_path.unlink(missing_ok=True)
    out_path.unlink(missing_ok=True)
    return data


def find_chapters(text: str) -> list[dict]:
    """Detect chapters/sections using multiple heading patterns.

    Tries each pattern in CHAPTER_PATTERNS and uses the first one that
    produces results. Falls back to scanning for lines that look like
    scene/section breaks (e.g. '***', '---', blank-line-surrounded short lines).
    """
    for pattern in CHAPTER_PATTERNS:
        matches = list(pattern.finditer(text))
        # Drop matches whose full match is suspiciously long (>100 chars) — these
        # are probably mid-paragraph false positives from the broad "Kapitel" pattern.
        matches = [m for m in matches if len(m.group(0).strip()) <= 120]
        # Filter out tiny noise matches — require at least 2 "chapters" found,
        # or exactly 1 that isn't the very first line (i.e. a clear heading).
        if len(matches) >= 2 or (len(matches) == 1 and matches[0].start() > 0):
            chapters = []
            for i, m in enumerate(matches):
                start = m.start()
                end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
                # Use last non-empty group as title.
                raw_title = next(
                    (g for g in reversed(m.groups()) if g and g.strip()),
                    m.group(0),
                )
                # If the boundary is a page-break sentinel, use the first
                # non-empty line of the resulting section as the title.
                if PAGEBREAK_MARKER in raw_title:
                    section_text = text[m.end():end]
                    first_line = next(
                        (ln.strip() for ln in section_text.splitlines() if ln.strip()),
                        f"Section {i + 1}",
                    )
                    title = _clean_title(first_line[:80])
                else:
                    title = _clean_title(raw_title)
                chapters.append({
                    "title": title,
                    "level": 1,
                    "start": start,
                    "end": end,
                    "word_count": len(text[start:end].split()),
                })
            return chapters

    # Last resort: split on scene-break markers (***, ---, ___)
    break_re = re.compile(r"(?m)^\s*(?:\*\s*\*\s*\*|---+|___+)\s*$")
    matches = list(break_re.finditer(text))
    if len(matches) >= 2:
        chapters = []
        boundaries = [0] + [m.end() for m in matches] + [len(text)]
        for i in range(len(boundaries) - 1):
            start, end = boundaries[i], boundaries[i + 1]
            section = text[start:end].strip()
            if not section:
                continue
            first_line = section.splitlines()[0][:60].strip() or f"Section {i + 1}"
            chapters.append({
                "title": first_line,
                "level": 1,
                "start": start,
                "end": end,
                "word_count": len(section.split()),
            })
        if chapters:
            return chapters

    return []


def list_ollama_models() -> list[str]:
    """Best-effort list of locally available models."""
    try:
        result = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, check=True, timeout=5
        )
        lines = result.stdout.strip().splitlines()[1:]  # skip header
        return [line.split()[0] for line in lines if line.strip()]
    except Exception:
        return []


# --------------------------------------------------------------------------
# Inline word-level colored diff
# --------------------------------------------------------------------------

import difflib  # noqa: E402
import html as _html  # noqa: E402


def _tokenize_for_diff(s: str) -> list[str]:
    """Split into words + whitespace + punctuation, preserving everything."""
    return re.findall(r"\s+|\w+|[^\w\s]", s)


def inline_word_diff_html(before: str, after: str) -> str:
    """Render a single before/after pair as inline HTML with word-level
    deletions struck through in red and insertions highlighted in green."""
    a = _tokenize_for_diff(before)
    b = _tokenize_for_diff(after)
    matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    parts: list[str] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            parts.append(_html.escape("".join(a[i1:i2])))
        elif tag == "delete":
            parts.append(f'<span class="word-del">{_html.escape("".join(a[i1:i2]))}</span>')
        elif tag == "insert":
            parts.append(f'<span class="word-ins">{_html.escape("".join(b[j1:j2]))}</span>')
        elif tag == "replace":
            parts.append(f'<span class="word-del">{_html.escape("".join(a[i1:i2]))}</span>')
            parts.append(f'<span class="word-ins">{_html.escape("".join(b[j1:j2]))}</span>')
    return "".join(parts)


def render_correction_card(original: str, corrected: str, label: str = "") -> str:
    """Render a single correction as a card with inline word-level diff."""
    diff_html = inline_word_diff_html(original, corrected)
    label_html = (
        f'<div style="font-size:0.75rem; color:#64748b; margin-bottom:0.25rem;">{_html.escape(label)}</div>'
        if label else ""
    )
    return (
        '<div class="correction-card">'
        + label_html
        + f'<div class="correction-diff">{diff_html}</div>'
        + '</div>'
    )


# --------------------------------------------------------------------------
# Page setup
# --------------------------------------------------------------------------

st.set_page_config(
    page_title="Bethaniel Editor",
    page_icon="📖",
    layout="wide",
    initial_sidebar_state="expanded",
)

# --- Custom CSS — literature-inspired: cream paper, ink, serif ----------
st.markdown("""
<style>
    /* Import a literary serif for headings/body and a refined sans for UI chrome */
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

    /* Page palette: aged paper + ink */
    .stApp {
        background: #f7f1e3;
        background-image:
            radial-gradient(ellipse at top, #faf5e6 0%, #f7f1e3 60%, #f0e8d4 100%);
    }
    .block-container {
        padding-top: 1.25rem;
        padding-bottom: 2.5rem;
        max-width: 1280px;
    }
    /* Body / UI font */
    html, body, [class*="css"] {
        font-family: 'Inter', -apple-system, system-ui, sans-serif;
        color: #2a2419;
    }
    /* Headings in serif */
    h1, h2, h3, h4 { font-family: 'Cormorant Garamond', Georgia, serif !important;
                     font-weight: 600; letter-spacing: 0; color: #1a140a; }

    /* ---------- Header (masthead) ---------- */
    .masthead {
        text-align: center;
        padding: 0.5rem 0 1.25rem 0;
        border-bottom: 1px solid #c9b896;
        margin-bottom: 1.25rem;
    }
    .masthead .title {
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-size: 2.4rem; font-weight: 700;
        color: #1a140a;
        letter-spacing: 0.02em;
        line-height: 1.1;
        margin: 0;
    }
    .masthead .subtitle {
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-style: italic;
        font-size: 1.05rem;
        color: #6b5c44;
        margin: 0.25rem 0 0 0;
        letter-spacing: 0.04em;
    }
    .masthead .rule {
        width: 60px; height: 1px;
        background: #8b7355;
        margin: 0.6rem auto 0 auto;
    }

    /* ---------- Compact info chip rows (steps 1 & 2) ---------- */
    .chip-row {
        display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem;
        align-items: center;
        background: #fdfaf0;
        border: 1px solid #d9c9a8;
        border-radius: 4px;
        padding: 0.55rem 0.9rem;
        margin: 0.35rem 0 0.75rem 0;
        font-size: 0.9rem;
    }
    .chip-row .label {
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-style: italic;
        color: #8b7355;
        font-size: 0.95rem;
        margin-right: 0.25rem;
    }
    .chip-row .value {
        font-weight: 600;
        color: #1a140a;
    }
    .chip-row .sep {
        color: #c9b896; margin: 0 0.4rem;
    }

    /* Section label — small caps roman numeral style */
    .section-label {
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-size: 0.78rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        color: #8b7355;
        margin: 0.75rem 0 0.25rem 0;
    }
    .section-label .num {
        color: #b8915a; margin-right: 0.4rem;
    }

    /* ---------- Compact controls inside chip-row area ---------- */
    /* Tighten Streamlit's default radio/file uploader so they feel chip-like */
    div[data-testid="stFileUploader"] {
        background: #fdfaf0;
        border: 1px dashed #c9b896;
        border-radius: 4px;
        padding: 0.5rem 0.75rem;
    }
    div[data-testid="stFileUploader"] section { padding: 0.25rem 0; }
    div[data-testid="stFileUploader"] small { color: #8b7355; }

    div[data-testid="stRadio"] > label { display: none; }   /* hide "Scope" label */
    div[data-testid="stRadio"] [role="radiogroup"] {
        gap: 0.4rem !important;
    }
    div[data-testid="stRadio"] label {
        background: #fdfaf0;
        border: 1px solid #d9c9a8;
        border-radius: 4px;
        padding: 0.3rem 0.75rem;
        font-size: 0.88rem;
        cursor: pointer;
    }

    /* ---------- Primary button: ink-stamp style ---------- */
    .stButton > button[kind="primary"] {
        background: #1a140a;
        color: #f7f1e3 !important;
        border: 1px solid #1a140a;
        border-radius: 2px;
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-weight: 600;
        font-size: 1.1rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        padding: 0.65rem 1.5rem;
        transition: all 0.15s;
        box-shadow: 2px 2px 0 #c9b896;
    }
    .stButton > button[kind="primary"]:hover {
        background: #3d2f1a;
        transform: translate(-1px, -1px);
        box-shadow: 3px 3px 0 #b8915a;
    }
    .stButton > button[kind="primary"]:disabled {
        opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none;
    }

    /* ---------- Live stream panel: typewriter on parchment ---------- */
    .stream-panel {
        background: #fdfaf0;
        color: #2a2419;
        padding: 0.85rem 1rem;
        border: 1px solid #d9c9a8;
        border-left: 3px solid #8b7355;
        border-radius: 2px;
        font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
        font-size: 0.82rem; line-height: 1.55;
        max-height: 360px; overflow-y: auto;
        white-space: pre-wrap; word-wrap: break-word;
    }

    /* ---------- Word-level diff: red/green inks ---------- */
    .word-ins {
        background: #d4e3c5; color: #2d4a1a;
        padding: 1px 4px; border-radius: 2px;
        font-weight: 600;
    }
    .word-del {
        background: #e8c5c0; color: #6b1f1a;
        padding: 1px 4px; border-radius: 2px;
        text-decoration: line-through;
        opacity: 0.85;
    }
    .correction-card {
        background: #fdfaf0;
        border: 1px solid #d9c9a8;
        border-left: 3px solid #8b7355;
        border-radius: 2px;
        padding: 0.55rem 0.85rem;
        margin: 0.35rem 0;
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-size: 1.05rem;
        line-height: 1.5;
        color: #2a2419;
    }
    .correction-card .word-ins,
    .correction-card .word-del { font-family: 'Cormorant Garamond', Georgia, serif; }
    .correction-diff { white-space: pre-wrap; word-wrap: break-word; }
    .correction-empty {
        color: #8b7355; font-style: italic;
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-size: 1rem;
        padding: 0.4rem 0;
    }

    /* ---------- Metric cards: subtle, paper-toned ---------- */
    [data-testid="stMetric"] {
        background: #fdfaf0;
        border: 1px solid #d9c9a8;
        border-radius: 2px;
        padding: 0.65rem 0.9rem;
    }
    [data-testid="stMetric"] label { color: #8b7355 !important; font-size: 0.75rem !important;
                                      text-transform: uppercase; letter-spacing: 0.1em; }
    [data-testid="stMetricValue"] {
        font-family: 'Cormorant Garamond', Georgia, serif !important;
        font-size: 1.5rem !important; color: #1a140a !important;
    }

    /* Caption styling — small italic in ink-brown */
    .small-note {
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-style: italic;
        color: #8b7355;
        font-size: 0.95rem;
        margin: 0.15rem 0 0.5rem 0;
    }

    /* Sidebar a touch lighter */
    section[data-testid="stSidebar"] {
        background: #efe6d0;
        border-right: 1px solid #c9b896;
    }
    section[data-testid="stSidebar"] h2 {
        font-family: 'Cormorant Garamond', Georgia, serif;
        font-size: 1.3rem;
    }

    /* Hide deploy button etc. */
    .stDeployButton, footer, header[data-testid="stHeader"] { display: none; }
</style>
""", unsafe_allow_html=True)

st.markdown(
    f'<div class="masthead">'
    f'<div class="title">Bethaniel</div>'
    f'<div class="subtitle">{t("subtitle")}</div>'
    f'<div class="rule"></div>'
    f'</div>',
    unsafe_allow_html=True,
)


def section_label(num: str, title: str) -> None:
    st.markdown(
        f'<div class="section-label"><span class="num">{num}.</span>{title}</div>',
        unsafe_allow_html=True,
    )

# --------------------------------------------------------------------------
# Sidebar — model + style guide settings (collapsed)
# --------------------------------------------------------------------------

with st.sidebar:
    # Language selector at top, always visible.
    if "lang" not in st.session_state:
        st.session_state["lang"] = "en"
    lang_options = {"English": "en", "Dansk": "da"}
    lang_label = st.radio(
        t("language"),
        options=list(lang_options.keys()),
        horizontal=True,
        index=0 if st.session_state["lang"] == "en" else 1,
    )
    new_lang = lang_options[lang_label]
    if new_lang != st.session_state.get("lang"):
        st.session_state["lang"] = new_lang
        st.rerun()

    with st.expander(t("settings"), expanded=False):
        available_models = list_ollama_models()
        if available_models:
            default_idx = 0
            for preferred in ("qwen3:32b", "qwen3:14b", "gemma4:27b", "betty"):
                if preferred in available_models:
                    default_idx = available_models.index(preferred)
                    break
            model = st.selectbox(t("model"), available_models, index=default_idx)
        else:
            model = st.text_input(t("model"), value="qwen3:32b", help=t("model_help"))

        words_per_chunk = st.slider(t("words_per_chunk"), 1000, 5000, 2500, step=250)
        overlap_paragraphs = st.slider(t("paragraph_overlap"), 0, 3, 1)

        fast_mode = st.toggle(t("fast_mode"), value=True, help=t("fast_mode_help"))

        parallel_chapters = st.slider(
            t("parallel_chapters"), min_value=1, max_value=4, value=1,
            help=t("parallel_help"),
        )

    with st.expander(t("style_guide"), expanded=False):
        # Load default style.md from disk.
        default_style = SCRIPT_DIR.parent / "style.md"
        if "style_text" not in st.session_state:
            if default_style.exists():
                st.session_state["style_text"] = default_style.read_text(encoding="utf-8")
            else:
                st.session_state["style_text"] = ""

        # Allow uploading a style guide (.md, .txt, or .docx).
        style_upload = st.file_uploader(
            t("upload_style"),
            type=["md", "txt", "docx"],
            key="style_uploader",
        )
        if style_upload is not None:
            if style_upload.name.lower().endswith(".docx"):
                try:
                    st.session_state["style_text"] = docx_to_markdown(style_upload.getvalue())
                    st.caption(f"Loaded from DOCX: `{style_upload.name}`")
                except Exception as exc:
                    st.error(f"Could not convert style DOCX: {exc}")
            else:
                st.session_state["style_text"] = style_upload.getvalue().decode("utf-8")
                st.caption(f"Loaded from: `{style_upload.name}`")
        elif default_style.exists():
            st.caption(f"Loaded from `{default_style.relative_to(SCRIPT_DIR.parent)}`")

        style_text = st.text_area(
            t("style_rules"),
            value=st.session_state["style_text"],
            height=200,
        )
        st.session_state["style_text"] = style_text


# --------------------------------------------------------------------------
# Step 1 — Upload (compact)
# --------------------------------------------------------------------------

section_label("I", t("sec_manuscript"))
uploaded = st.file_uploader(
    t("sec_manuscript"),
    type=["docx", "md", "markdown"],
    label_visibility="collapsed",
)

if uploaded is None:
    st.markdown(
        f'<div class="small-note">{t("upload_prompt")}</div>',
        unsafe_allow_html=True,
    )
    st.stop()

# Cache the converted markdown in session state so re-renders don't re-convert.
if (st.session_state.get("uploaded_name") != uploaded.name
        or st.session_state.get("uploaded_size") != uploaded.size):
    with st.spinner(t("converting")):
        if uploaded.name.lower().endswith(".docx"):
            md_text = docx_to_markdown(uploaded.getvalue())
        else:
            md_text = uploaded.getvalue().decode("utf-8")
    st.session_state["md_text"] = md_text
    st.session_state["uploaded_name"] = uploaded.name
    st.session_state["uploaded_size"] = uploaded.size
    st.session_state.pop("result_md", None)
    st.session_state.pop("result_diff", None)

md_text: str = st.session_state["md_text"]
chapters = find_chapters(md_text)
total_words = len(md_text.split())

# Compact one-line summary instead of three big metric cards.
import html as _h_summary
st.markdown(
    '<div class="chip-row">'
    f'<span class="label">{t("lbl_file")}</span><span class="value">{_h_summary.escape(uploaded.name)}</span>'
    '<span class="sep">·</span>'
    f'<span class="label">{t("lbl_words")}</span><span class="value">{total_words:,}</span>'
    '<span class="sep">·</span>'
    f'<span class="label">{t("lbl_chapters")}</span><span class="value">{len(chapters)}</span>'
    '<span class="sep">·</span>'
    f'<span class="label">{t("lbl_model")}</span><span class="value">{_h_summary.escape(model)}</span>'
    '</div>',
    unsafe_allow_html=True,
)

# Whether an editing run is active or results already exist — used to lock inputs.
running = st.session_state.get("is_running", False)
has_results = st.session_state.get("results") is not None
locked = running or has_results


# --------------------------------------------------------------------------
# Step 2 — Pick what to edit (compact, single row)
# --------------------------------------------------------------------------

section_label("II", t("sec_scope"))

scope_options = [t("whole_book"), t("first_n_words")]
if chapters:
    scope_options.insert(1, t("selected_chapters"))

# Radio + (optional) chapter picker / slider on a single row.
scope_col, picker_col = st.columns([1, 2])
with scope_col:
    mode = st.radio("Scope", scope_options, horizontal=True, label_visibility="collapsed",
                    disabled=locked)

with picker_col:
    if mode == t("selected_chapters") and chapters:
        chapter_labels = [f"Ch.{i+1}: {c['title']}  ({c['word_count']:,} w)"
                          for i, c in enumerate(chapters)]
        selected_indices = st.multiselect(
            "Chapters",
            options=list(range(len(chapters))),
            format_func=lambda i: chapter_labels[i],
            default=[0],
            label_visibility="collapsed",
            placeholder=t("pick_chapters"),
            disabled=locked,
        )
        if not selected_indices and not locked:
            st.markdown(
                f'<div class="small-note">{t("select_one")}</div>',
                unsafe_allow_html=True,
            )
            st.stop()
        units = [
            {
                "name": f"Ch.{i+1}: {chapters[i]['title']}",
                "original": (
                    md_text[chapters[i]["start"]:chapters[i]["end"]]
                    .replace(PAGEBREAK_MARKER, "")
                    .strip()
                ),
            }
            for i in selected_indices
        ]
    elif mode == t("first_n_words"):
        max_words = total_words
        default_n = min(5000, max_words)
        n_words = st.slider("Words", 500, max_words, default_n, step=500,
                            label_visibility="collapsed", disabled=locked)
        words = md_text.split()
        if n_words >= len(words):
            text_to_edit = md_text
        else:
            rough_cut = " ".join(words[:n_words])
            cut_pos = len(rough_cut)
            next_break = md_text.find("\n\n", cut_pos)
            if next_break != -1 and next_break - cut_pos < 2000:
                text_to_edit = md_text[:next_break]
            else:
                text_to_edit = rough_cut
        units = [{"name": f"{t('first_n_words')}: {n_words:,}", "original": text_to_edit.strip()}]
    else:
        units = [{"name": t("sec_manuscript"), "original": md_text.strip()}]

text_to_edit = "\n\n".join(u["original"] for u in units)
editing_words = len(text_to_edit.split())
parallel_note = f" · ⚡ {parallel_chapters}× {t('parallel_tag')}" if parallel_chapters > 1 and len(units) > 1 else ""
if not locked:
    st.markdown(
        f'<div class="small-note">~ {editing_words:,} {t("words_selected")} {len(units)} {t("units")}{parallel_note}.</div>',
        unsafe_allow_html=True,
    )


# --------------------------------------------------------------------------
# Step 3 — Run
# --------------------------------------------------------------------------

section_label("III", t("sec_edit"))

start_clicked = False
if running:
    # Show cancel button while editing is in progress.
    if st.button(t("btn_cancel"), type="primary", use_container_width=True):
        st.session_state["is_running"] = False
        st.session_state.pop("run_units", None)
        st.rerun()
else:
    start_clicked = st.button(
        t("btn_start"),
        type="primary",
        use_container_width=True,
        disabled=has_results,  # must reset before re-running
    )

# Per-unit progress slots are created during the run. Header above them.
overall_status = st.empty()
progress_area = st.container()

if start_clicked:
    st.session_state["is_running"] = True
    st.session_state["run_units"] = units  # freeze scope for this run
    # Clear any previous results / accept-state so we re-run fresh.
    for k in list(st.session_state.keys()):
        if k.startswith("chk_") or k.startswith("acc_") or k.startswith("dis_"):
            del st.session_state[k]
    st.session_state.pop("results", None)
    st.session_state.pop("docx_cache", None)
    st.session_state.pop("docx_for_md", None)
    st.rerun()

# --------------------------------------------------------------------------
# The actual run — concurrent chapters via ThreadPoolExecutor
# --------------------------------------------------------------------------
if st.session_state.get("is_running") and not st.session_state.get("results"):
    # Use the frozen units from when editing was started.
    run_units = st.session_state.get("run_units", units)

    if fast_mode:
        system_prompt = build_corrections_system_prompt(style_text or None)
    else:
        system_prompt = build_system_prompt(style_text or None)

    # Build per-unit UI placeholders up front so workers update consistent slots.
    slots: list[dict] = []
    with progress_area:
        for u in run_units:
            row = st.container()
            with row:
                cols = st.columns([3, 1])
                slots.append({
                    "label": cols[0].empty(),
                    "bar":   cols[0].empty(),
                    "stats": cols[1].empty(),
                })

    for idx, u in enumerate(run_units):
        slots[idx]["label"].markdown(
            f'<div class="section-label" style="margin:0.5rem 0 0.15rem 0;">'
            f'{_html.escape(u["name"])} <span style="color:#b8915a;">· {t("queued")}</span></div>',
            unsafe_allow_html=True,
        )
        slots[idx]["bar"].progress(0.0)
        slots[idx]["stats"].markdown(
            f'<div class="small-note" style="text-align:right;">{len(u["original"].split()):,} {t("lbl_words")}</div>',
            unsafe_allow_html=True,
        )

    event_q: queue.Queue = queue.Queue()

    def _process_unit(idx: int, unit: dict) -> dict:
        """Worker — runs entirely off the main thread. No Streamlit calls."""
        try:
            chunks = split_into_chunks(unit["original"], words_per_chunk, overlap_paragraphs)
            edited_pieces: list[str] = []
            corrections: list[dict] = []
            skipped: list[dict] = []
            errors: list[str] = []
            t0 = time.time()
            for j, chunk in enumerate(chunks, 1):
                accumulated = ""
                try:
                    if fast_mode:
                        for tok in find_corrections_stream(model, chunk["body"], system_prompt):
                            accumulated += tok
                        cs = parse_corrections_json(accumulated)
                        new_body, applied, sk = apply_corrections(chunk["body"], cs)
                        edited_core = strip_overlap_from_response(
                            new_body, chunk["overlap_head_paragraphs"]
                        )
                        for c in applied:
                            corrections.append({
                                **c,
                                "chunk": f"Chunk {j}/{len(chunks)}",
                                "id": uuid.uuid4().hex,
                            })
                        skipped.extend({**s, "chunk": f"Chunk {j}/{len(chunks)}"} for s in sk)
                    else:
                        for tok in edit_chunk_stream(model, chunk["body"], system_prompt):
                            accumulated += tok
                        edited_core = strip_overlap_from_response(
                            accumulated.strip(), chunk["overlap_head_paragraphs"]
                        )
                except Exception as exc:
                    edited_core = chunk["core"]
                    errors.append(f"chunk {j}: {exc}")
                edited_pieces.append(edited_core)
                event_q.put((idx, "progress", j / len(chunks)))
            return {
                "edited_text": "\n\n".join(edited_pieces).strip(),
                "corrections": corrections,
                "skipped": skipped,
                "errors": errors,
                "elapsed": time.time() - t0,
            }
        except Exception as exc:
            return {
                "edited_text": unit["original"],
                "corrections": [],
                "skipped": [],
                "errors": [f"fatal: {exc}"],
                "elapsed": 0.0,
            }

    overall_start = time.time()
    n_units = len(run_units)
    overall_status.markdown(
        f'<div class="small-note">{t("starting")} · {n_units} {t("units")} · {parallel_chapters} {t("in_parallel")} · '
        f'{t("fast") if fast_mode else t("full_rewrite")}</div>',
        unsafe_allow_html=True,
    )

    results_by_idx: dict[int, dict] = {}
    workers = max(1, min(parallel_chapters, n_units))

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_process_unit, idx, u): idx for idx, u in enumerate(run_units)}
        # Mark started slots as the executor picks them up — done lazily
        # by flipping the label to "editing" on first progress event.
        active_started: set[int] = set()
        while True:
            done_count = sum(1 for f in futures if f.done())
            try:
                idx, kind, payload = event_q.get(timeout=0.25)
            except queue.Empty:
                if done_count == n_units and event_q.empty():
                    break
                continue

            if kind == "progress":
                if idx not in active_started:
                    active_started.add(idx)
                    slots[idx]["label"].markdown(
                        f'<div class="section-label" style="margin:0.5rem 0 0.15rem 0;">'
                        f'{_html.escape(run_units[idx]["name"])} '
                        f'<span style="color:#3d6b3d;">· {t("editing")}</span></div>',
                        unsafe_allow_html=True,
                    )
                slots[idx]["bar"].progress(payload, text=f"{int(payload * 100)}%")

            done_count = sum(1 for f in futures if f.done())
            overall_status.markdown(
                f'<div class="small-note">{done_count}/{n_units} {t("units_complete")} · '
                f'{(time.time() - overall_start)/60:.1f} {t("min_elapsed")}</div>',
                unsafe_allow_html=True,
            )

        # Collect results
        for fut, idx in futures.items():
            try:
                results_by_idx[idx] = fut.result()
            except Exception as exc:
                results_by_idx[idx] = {
                    "edited_text": run_units[idx]["original"],
                    "corrections": [], "skipped": [], "errors": [str(exc)], "elapsed": 0.0,
                }
            slots[idx]["bar"].progress(1.0, text="100%")
            r = results_by_idx[idx]
            slots[idx]["label"].markdown(
                f'<div class="section-label" style="margin:0.5rem 0 0.15rem 0;">'
                f'{_html.escape(run_units[idx]["name"])} '
                f'<span style="color:#3d6b3d;">· {t("done")}</span></div>',
                unsafe_allow_html=True,
            )
            slots[idx]["stats"].markdown(
                f'<div class="small-note" style="text-align:right;">'
                f'{len(r["corrections"])} {t("changes")} · {r["elapsed"]:.1f}s</div>',
                unsafe_allow_html=True,
            )

    # Persist for review.
    results = []
    for idx, u in enumerate(run_units):
        r = results_by_idx[idx]
        results.append({**u, **r})
    st.session_state["results"] = results
    st.session_state["is_running"] = False
    st.session_state.pop("run_units", None)
    total_elapsed = time.time() - overall_start
    overall_status.success(
        f"{t('finished')} {n_units} {t('units')} — {total_elapsed/60:.1f} min · {t('review_below')}"
    )
    st.rerun()


# --------------------------------------------------------------------------
# Step 4 — Per-chapter review with accept/dismiss
# --------------------------------------------------------------------------

results = st.session_state.get("results")
if results:
    section_label("IV", t("sec_review"))
    base = Path(uploaded.name).stem

    # ----- Per-chapter accept/dismiss UI -----
    for idx, unit in enumerate(results):
        # Live count from current checkbox state.
        n_corr = len(unit["corrections"])
        n_acc = sum(
            1 for c in unit["corrections"]
            if st.session_state.get(f"chk_{idx}_{c['id']}", True)
        )

        # Header style: green if all accepted, amber if mixed, grey if none
        if n_corr == 0:
            badge = t("no_changes")
        else:
            badge = f"{n_acc}/{n_corr} {t('accepted')}"

        with st.expander(f"{unit['name']} — {badge}", expanded=False):
            if unit.get("errors"):
                for e in unit["errors"]:
                    st.markdown(
                        f"<div style='color:#7f1d1d; font-size:0.85rem;'>⚠️ {_html.escape(e)}</div>",
                        unsafe_allow_html=True,
                    )

            if not unit["corrections"]:
                st.markdown(
                    f'<div class="correction-empty">{t("no_corrections_unit")}</div>',
                    unsafe_allow_html=True,
                )
            else:
                btn_cols = st.columns([1, 1, 6])
                if btn_cols[0].button(t("accept_all"), key=f"acc_{idx}"):
                    for c in unit["corrections"]:
                        st.session_state[f"chk_{idx}_{c['id']}"] = True
                    st.rerun()
                if btn_cols[1].button(t("dismiss_all"), key=f"dis_{idx}"):
                    for c in unit["corrections"]:
                        st.session_state[f"chk_{idx}_{c['id']}"] = False
                    st.rerun()

                for c in unit["corrections"]:
                    key = f"chk_{idx}_{c['id']}"
                    if key not in st.session_state:
                        st.session_state[key] = True
                    chk_col, card_col = st.columns([0.06, 0.94])
                    with chk_col:
                        st.checkbox(
                            "accept",
                            key=key,
                            label_visibility="collapsed",
                        )
                    with card_col:
                        st.markdown(
                            render_correction_card(
                                c["original"], c["corrected"], c.get("chunk", "")
                            ),
                            unsafe_allow_html=True,
                        )

            if unit.get("skipped"):
                with st.expander(
                    f"⚠️ {len(unit['skipped'])} {t('skipped_label')}",
                    expanded=False,
                ):
                    for s in unit["skipped"][:50]:
                        st.markdown(
                            "<div style='font-size:0.85rem; padding:0.25rem 0;'>"
                            f"<b>{_html.escape(s.get('reason', ''))}</b> "
                            f"<code>{_html.escape(s['original'][:120])}</code> → "
                            f"<code>{_html.escape(s['corrected'][:120])}</code></div>",
                            unsafe_allow_html=True,
                        )

    # ----- Build final outputs from currently-accepted corrections -----
    final_pieces: list[str] = []
    diff_pieces: list[str] = [f"# Edit diff for {uploaded.name}\n"]
    for idx, unit in enumerate(results):
        accepted_corrs = [
            c for c in unit["corrections"]
            if st.session_state.get(f"chk_{idx}_{c['id']}", True)
        ]
        new_text, _, _ = apply_corrections(unit["original"], accepted_corrs)
        final_pieces.append(new_text)
        diff_pieces.append(make_diff(unit["original"], new_text, unit["name"]) + "\n---\n")
    final_md = "\n\n".join(final_pieces).strip() + "\n"
    final_diff = "\n".join(diff_pieces)

    total_acc = sum(
        1 for idx, unit in enumerate(results)
        for c in unit["corrections"]
        if st.session_state.get(f"chk_{idx}_{c['id']}", True)
    )
    total_corr = sum(len(u["corrections"]) for u in results)

    st.markdown(
        f'<div class="small-note" style="margin-top:1rem;">{t("output_reflects")} '
        f'<b>{total_acc} {t("of")} {total_corr}</b> {t("proposed_changes")}</div>',
        unsafe_allow_html=True,
    )

    # Cache DOCX conversion (it's slow) — only re-run when final_md changes.
    docx_bytes = None
    if st.session_state.get("docx_for_md") == final_md:
        docx_bytes = st.session_state.get("docx_cache")
    else:
        try:
            with st.spinner(t("converting_docx")):
                docx_bytes = markdown_to_docx(final_md)
            st.session_state["docx_for_md"] = final_md
            st.session_state["docx_cache"] = docx_bytes
        except Exception as exc:
            st.warning(f"{t('docx_fail')}: {exc}")

    dl_cols = st.columns(3)
    if docx_bytes:
        dl_cols[0].download_button(
            "⬇️ Edited .docx",
            data=docx_bytes,
            file_name=f"{base}.edited.docx",
            mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            use_container_width=True,
        )
    dl_cols[1].download_button(
        "⬇️ Edited .md",
        data=final_md.encode("utf-8"),
        file_name=f"{base}.edited.md",
        mime="text/markdown",
        use_container_width=True,
    )
    dl_cols[2].download_button(
        "⬇️ Diff .md",
        data=final_diff.encode("utf-8"),
        file_name=f"{base}.diff.md",
        mime="text/markdown",
        use_container_width=True,
    )

    with st.expander(t("preview_md")):
        st.code(final_md[:10000], language="markdown")
