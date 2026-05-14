#!/usr/bin/env bash
#
# edit_docx.sh — One-command wrapper for the full editing pipeline.
#
# Takes a .docx (or .md) input, runs it through book_editor.py, and produces
# an edited .docx ready to import into Scrivener. The intermediate Markdown
# files and the diff report are kept for review.
#
# Usage:
#   ./edit_docx.sh mybook.docx
#   ./edit_docx.sh mybook.docx --model qwen3:14b --words 2000
#
# Output files (next to the input):
#   mybook.md             — Markdown converted from input (intermediate)
#   mybook.edited.md      — Edited Markdown
#   mybook.edited.docx    — Edited DOCX (import this into Scrivener)
#   mybook.diff.md        — Diff report (review every change!)

set -euo pipefail

# --- Argument parsing -----------------------------------------------------

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <input.docx|input.md> [book_editor.py options...]" >&2
  exit 1
fi

INPUT="$1"
shift
EXTRA_ARGS=("$@")

if [[ ! -f "$INPUT" ]]; then
  echo "Error: file not found: $INPUT" >&2
  exit 1
fi

# --- Locate the script directory so book_editor.py is found ---------------

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
EDITOR_PY="$SCRIPT_DIR/book_editor.py"

if [[ ! -f "$EDITOR_PY" ]]; then
  echo "Error: book_editor.py not found next to this script ($EDITOR_PY)" >&2
  exit 1
fi

# --- Dependency checks ----------------------------------------------------

if ! command -v pandoc >/dev/null 2>&1; then
  echo "Error: pandoc not installed. Run: brew install pandoc" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 not found." >&2
  exit 1
fi

# --- Derived paths --------------------------------------------------------

INPUT_DIR="$( cd "$( dirname "$INPUT" )" && pwd )"
INPUT_BASE="$( basename "$INPUT" )"
INPUT_STEM="${INPUT_BASE%.*}"
INPUT_EXT="${INPUT_BASE##*.}"

MD_INPUT="$INPUT_DIR/$INPUT_STEM.md"
MD_EDITED="$INPUT_DIR/$INPUT_STEM.edited.md"
DOCX_EDITED="$INPUT_DIR/$INPUT_STEM.edited.docx"
DIFF_FILE="$INPUT_DIR/$INPUT_STEM.diff.md"

echo "================================================================"
echo "  edit_docx.sh — full pipeline"
echo "================================================================"
echo "Input:           $INPUT"
echo "Markdown (in):   $MD_INPUT"
echo "Markdown (out):  $MD_EDITED"
echo "DOCX (out):      $DOCX_EDITED"
echo "Diff report:     $DIFF_FILE"
echo "================================================================"

# --- Step 1: convert input to Markdown (if not already .md) ---------------

if [[ "$INPUT_EXT" == "md" || "$INPUT_EXT" == "markdown" ]]; then
  echo "[1/3] Input is already Markdown — skipping conversion."
  MD_INPUT="$INPUT"
else
  echo "[1/3] Converting $INPUT_EXT → Markdown ..."
  pandoc "$INPUT" -f "$INPUT_EXT" -t markdown -o "$MD_INPUT" --wrap=none
  echo "      Wrote $MD_INPUT"
fi

# --- Step 2: run the editor ----------------------------------------------

echo "[2/3] Running book_editor.py (this is the slow step) ..."
python3 "$EDITOR_PY" "$MD_INPUT" \
  --output "$MD_EDITED" \
  --diff "$DIFF_FILE" \
  "${EXTRA_ARGS[@]}"

# --- Step 3: convert edited Markdown back to DOCX -------------------------

echo "[3/3] Converting edited Markdown → DOCX ..."
pandoc "$MD_EDITED" -f markdown -t docx -o "$DOCX_EDITED" --standalone
echo "      Wrote $DOCX_EDITED"

# --- Done ------------------------------------------------------------------

echo "================================================================"
echo "  ✅ Done."
echo "================================================================"
echo "  Review: $DIFF_FILE"
echo "  Import: $DOCX_EDITED  →  Scrivener (File → Import → Files)"
echo "================================================================"
