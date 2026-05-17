"""
ui.py — Streamlit UI for the book editor pipeline (queue-based).

Run with:
    streamlit run Code/ui.py

Workflow:
    1. Upload a .docx or .md — chapters are auto-detected
    2. Edit/review the style guide (main area, collapsible)
    3. Pick chapters and click "Add to queue"
    4. Watch the right-side queue panel — tasks process in the background
    5. Add MORE chapters or NEW documents while processing continues
    6. Review and accept/dismiss corrections per chapter
    7. Download the edited .docx and diff .md
"""

from __future__ import annotations

import atexit
import difflib
import html as _html
import io
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor, Future
from pathlib import Path

import streamlit as st


# ---------------------------------------------------------------------------
# Stop Ollama when the UI exits
# ---------------------------------------------------------------------------

def _stop_ollama():
    try:
        subprocess.run(["brew", "services", "stop", "ollama"],
                       capture_output=True, timeout=10)
        print("[UI] Stopped Ollama service", flush=True)
    except Exception:
        pass

if not getattr(_stop_ollama, "_registered", False):
    atexit.register(_stop_ollama)
    _stop_ollama._registered = True

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from book_editor import (  # noqa: E402
    build_system_prompt,
    build_corrections_system_prompt,
    edit_chunk_stream,
    find_corrections_stream,
    parse_corrections_json,
    apply_corrections,
    split_into_chunks,
    strip_overlap_from_response,
    make_diff,
)


# ==========================================================================
# i18n
# ==========================================================================

TRANSLATIONS: dict[str, dict[str, str]] = {
    "subtitle": {
        "en": "a private copy editor for pre-print",
        "da": "en privat korrekturlæser",
    },
    "settings":       {"en": "Settings",              "da": "Indstillinger"},
    "language":       {"en": "Language",               "da": "Sprog"},
    "model":          {"en": "Ollama model",           "da": "Ollama-model"},
    "model_help":     {"en": "Could not detect installed models. Type the name manually.",
                       "da": "Kunne ikke finde installerede modeller. Indtast navnet manuelt."},
    "words_per_chunk":{"en": "Words per chunk",        "da": "Ord pr. chunk"},
    "paragraph_overlap":{"en": "Paragraph overlap",   "da": "Paragrafoverlap"},
    "fast_mode":      {"en": "⚡ Fast mode (corrections only)",
                       "da": "⚡ Hurtig tilstand (kun rettelser)"},
    "fast_mode_help": {
        "en": "Returns a JSON list of edits instead of rewriting the whole chunk. Typically 3–10× faster.",
        "da": "Returnerer en JSON-liste af rettelser. Typisk 3–10× hurtigere.",
    },
    "parallel_chapters":{"en": "Parallel chapters",   "da": "Parallelle kapitler"},
    "parallel_help":  {
        "en": "Max concurrent editing workers. With large 27B+ models, leave at 1.",
        "da": "Maks. parallelle arbejdere. Med store 27B+ modeller, behold på 1.",
    },
    # Style guide
    "style_guide":    {"en": "Style guide",            "da": "Stilguide"},
    "style_guide_tip":{
        "en": ("List character names, place names, and house-style rules the editor must respect. "
               "The guide is sent with every chunk. Loaded automatically from style.md — "
               "edit inline, or upload a .md / .txt / .docx to replace."),
        "da": ("Angiv personnavne, stednavne og stilregler korrekturlæseren skal overholde. "
               "Guiden sendes med hver chunk. Indlæses automatisk fra style.md — "
               "rediger direkte, eller upload en .md / .txt / .docx."),
    },
    "upload_style":   {"en": "Upload style guide",     "da": "Upload stilguide"},
    "style_rules":    {"en": "Style rules",            "da": "Stilregler"},
    # Step I
    "sec_manuscript": {"en": "Manuscript",             "da": "Manuskript"},
    "upload_prompt":  {"en": "Upload a .docx or .md to begin.",
                       "da": "Upload en .docx eller .md for at starte."},
    "lbl_file":       {"en": "file",                   "da": "fil"},
    "lbl_words":      {"en": "words",                  "da": "ord"},
    "lbl_chapters":   {"en": "chapters",               "da": "kapitler"},
    "lbl_model":      {"en": "model",                  "da": "model"},
    "converting":     {"en": "Converting to Markdown…","da": "Konverterer til Markdown…"},
    # Step II
    "sec_scope":      {"en": "Scope",                  "da": "Omfang"},
    "whole_book":     {"en": "Whole book",             "da": "Hele bogen"},
    "selected_chapters":{"en": "Selected chapters",   "da": "Udvalgte kapitler"},
    "first_n_words":  {"en": "First N words",          "da": "Første N ord"},
    "pick_chapters":  {"en": "Pick chapters…",         "da": "Vælg kapitler…"},
    "select_one":     {"en": "Select at least one chapter.",
                       "da": "Vælg mindst ét kapitel."},
    "words_selected": {"en": "words across",           "da": "ord fordelt på"},
    "units":          {"en": "unit(s)",                "da": "enhed(er)"},
    # Step III
    "sec_edit":       {"en": "Edit",                   "da": "Rediger"},
    "btn_add_to_queue":{"en": "Add to queue",          "da": "Tilføj til kø"},
    # Queue panel
    "queue_panel":    {"en": "Queue",                  "da": "Kø"},
    "queue_empty":    {"en": "Queue is empty — add chapters above.",
                       "da": "Køen er tom — tilføj kapitler ovenfor."},
    "status_queued":  {"en": "queued",                 "da": "i kø"},
    "status_editing": {"en": "editing",                "da": "redigerer"},
    "status_done":    {"en": "done",                   "da": "færdig"},
    "status_error":   {"en": "error",                  "da": "fejl"},
    "status_cancelled":{"en": "cancelled",             "da": "annulleret"},
    "clear_done":     {"en": "Clear completed",        "da": "Ryd færdige"},
    "btn_cancel":     {"en": "Cancel",             "da": "Annuller"},
    "add_doc":        {"en": "Add another document",   "da": "Tilføj nyt dokument"},
    "queue_doc_uploader":{"en": "Upload .docx / .md",  "da": "Upload .docx / .md"},
    "n_pending":      {"en": "pending",                "da": "afventer"},
    "n_running":      {"en": "running",                "da": "kører"},
    "n_done":         {"en": "done",                   "da": "færdige"},
    "warn_unload":    {
        "en": "Editing is in progress. If you leave or refresh now, the queue will be lost.",
        "da": "Redigering er i gang. Forlader du siden, mistes køen.",
    },
    # Step IV
    "sec_review":     {"en": "Review & Export",        "da": "Gennemgang & Eksport"},
    "accepted":       {"en": "accepted",               "da": "accepteret"},
    "no_changes":     {"en": "no changes",             "da": "ingen rettelser"},
    "accept_all":     {"en": "Accept all",             "da": "Acceptér alle"},
    "dismiss_all":    {"en": "Dismiss all",            "da": "Afvis alle"},
    "no_corrections_unit":{"en": "No corrections proposed.",
                           "da": "Ingen rettelser foreslået."},
    "skipped_label":  {"en": "skipped (markdown / ambiguity)",
                       "da": "sprunget over (markdown / tvetydighed)"},
    "output_reflects":{"en": "Output reflects",        "da": "Output afspejler"},
    "of":             {"en": "of",                     "da": "af"},
    "proposed_changes":{"en": "proposed change(s).",   "da": "foreslåede rettelse(r)."},
    "converting_docx":{"en": "Converting to DOCX…",   "da": "Konverterer til DOCX…"},
    "docx_fail":      {"en": "DOCX conversion failed", "da": "DOCX-konvertering mislykkedes"},
    "preview_md":     {"en": "Preview edited Markdown","da": "Forhåndsvisning af redigeret Markdown"},
    "results_for":    {"en": "Results for",            "da": "Resultater for"},
}


def t(key: str) -> str:
    lang = st.session_state.get("lang", "en")
    entry = TRANSLATIONS.get(key)
    if not entry:
        return key
    return entry.get(lang, entry.get("en", key))


# ==========================================================================
# Chapter detection
# ==========================================================================

PAGEBREAK_MARKER = "<!-- PAGEBREAK -->"

CHAPTER_WORDS = (
    "chapter", "part",
    "kapitel", "kapittel", "del",
    "capítulo", "capitulo", "parte",
    "chapitre", "partie",
    "capitolo",
    "hoofdstuk",
)
_CWG = "|".join(sorted(set(CHAPTER_WORDS), key=len, reverse=True))

SPECIAL_SECTIONS = (
    "prologue", "epilogue", "interlude", "afterword", "foreword",
    "preface", "introduction", "appendix",
    "prolog", "epilog", "forord", "efterord", "indledning", "appendiks",
    "vorwort", "nachwort", "einleitung",
    "prólogo", "epílogo", "prefacio", "introducción", "apéndice",
    "préface", "annexe",
    "prologo", "epilogo", "prefazione", "introduzione", "appendice",
    "proloog", "epiloog", "voorwoord", "nawoord", "inleiding",
)
_SSG = "|".join(sorted(set(SPECIAL_SECTIONS), key=len, reverse=True))

CHAPTER_PATTERNS = [
    re.compile(r"(?m)^\s*" + re.escape(PAGEBREAK_MARKER) + r"\s*$"),
    re.compile(r"(?m)^(#{1,2})\s+(.+)$"),
    re.compile(r"(?mi)^[ \t]*[*_]{0,3}[ \t]*((?:" + _CWG + r")[ \t]+[\dIVXLCivxlc]+[.:—–-]?[^\n]*?)[ \t]*[*_]{0,3}[ \t]*$"),
    re.compile(r"(?mi)^[ \t]*[*_]{0,3}[ \t]*((?:" + _CWG + r")(?:[ \t]+\S[^\n]*?)?)[ \t]*[*_]{0,3}[ \t]*$"),
    re.compile(r"(?mi)^\s*((?:" + _SSG + r")\s*[.:—–-]?\s*.*?)$"),
    re.compile(r"(?m)^\s*([A-ZÆØÅÄÖÜÉÈÊÁÀÂÍÓÚÑÇ][A-ZÆØÅÄÖÜÉÈÊÁÀÂÍÓÚÑÇ ]{6,})$"),
    re.compile(r"(?m)^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$"),
    re.compile(r"(?m)^\s*(\d{1,3}[.)]\s+.+)$"),
]


def _clean_title(s: str) -> str:
    s = s.strip()
    s = re.sub(r'^[*_]{1,3}\s*', '', s)
    s = re.sub(r'\s*[*_]{1,3}$', '', s)
    return s.lstrip('# ').strip()


def find_chapters(text: str) -> list[dict]:
    for pat in CHAPTER_PATTERNS:
        matches = [m for m in pat.finditer(text) if len(m.group(0).strip()) <= 120]
        if len(matches) >= 2 or (len(matches) == 1 and matches[0].start() > 0):
            out = []
            for i, m in enumerate(matches):
                start = m.start()
                end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
                raw = next((g for g in reversed(m.groups()) if g and g.strip()), m.group(0))
                if PAGEBREAK_MARKER in raw:
                    sec = text[m.end():end]
                    first = next((ln.strip() for ln in sec.splitlines() if ln.strip()),
                                 f"Section {i+1}")
                    title = _clean_title(first[:80])
                else:
                    title = _clean_title(raw)
                out.append({"title": title, "level": 1, "start": start, "end": end,
                            "word_count": len(text[start:end].split())})
            return out
    brk = re.compile(r"(?m)^\s*(?:\*\s*\*\s*\*|---+|___+)\s*$")
    matches = list(brk.finditer(text))
    if len(matches) >= 2:
        out = []
        bounds = [0] + [m.end() for m in matches] + [len(text)]
        for i in range(len(bounds) - 1):
            s, e = bounds[i], bounds[i + 1]
            sec = text[s:e].strip()
            if not sec:
                continue
            title = sec.splitlines()[0][:60].strip() or f"Section {i+1}"
            out.append({"title": title, "level": 1, "start": s, "end": e,
                        "word_count": len(sec.split())})
        if out:
            return out
    return []


def extract_pagebreaks_from_docx(docx_bytes: bytes) -> list[int]:
    try:
        with zipfile.ZipFile(io.BytesIO(docx_bytes)) as z:
            xml_data = z.read("word/document.xml")
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
    breaks, p_index = [], 0
    for child in body:
        if not child.tag.endswith("}p"):
            continue
        found = any(br.get(ns + "type") == "page" for br in child.iter(ns + "br"))
        if not found:
            ppr = child.find(ns + "pPr")
            if ppr is not None:
                pbb = ppr.find(ns + "pageBreakBefore")
                if pbb is not None and pbb.get(ns + "val", "true").lower() in ("true", "1", "on"):
                    found = True
                if not found:
                    sect = ppr.find(ns + "sectPr")
                    if sect is not None:
                        bt = sect.find(ns + "type")
                        if bt is not None and bt.get(ns + "val") in ("nextPage", "oddPage", "evenPage"):
                            found = True
        if found:
            breaks.append(p_index)
        p_index += 1
    return breaks


def docx_to_markdown(docx_bytes: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f:
        f.write(docx_bytes)
        in_p = Path(f.name)
    out_p = in_p.with_suffix(".md")
    subprocess.run(["pandoc", str(in_p), "-f", "docx", "-t", "markdown",
                    "-o", str(out_p), "--wrap=none"], check=True)
    text = out_p.read_text(encoding="utf-8")
    in_p.unlink(missing_ok=True)
    out_p.unlink(missing_ok=True)
    pbs = extract_pagebreaks_from_docx(docx_bytes)
    if pbs:
        blocks = re.split(r"\n\s*\n", text)
        bset = set(pbs)
        out_b: list[str] = []
        for i, b in enumerate(blocks):
            if i in bset and i > 0:
                out_b.append(PAGEBREAK_MARKER)
            out_b.append(b)
        text = "\n\n".join(out_b)
    return text


def markdown_to_docx(md: str) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".md", delete=False, mode="w", encoding="utf-8") as f:
        f.write(md)
        in_p = Path(f.name)
    out_p = in_p.with_suffix(".docx")
    subprocess.run(["pandoc", str(in_p), "-f", "markdown", "-t", "docx",
                    "-o", str(out_p), "--standalone"], check=True)
    data = out_p.read_bytes()
    in_p.unlink(missing_ok=True)
    out_p.unlink(missing_ok=True)
    return data


def list_ollama_models() -> list[str]:
    try:
        r = subprocess.run(["ollama", "list"], capture_output=True, text=True,
                           check=True, timeout=5)
        return [ln.split()[0] for ln in r.stdout.strip().splitlines()[1:] if ln.strip()]
    except Exception:
        return []


# ==========================================================================
# Inline word-level diff
# ==========================================================================

def _tok(s: str) -> list[str]:
    return re.findall(r"\s+|\w+|[^\w\s]", s)


def inline_diff_html(before: str, after: str) -> str:
    a, b = _tok(before), _tok(after)
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    parts: list[str] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
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


def correction_card(original: str, corrected: str, label: str = "") -> str:
    lbl = (f'<div style="font-size:0.75rem;color:#64748b;margin-bottom:0.25rem;">'
           f'{_html.escape(label)}</div>') if label else ""
    return (f'<div class="correction-card">{lbl}'
            f'<div class="correction-diff">{inline_diff_html(original, corrected)}</div></div>')


# ==========================================================================
# Module-level task executor — survives Streamlit reruns
# ==========================================================================
#
# Streamlit re-runs the entire script on every interaction. A ThreadPoolExecutor
# created inside the script would be torn down between runs. We keep ONE
# module-level executor so background tasks persist across reruns.
# All mutable state is protected by _LOCK and lives in _TASKS (a dict keyed
# by task id). The Streamlit script only READS from _TASKS on each rerun.
#
# CRITICAL: the LOCK / TASKS / EXECUTOR objects must NOT be re-created on
# each rerun, or worker threads from previous runs would update an orphaned
# dict that the new render code never sees. We achieve persistence by
# keeping the state in a separate module (_queue_state); Python caches
# imports in sys.modules, so the same objects are reused across reruns.

import _queue_state as _qs  # noqa: E402


class _DaemonExecutor(ThreadPoolExecutor):
    """ThreadPoolExecutor whose workers are daemon threads so they
    don't prevent process exit (Ctrl-C won't hang on 'Stopping...')."""
    def _adjust_thread_count(self):
        # Patch: set daemon BEFORE the thread is started.
        # CPython creates threads in _adjust_thread_count via threading.Thread();
        # we intercept by temporarily monkey-patching Thread to produce daemons.
        import threading as _th
        _orig = _th.Thread.__init__

        def _patched_init(self_t, *a, **kw):
            _orig(self_t, *a, **kw)
            self_t.daemon = True

        _th.Thread.__init__ = _patched_init  # type: ignore[method-assign]
        try:
            super()._adjust_thread_count()
        finally:
            _th.Thread.__init__ = _orig  # type: ignore[method-assign]


def _ensure_executor(workers: int) -> None:
    with _qs.LOCK:
        if _qs.EXECUTOR is None or _qs.EXECUTOR_WORKERS != workers:
            if _qs.EXECUTOR is not None:
                _qs.EXECUTOR.shutdown(wait=False, cancel_futures=False)
            _qs.EXECUTOR = _DaemonExecutor(max_workers=max(1, workers))
            _qs.EXECUTOR_WORKERS = workers


def _worker(task: dict) -> None:
    tid = task["id"]
    if _qs.CANCEL.is_set():
        with _qs.LOCK:
            _qs.TASKS[tid]["status"] = "cancelled"
        return
    with _qs.LOCK:
        _qs.TASKS[tid]["status"] = "editing"
        _qs.TASKS[tid]["started_at"] = time.time()
        _qs.TASKS[tid]["phase"] = "preparing"
    try:
        with _qs.LOCK:
            _qs.TASKS[tid]["phase"] = "splitting"
        chunks = split_into_chunks(task["original"], task["wpc"], task["overlap"])
        with _qs.LOCK:
            _qs.TASKS[tid]["phase"] = f"0/{len(chunks)} chunks"
        pieces, corrections, skipped, errors = [], [], [], []
        for j, chunk in enumerate(chunks, 1):
            if _qs.CANCEL.is_set():
                with _qs.LOCK:
                    _qs.TASKS[tid]["status"] = "cancelled"
                return
            acc = ""
            tok_count = 0
            try:
                with _qs.LOCK:
                    _qs.TASKS[tid]["phase"] = f"sending chunk {j}/{len(chunks)}"
                if task["fast"]:
                    for tok in find_corrections_stream(task["model"], chunk["body"], task["prompt"]):
                        acc += tok
                        tok_count += 1
                        if tok_count == 1:
                            with _qs.LOCK:
                                _qs.TASKS[tid]["phase"] = f"receiving chunk {j}/{len(chunks)}"
                    with _qs.LOCK:
                        _qs.TASKS[tid]["phase"] = f"applying corrections {j}/{len(chunks)}"
                    cs = parse_corrections_json(acc)
                    new_body, applied, sk = apply_corrections(chunk["body"], cs)
                    core = strip_overlap_from_response(new_body, chunk["overlap_head_paragraphs"])
                    for c in applied:
                        corrections.append({**c, "chunk": f"Chunk {j}/{len(chunks)}", "id": uuid.uuid4().hex})
                    skipped.extend({**s, "chunk": f"Chunk {j}/{len(chunks)}"} for s in sk)
                else:
                    for tok in edit_chunk_stream(task["model"], chunk["body"], task["prompt"]):
                        acc += tok
                        tok_count += 1
                        if tok_count == 1:
                            with _qs.LOCK:
                                _qs.TASKS[tid]["phase"] = f"receiving chunk {j}/{len(chunks)}"
                    core = strip_overlap_from_response(acc.strip(), chunk["overlap_head_paragraphs"])
            except Exception as exc:
                core = chunk["core"]
                errors.append(f"chunk {j}: {exc}")
            pieces.append(core)
            with _qs.LOCK:
                _qs.TASKS[tid]["progress"] = j / len(chunks)
        with _qs.LOCK:
            _qs.TASKS[tid].update({
                "status": "done",
                "progress": 1.0,
                "finished_at": time.time(),
                "result": {
                    "edited_text": "\n\n".join(pieces).strip(),
                    "original_text": task["original"],
                    "corrections": corrections,
                    "skipped": skipped,
                    "errors": errors,
                },
            })
    except Exception as exc:
        with _qs.LOCK:
            _qs.TASKS[tid].update({
                "status": "error",
                "finished_at": time.time(),
                "result": {
                    "edited_text": task["original"],
                    "original_text": task["original"],
                    "corrections": [],
                    "skipped": [],
                    "errors": [f"fatal: {exc}"],
                },
            })


def submit_task(task: dict, workers: int) -> None:
    _ensure_executor(workers)
    _qs.CANCEL.clear()
    with _qs.LOCK:
        _qs.TASKS[task["id"]] = {
            "status": "queued",
            "progress": 0.0,
            "phase": "",
            "name": task["name"],
            "source": task["source"],
            "word_count": task["word_count"],
            "submitted_at": time.time(),
            "result": None,
        }
    assert _qs.EXECUTOR is not None
    _qs.EXECUTOR.submit(_worker, task)


def cancel_all() -> None:
    _qs.CANCEL.set()
    with _qs.LOCK:
        for s in _qs.TASKS.values():
            if s["status"] == "queued":
                s["status"] = "cancelled"


def remove_completed() -> None:
    with _qs.LOCK:
        for tid in [k for k, s in _qs.TASKS.items()
                    if s["status"] in ("done", "error", "cancelled")]:
            _qs.TASKS.pop(tid)


def tasks_snapshot() -> dict[str, dict]:
    with _qs.LOCK:
        return {k: dict(v) for k, v in _qs.TASKS.items()}


def has_active() -> bool:
    with _qs.LOCK:
        return any(s["status"] in ("queued", "editing") for s in _qs.TASKS.values())


# ==========================================================================
# Page config + CSS
# ==========================================================================

st.set_page_config(
    page_title="Bethaniel Editor",
    page_icon="📖",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

.stApp { background:#f7f1e3; background-image:radial-gradient(ellipse at top,#faf5e6 0%,#f7f1e3 60%,#f0e8d4 100%); }
.block-container { padding-top:1.25rem; padding-bottom:2.5rem; max-width:1400px; }
html,body,[class*="css"]{ font-family:'Inter',-apple-system,system-ui,sans-serif; color:#2a2419; }
h1,h2,h3,h4{ font-family:'Cormorant Garamond',Georgia,serif !important; font-weight:600; color:#1a140a; }

.masthead{ text-align:center; padding:0.5rem 0 1.25rem 0; border-bottom:1px solid #c9b896; margin-bottom:1.25rem; }
.masthead .title{ font-family:'Cormorant Garamond',Georgia,serif; font-size:2.4rem; font-weight:700; color:#1a140a; letter-spacing:0.02em; line-height:1.1; margin:0; }
.masthead .subtitle{ font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-size:1.05rem; color:#6b5c44; margin:0.25rem 0 0 0; }
.masthead .rule{ width:60px; height:1px; background:#8b7355; margin:0.6rem auto 0 auto; }

.chip-row{ display:flex; flex-wrap:wrap; gap:0.5rem 0.75rem; align-items:center; background:#fdfaf0; border:1px solid #d9c9a8; border-radius:4px; padding:0.55rem 0.9rem; margin:0.35rem 0 0.75rem 0; font-size:0.9rem; }
.chip-row .label{ font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; color:#8b7355; font-size:0.95rem; margin-right:0.25rem; }
.chip-row .value{ font-weight:600; color:#1a140a; }
.chip-row .sep{ color:#c9b896; margin:0 0.4rem; }

.section-label{ font-family:'Cormorant Garamond',Georgia,serif; font-size:0.78rem; font-weight:600; text-transform:uppercase; letter-spacing:0.18em; color:#8b7355; margin:0.75rem 0 0.25rem 0; }
.section-label .num{ color:#b8915a; margin-right:0.4rem; }

div[data-testid="stFileUploader"]{ background:#fdfaf0; border:1px dashed #c9b896; border-radius:4px; padding:0.5rem 0.75rem; }
div[data-testid="stFileUploader"] section{ padding:0.25rem 0; }
div[data-testid="stFileUploader"] small{ color:#8b7355; }

div[data-testid="stRadio"] [role="radiogroup"]{ gap:0.4rem !important; }
div[data-testid="stRadio"] label{ background:#fdfaf0; border:1px solid #d9c9a8; border-radius:4px; padding:0.3rem 0.75rem; font-size:0.88rem; cursor:pointer; }

.stButton>button[kind="primary"]{ background:#1a140a; color:#f7f1e3 !important; border:1px solid #1a140a; border-radius:2px; font-family:'Cormorant Garamond',Georgia,serif; font-weight:600; font-size:1.05rem; letter-spacing:0.1em; text-transform:uppercase; padding:0.6rem 1.4rem; transition:all 0.15s; box-shadow:2px 2px 0 #c9b896; }
.stButton>button[kind="primary"]:hover{ background:#3d2f1a; transform:translate(-1px,-1px); box-shadow:3px 3px 0 #b8915a; }
.stButton>button[kind="primary"]:disabled{ opacity:0.5; cursor:not-allowed; transform:none; box-shadow:none; }

.word-ins{ background:#d4e3c5; color:#2d4a1a; padding:1px 4px; border-radius:2px; font-weight:600; }
.word-del{ background:#e8c5c0; color:#6b1f1a; padding:1px 4px; border-radius:2px; text-decoration:line-through; opacity:0.85; }
.correction-card{ background:#fdfaf0; border:1px solid #d9c9a8; border-left:3px solid #8b7355; border-radius:2px; padding:0.55rem 0.85rem; margin:0.35rem 0; font-family:'Cormorant Garamond',Georgia,serif; font-size:1.05rem; line-height:1.5; color:#2a2419; }
.correction-card .word-ins,.correction-card .word-del{ font-family:'Cormorant Garamond',Georgia,serif; }
.correction-diff{ white-space:pre-wrap; word-wrap:break-word; }
.correction-empty{ color:#8b7355; font-style:italic; font-family:'Cormorant Garamond',Georgia,serif; font-size:1rem; padding:0.4rem 0; }

.small-note{ font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; color:#8b7355; font-size:0.95rem; margin:0.15rem 0 0.5rem 0; }

section[data-testid="stSidebar"]{ background:#efe6d0; border-right:1px solid #c9b896; transform:none !important; margin-left:0 !important; min-width:245px !important; }
section[data-testid="stSidebar"] button[data-testid="stSidebarCollapseButton"]{ display:none !important; }
button[data-testid="stSidebarCollapsedControl"]{ display:none !important; }
section[data-testid="stSidebar"] > div:first-child { width:245px !important; }
[data-testid="collapsedControl"]{ display:none !important; }

/* ---- Queue panel ---- */
.q-panel{ background:#f4ecd8; border:1px solid #c9b896; border-left:3px solid #8b7355; border-radius:2px; padding:0.75rem 0.85rem; }
.q-title{ font-family:'Cormorant Garamond',Georgia,serif; font-size:1.15rem; font-weight:700; color:#1a140a; letter-spacing:0.05em; margin:0 0 0.2rem 0; }
.q-counts{ font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-size:0.82rem; color:#6b5c44; margin-bottom:0.5rem; }
.q-item{ background:#fdfaf0; border:1px solid #d9c9a8; border-radius:2px; padding:0.38rem 0.55rem; margin:0.28rem 0; }
.q-name{ font-weight:600; color:#1a140a; font-size:0.85rem; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.q-src{ font-style:italic; color:#8b7355; font-size:0.72rem; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.q-status{ font-size:0.76rem; margin-top:0.18rem; }
.qs-queued{ color:#8b7355; } .qs-editing{ color:#3d6b3d; font-weight:600; }
.qs-done{ color:#2d4a1a; font-weight:600; } .qs-error{ color:#7f1d1d; font-weight:600; }
.qs-cancelled{ color:#6b5c44; }
.q-bar{ height:3px; background:#e8d9b8; border-radius:2px; margin-top:0.28rem; overflow:hidden; }
.q-fill{ height:100%; background:#8b7355; }
.q-fill.qs-editing{ background:#3d6b3d; } .q-fill.qs-done{ background:#2d4a1a; }

.stDeployButton,footer,header[data-testid="stHeader"]{ display:none; }
</style>
""", unsafe_allow_html=True)

st.markdown(
    f'<div class="masthead"><div class="title">Bethaniel</div>'
    f'<div class="subtitle">{t("subtitle")}</div><div class="rule"></div></div>',
    unsafe_allow_html=True,
)


def sec(num: str, title: str) -> None:
    st.markdown(
        f'<div class="section-label"><span class="num">{num}.</span>{title}</div>',
        unsafe_allow_html=True,
    )


# ==========================================================================
# Sidebar — language + model settings only
# ==========================================================================

with st.sidebar:
    if "lang" not in st.session_state:
        st.session_state["lang"] = "en"
    lang_opts = {"English": "en", "Dansk": "da"}
    lang_lbl = st.radio(t("language"), list(lang_opts.keys()), horizontal=True,
                        index=0 if st.session_state["lang"] == "en" else 1)
    nl = lang_opts[lang_lbl]
    if nl != st.session_state.get("lang"):
        st.session_state["lang"] = nl
        st.rerun()

    st.markdown(f'<div class="section-label" style="margin-top:0.75rem;">{t("settings")}</div>',
                unsafe_allow_html=True)
    avail = list_ollama_models()
    if avail:
        def_idx = 0
        for p in ("qwen3:32b", "qwen3:14b", "gemma4:27b", "betty"):
            if p in avail:
                def_idx = avail.index(p)
                break
        model = st.selectbox(t("model"), avail, index=def_idx,
                             key="cfg_model_widget")
    else:
        st.warning("⚠️ Cannot reach Ollama — is it running?\n\n`brew services start ollama`")
        if st.button("🔄 Retry", key="retry_ollama", use_container_width=True):
            st.rerun()
        model = st.text_input(t("model"), value="qwen3:32b", help=t("model_help"),
                              key="cfg_model_widget")

    words_per_chunk = st.slider(t("words_per_chunk"), 1000, 5000, 2500, step=250,
                                key="cfg_wpc_widget")
    overlap_para    = st.slider(t("paragraph_overlap"), 0, 3, 1,
                                key="cfg_overlap_widget")
    fast_mode = st.toggle(t("fast_mode"), value=True, help=t("fast_mode_help"),
                          key="cfg_fast_widget")
    parallel  = st.slider(t("parallel_chapters"), 1, 4, 1, help=t("parallel_help"),
                          key="cfg_parallel_widget")

    # Mirror into session_state so helper functions can always read them
    st.session_state["cfg_model"]   = model
    st.session_state["cfg_wpc"]     = words_per_chunk
    st.session_state["cfg_overlap"] = overlap_para
    st.session_state["cfg_fast"]    = fast_mode
    st.session_state["cfg_parallel"] = parallel

    # Apply parallelism change immediately (so the slider takes effect
    # without waiting for the next Add-to-queue click).
    _ensure_executor(parallel)


# ==========================================================================
# beforeunload warning
# ==========================================================================

if has_active():
    msg = t("warn_unload").replace("'", "\\'")
    st.markdown(
        f"<script>window.onbeforeunload=function(e){{e.preventDefault();e.returnValue='{msg}';return '{msg}';}}</script>",
        unsafe_allow_html=True,
    )
else:
    st.markdown("<script>window.onbeforeunload=null;</script>", unsafe_allow_html=True)


# ==========================================================================
# Document store helpers
# ==========================================================================

def _doc_key(name: str, size: int) -> str:
    return f"{name}::{size}"


def _ingest(uploaded_file) -> str:
    """Convert + cache an uploaded file. Returns its doc_key."""
    if "docs" not in st.session_state:
        st.session_state["docs"] = {}
    key = _doc_key(uploaded_file.name, uploaded_file.size)
    if key not in st.session_state["docs"]:
        with st.spinner(t("converting")):
            if uploaded_file.name.lower().endswith(".docx"):
                md = docx_to_markdown(uploaded_file.getvalue())
            else:
                md = uploaded_file.getvalue().decode("utf-8")
        st.session_state["docs"][key] = {
            "name": uploaded_file.name,
            "md": md,
            "chapters": find_chapters(md),
        }
    return key


def _enqueue_units(units: list[dict], doc_name: str, system_prompt: str) -> int:
    _model    = st.session_state.get("cfg_model",   "qwen3:32b")
    _fast     = st.session_state.get("cfg_fast",    True)
    _wpc      = st.session_state.get("cfg_wpc",     2500)
    _overlap  = st.session_state.get("cfg_overlap", 1)
    _parallel = st.session_state.get("cfg_parallel", 1)
    n = 0
    for u in units:
        task = {
            "id": uuid.uuid4().hex,
            "name": u["name"],
            "source": doc_name,
            "original": u["original"],
            "word_count": len(u["original"].split()),
            "model": _model,
            "prompt": system_prompt,
            "fast": _fast,
            "wpc": _wpc,
            "overlap": _overlap,
        }
        submit_task(task, _parallel)
        n += 1
    return n


def _build_units(md: str, chapters: list[dict], mode: str,
                 sel: list[int] | None, nw: int | None) -> list[dict]:
    if mode == t("selected_chapters") and chapters and sel:
        return [
            {
                "name": f"Ch.{i+1}: {chapters[i]['title']}",
                "original": (md[chapters[i]["start"]:chapters[i]["end"]]
                             .replace(PAGEBREAK_MARKER, "").strip()),
            }
            for i in sel
        ]
    if mode == t("first_n_words") and nw is not None:
        words = md.split()
        if nw >= len(words):
            txt = md
        else:
            rough = " ".join(words[:nw])
            nb = md.find("\n\n", len(rough))
            txt = md[:nb] if 0 < nb - len(rough) < 2000 else rough
        return [{"name": f"{t('first_n_words')}: {nw:,}", "original": txt.strip()}]
    return [{"name": t("sec_manuscript"), "original": md.strip()}]


# ==========================================================================
# Two-column layout
# ==========================================================================

main_col, queue_col = st.columns([3, 1], gap="medium")


# ==========================================================================
# Queue panel (right column) — auto-refreshes every 2 s if st.fragment available
# ==========================================================================

def _render_queue():
    snap = tasks_snapshot()
    print(f"[UI] _render_queue called, snap has {len(snap)} entries: "
          f"{[(s['name'], s['status']) for s in snap.values()]}", flush=True)
    nq = sum(1 for s in snap.values() if s["status"] == "queued")
    nr = sum(1 for s in snap.values() if s["status"] == "editing")
    nd = sum(1 for s in snap.values() if s["status"] == "done")
    ne = sum(1 for s in snap.values() if s["status"] == "error")
    nc = sum(1 for s in snap.values() if s["status"] == "cancelled")

    st.markdown(
        f'<div class="q-panel">'
        f'<div class="q-title">{t("queue_panel")} '
        f'<span style="font-size:0.8rem;font-weight:400;color:#6b5c44;">{len(snap)}</span></div>'
        f'<div class="q-counts">{nq} {t("n_pending")} · {nr} {t("n_running")} · {nd} {t("n_done")}'
        f'{f" · ⚠️ {ne}" if ne else ""}'
        f'</div></div>',
        unsafe_allow_html=True,
    )

    if not snap:
        st.markdown(f'<div class="small-note" style="text-align:center;padding:0.8rem 0">'
                    f'{t("queue_empty")}</div>', unsafe_allow_html=True)
    else:
        order = {"editing": 0, "queued": 1, "done": 2, "error": 3, "cancelled": 4}
        icon = {"queued": "⏳", "editing": "✏️", "done": "✅", "error": "❌", "cancelled": "⊘"}
        for tid, s in sorted(snap.items(),
                              key=lambda kv: (order.get(kv[1]["status"], 9),
                                              kv[1].get("submitted_at", 0))):
            st_ = s["status"]
            pct = int((s.get("progress") or 0) * 100)
            phase = s.get("phase", "")
            phase_html = (f'<span style="font-size:0.7rem;color:#6b5c44;font-style:italic;">'
                          f' — {_html.escape(phase)}</span>') if phase and st_ == "editing" else ""
            st.markdown(
                f'<div class="q-item">'
                f'<span class="q-name">{icon.get(st_,"·")} {_html.escape(s["name"])}</span>'
                f'<span class="q-src">{_html.escape(s.get("source",""))} · '
                f'{s.get("word_count",0):,} {t("lbl_words")}</span>'
                f'<div class="q-status qs-{st_}">{t(f"status_{st_}")}'
                f'{f" · {pct}%" if st_ in ("editing","done") else ""}'
                f'{phase_html}</div>'
                f'<div class="q-bar"><div class="q-fill qs-{st_}" style="width:{pct}%;"></div></div>'
                f'</div>',
                unsafe_allow_html=True,
            )

    if nd + ne + nc > 0:
        if st.button(t("clear_done"), key="q_clear", use_container_width=True):
            remove_completed()
            st.rerun()
    if nq + nr > 0:
        if st.button(t("btn_cancel"), key="q_cancel", type="primary", use_container_width=True):
            cancel_all()
            st.rerun()


_HAS_FRAGMENT = hasattr(st, "fragment")


with queue_col:
    _render_queue()


# ==========================================================================
# Main column — Steps I–IV
# ==========================================================================

with main_col:

    # ---- Step I: Manuscript ----
    sec("I", t("sec_manuscript"))
    uploaded = st.file_uploader(
        t("sec_manuscript"),
        type=["docx", "md", "markdown"],
        label_visibility="collapsed",
    )

    if uploaded is None:
        st.markdown(f'<div class="small-note">{t("upload_prompt")}</div>',
                    unsafe_allow_html=True)
        st.stop()

    dk = _ingest(uploaded)
    doc = st.session_state["docs"][dk]
    md_text = doc["md"]
    chapters = doc["chapters"]
    total_words = len(md_text.split())

    st.markdown(
        '<div class="chip-row">'
        f'<span class="label">{t("lbl_file")}</span><span class="value">{_html.escape(uploaded.name)}</span>'
        '<span class="sep">·</span>'
        f'<span class="label">{t("lbl_words")}</span><span class="value">{total_words:,}</span>'
        '<span class="sep">·</span>'
        f'<span class="label">{t("lbl_chapters")}</span><span class="value">{len(chapters)}</span>'
        '<span class="sep">·</span>'
        f'<span class="label">{t("lbl_model")}</span><span class="value">{_html.escape(model)}</span>'
        '</div>',
        unsafe_allow_html=True,
    )

    # ---- Style guide (collapsible, in main area) ----
    if "style_text" not in st.session_state:
        default_sg = SCRIPT_DIR.parent / "style.md"
        st.session_state["style_text"] = (
            default_sg.read_text(encoding="utf-8") if default_sg.exists() else ""
        )

    with st.expander(t("style_guide"), expanded=False):
        st.markdown(f'<div class="small-note">{t("style_guide_tip")}</div>',
                    unsafe_allow_html=True)
        sg_l, sg_r = st.columns([3, 1])
        with sg_r:
            sg_upload = st.file_uploader(
                t("upload_style"), type=["md", "txt", "docx"],
                key="sg_uploader", label_visibility="collapsed",
            )
            if sg_upload is not None:
                if sg_upload.name.lower().endswith(".docx"):
                    try:
                        st.session_state["style_text"] = docx_to_markdown(sg_upload.getvalue())
                    except Exception as exc:
                        st.error(f"Could not convert: {exc}")
                else:
                    st.session_state["style_text"] = sg_upload.getvalue().decode("utf-8")
        with sg_l:
            new_sg = st.text_area(
                t("style_rules"), value=st.session_state["style_text"],
                height=200, label_visibility="collapsed",
            )
            st.session_state["style_text"] = new_sg

    # ---- Step II: Scope ----
    sec("II", t("sec_scope"))

    scope_opts = [t("whole_book"), t("first_n_words")]
    if chapters:
        scope_opts.insert(1, t("selected_chapters"))

    mode = st.selectbox(t("sec_scope"), scope_opts, label_visibility="collapsed")

    sel_idx: list[int] | None = None
    nw_val: int | None = None

    if mode == t("selected_chapters") and chapters:
        ch_labels = [f"Ch.{i+1}: {c['title']} ({c['word_count']:,} w)"
                     for i, c in enumerate(chapters)]
        sel_idx = st.multiselect(
            "Chapters",
            options=list(range(len(chapters))),
            format_func=lambda i: ch_labels[i],
            default=[0] if chapters else [],
            label_visibility="collapsed",
            placeholder=t("pick_chapters"),
        )
    elif mode == t("first_n_words"):
        max_w = max(500, total_words)
        nw_val = st.slider("Words", 500, max_w, min(5000, max_w), step=500,
                           label_visibility="collapsed")

    units = _build_units(md_text, chapters, mode, sel_idx, nw_val)

    if units:
        ew = sum(len(u["original"].split()) for u in units)
        st.markdown(
            f'<div class="small-note">~ {ew:,} {t("words_selected")} {len(units)} {t("units")}.</div>',
            unsafe_allow_html=True,
        )
    elif mode == t("selected_chapters"):
        st.markdown(f'<div class="small-note">{t("select_one")}</div>', unsafe_allow_html=True)

    # ---- Step III: Add to queue ----
    sec("III", t("sec_edit"))

    if st.button(
        f"{t('btn_add_to_queue')}{f' ({len(units)})' if units else ''}",
        type="primary",
        use_container_width=True,
        disabled=not units,
        key="btn_enqueue_main",
    ):
        print(f"[UI] Add-to-queue clicked, {len(units)} unit(s)", flush=True)
        _fast = st.session_state.get("cfg_fast", True)
        sys_p = (build_corrections_system_prompt(st.session_state.get("style_text") or None)
                 if _fast
                 else build_system_prompt(st.session_state.get("style_text") or None))
        n_added = _enqueue_units(units, doc["name"], sys_p)
        print(f"[UI] Enqueued {n_added} task(s), _qs.TASKS now has {len(_qs.TASKS)} entries", flush=True)
        st.rerun()

    # ---- Step IV: Review & Export ----
    snap = tasks_snapshot()
    done = [(tid, s) for tid, s in snap.items() if s["status"] == "done"]

    if done:
        sec("IV", t("sec_review"))

        # Group by source document
        by_src: dict[str, list[tuple[str, dict]]] = {}
        for tid, s in done:
            by_src.setdefault(s.get("source", "manuscript"), []).append((tid, s))

        for src, items in by_src.items():
            st.markdown(
                f'<div class="section-label" style="margin-top:1rem;">'
                f'{t("results_for")} <span style="color:#1a140a;text-transform:none;'
                f'letter-spacing:0;font-size:1rem;">{_html.escape(src)}</span></div>',
                unsafe_allow_html=True,
            )

            for tid, s in items:
                res = s["result"]
                corrs = res.get("corrections", [])
                n_acc = sum(1 for c in corrs if st.session_state.get(f"chk_{tid}_{c['id']}", True))
                badge = f"{n_acc}/{len(corrs)} {t('accepted')}" if corrs else t("no_changes")

                with st.expander(f"{s['name']} — {badge}", expanded=False):
                    for e in res.get("errors", []):
                        st.markdown(f"<div style='color:#7f1d1d;font-size:0.85rem;'>⚠️ {_html.escape(e)}</div>",
                                    unsafe_allow_html=True)
                    if not corrs:
                        st.markdown(f'<div class="correction-empty">{t("no_corrections_unit")}</div>',
                                    unsafe_allow_html=True)
                    else:
                        bc = st.columns([1, 1, 6])
                        if bc[0].button(t("accept_all"), key=f"acc_{tid}"):
                            for c in corrs:
                                st.session_state[f"chk_{tid}_{c['id']}"] = True
                            st.rerun()
                        if bc[1].button(t("dismiss_all"), key=f"dis_{tid}"):
                            for c in corrs:
                                st.session_state[f"chk_{tid}_{c['id']}"] = False
                            st.rerun()
                        for c in corrs:
                            ck = f"chk_{tid}_{c['id']}"
                            if ck not in st.session_state:
                                st.session_state[ck] = True
                            cc, cd = st.columns([0.06, 0.94])
                            with cc:
                                st.checkbox("accept", key=ck, label_visibility="collapsed")
                            with cd:
                                st.markdown(correction_card(c["original"], c["corrected"],
                                                            c.get("chunk", "")),
                                            unsafe_allow_html=True)
                    if res.get("skipped"):
                        with st.expander(f"⚠️ {len(res['skipped'])} {t('skipped_label')}", expanded=False):
                            for sk in res["skipped"][:50]:
                                st.markdown(
                                    f"<div style='font-size:0.85rem;padding:0.25rem 0;'>"
                                    f"<b>{_html.escape(sk.get('reason',''))}</b> "
                                    f"<code>{_html.escape(sk['original'][:120])}</code> → "
                                    f"<code>{_html.escape(sk['corrected'][:120])}</code></div>",
                                    unsafe_allow_html=True,
                                )

            # Build output for this source
            final_pieces: list[str] = []
            diff_pieces: list[str] = [f"# Edit diff for {src}\n"]
            for tid, s in items:
                res = s["result"]
                orig = res.get("original_text", res["edited_text"])
                acc_corrs = [c for c in res.get("corrections", [])
                             if st.session_state.get(f"chk_{tid}_{c['id']}", True)]
                new_txt, _, _ = apply_corrections(orig, acc_corrs)
                final_pieces.append(new_txt)
                diff_pieces.append(make_diff(orig, new_txt, s["name"]) + "\n---\n")

            final_md = "\n\n".join(final_pieces).strip() + "\n"
            final_diff = "\n".join(diff_pieces)
            total_acc = sum(1 for tid, s in items
                            for c in s["result"].get("corrections", [])
                            if st.session_state.get(f"chk_{tid}_{c['id']}", True))
            total_corr = sum(len(s["result"].get("corrections", [])) for _, s in items)

            st.markdown(
                f'<div class="small-note" style="margin-top:0.5rem;">'
                f'{t("output_reflects")} <b>{total_acc} {t("of")} {total_corr}</b> '
                f'{t("proposed_changes")}</div>',
                unsafe_allow_html=True,
            )

            # Cache DOCX per source
            ck_md = f"docx_md_{src}"
            ck_data = f"docx_data_{src}"
            docx_bytes = None
            if st.session_state.get(ck_md) == final_md:
                docx_bytes = st.session_state.get(ck_data)
            else:
                try:
                    with st.spinner(t("converting_docx")):
                        docx_bytes = markdown_to_docx(final_md)
                    st.session_state[ck_md] = final_md
                    st.session_state[ck_data] = docx_bytes
                except Exception as exc:
                    st.warning(f"{t('docx_fail')}: {exc}")

            base = Path(src).stem
            dl = st.columns(3)
            if docx_bytes:
                dl[0].download_button("⬇️ Edited .docx", data=docx_bytes,
                                      file_name=f"{base}.edited.docx",
                                      mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                      use_container_width=True, key=f"dl_docx_{src}")
            dl[1].download_button("⬇️ Edited .md", data=final_md.encode(),
                                  file_name=f"{base}.edited.md", mime="text/markdown",
                                  use_container_width=True, key=f"dl_md_{src}")
            dl[2].download_button("⬇️ Diff .md", data=final_diff.encode(),
                                  file_name=f"{base}.diff.md", mime="text/markdown",
                                  use_container_width=True, key=f"dl_diff_{src}")
            with st.expander(t("preview_md"), expanded=False):
                st.code(final_md[:10000], language="markdown")


# ==========================================================================
# Auto-refresh while tasks are running
# ==========================================================================

if has_active():
    time.sleep(3)
    st.rerun()
