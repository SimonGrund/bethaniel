# Bethaniel Book Editor — Final Pre-Print Pipeline

A local, private, conservative copy-editing pipeline for long-form Markdown
manuscripts. Designed for the **final pass before sending to print** — fixes
objective errors only, never rewrites for style.

Runs entirely on your machine via Ollama. Nothing leaves the laptop.

---

## What's in this folder

| File                     | Purpose                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `book_editor.py`         | LLM-based corrections pass (chunked, with diff report)        |
| `consistency_checker.py` | Whole-book scan for spelling/typography/style inconsistencies |

---

## One-time setup

```bash
# 1. Ollama (already done if you've been following along)
brew install ollama
brew services start ollama

# 2. The model — best balance of quality + speed for editing on M1 Pro 32GB
ollama pull qwen3:32b

# 3. Python deps
pip install ollama

# 4. Optional but recommended deterministic linters
brew install vale proselint
```

---

## The recommended workflow

This is a **5-stage pipeline**. Each stage catches things the others miss.
Skipping stages = bugs in print.

### Stage 0 — Back up

```bash
cp mybook.md mybook.original.md
git init && git add -A && git commit -m "pre-edit baseline"
```

### Stage 1 — Build a style guide (5–15 minutes, do this once)

Create `style.md` next to your manuscript. List anything the LLM might
"correct" but shouldn't. Example:

```markdown
# Style guide for My Book

## Names — never alter spelling

- Bethaniel (also: Betha, Betty)
- Other character names...
- Invented place names...

## Invented words — never alter

- starlight-folk
- gloamtide

## Intentional choices — leave alone

- British spelling throughout (colour, realise, organisation)
- Curly quotes everywhere ("..." not "...")
- Em-dash with no spaces — like this
- Sentence fragments are used for rhythm. Keep them.
- Comma splices in dialogue are intentional character voice.
```

This file is injected into every chunk's system prompt.

### Stage 2 — Whole-book consistency scan (deterministic, fast)

```bash
python consistency_checker.py mybook.md
```

Produces `mybook.consistency.md` listing:

- Words spelled multiple ways ("grey" vs "gray")
- Possible name misspellings ("Bethaniel" vs "Bethanial")
- Hyphenation variants ("well-known" vs "well known")
- Quote/dash/ellipsis style mixing
- Numbers as digits vs words
- Duplicate consecutive words

**Review the report and fix obvious issues by hand BEFORE running the LLM
pass.** Many of these are issues the per-chunk LLM pass cannot detect because
each chunk is processed in isolation.

### Stage 3 — Deterministic prose linters (optional, fast)

```bash
proselint mybook.md > proselint.txt
vale mybook.md > vale.txt
```

Skim the output for anything you want to address by hand. These are fast
sanity checks before the slow overnight pass.

### Stage 4 — LLM corrections pass (overnight)

**First, test on one chapter:**

```bash
# Extract chapter 1 to a test file
sed -n '/^# Chapter 1/,/^# Chapter 2/p' mybook.md > test.md

python book_editor.py test.md \
  --model qwen3:32b \
  --style-guide style.md \
  --words 2500 \
  --overlap 1
```

Review `test.diff.md` carefully. If you see the model rewriting things you
didn't want changed, **strengthen `style.md`** before running the full book.

**Then, the full overnight run:**

```bash
nohup python book_editor.py mybook.md \
  --model qwen3:32b \
  --style-guide style.md \
  --words 2500 \
  --overlap 1 \
  > edit.log 2>&1 &
```

For a 100k-word book on M1 Pro 32GB this takes roughly **2–4 hours**. Wake
up to a fully edited manuscript.

### Stage 5 — Human review of the diff

```bash
open mybook.diff.md   # opens in VS Code
```

The diff file shows every single change as a colored diff block. Walk
through it chunk by chunk:

- ✅ Accept clear corrections (typos, duplicate words, wrong-word usage)
- ❌ Reject any rewrites or "improvements" — copy the original back into
  `mybook.edited.md` for those passages
- ⚠️ Pay extra attention to chunks marked with **Formatting warnings** —
  those had a structural change (paragraph count, heading count, etc.) and
  may indicate the model lost or duplicated content

### Stage 6 — Final consistency re-check

After the LLM pass, run the consistency checker again on the edited file:

```bash
python consistency_checker.py mybook.edited.md
```

Confirm that the LLM didn't _introduce_ new inconsistencies (e.g. by
"correcting" "grey" to "gray" in some chunks but not others).

### Stage 7 — Send to Atticus for print

Open `mybook.edited.md` in Atticus and let it handle typography
(smart quotes, em-dash spacing, drop caps, etc.). Atticus has its own
typography pass — that's why the LLM was instructed not to touch quote/dash
styles.

---

## Reference: `book_editor.py` flags

```
python book_editor.py INPUT [options]

  --output PATH         Output .md (default: <input>.edited.md)
  --diff PATH           Diff .md (default: <input>.diff.md)
  --model NAME          Ollama model (default: qwen3:32b)
  --words N             Target words per chunk (default: 2500)
  --overlap N           Paragraphs of overlap between chunks (default: 1)
  --style-guide PATH    Style guide .md to inject into every prompt
```

### Tuning notes

- **`--words 2500`** is the sweet spot. Larger = fewer requests but the
  model "forgets" the instructions partway through and starts paraphrasing.
  Smaller = slower and more boundary glitches.
- **`--overlap 1`** gives the model 1 paragraph of context from the previous
  chunk so it doesn't lose track of who pronouns refer to. Set to `0` for
  pure speed; set to `2` for prose with very long pronoun chains.
- **Don't lower `temperature`** below 0.1 — Ollama can hang or output empty
  strings.

---

## Reference: `consistency_checker.py` flags

```
python consistency_checker.py INPUT [options]

  --report PATH            Output .md (default: <input>.consistency.md)
  --min-occurrences N      Min total occurrences to flag a variant (default: 2)
```

---

## What this pipeline will NOT catch

Be honest with yourself — these still need a human:

- **Continuity errors** (timeline, locations, character details across chapters)
- **Plot inconsistencies** (X knows something they shouldn't yet)
- **Dialogue attribution mistakes**
- **Internal cross-references** ("as I mentioned in chapter 4...")
- **Anything semantic** the model isn't equipped to judge

Use the LLM as a **typo and grammar safety net**, not as your editor.

---

## Crash recovery

`book_editor.py` writes the output and diff incrementally. If the script
dies at chunk 47/100:

1. The first 46 chunks are already saved in `<input>.edited.md`
2. Find the last successfully-edited paragraph in the output file
3. Make a `mybook.partial.md` containing only the unedited remainder
4. Run `book_editor.py mybook.partial.md` to continue from there
5. Concatenate the two output files

---

## Troubleshooting

**"Model returned empty response"**
The model's context window filled up. Lower `--words` to 2000.

**"Formatting changed" warnings on every chunk**
The model is paraphrasing. Strengthen the style guide and consider switching
to a stricter model: `ollama pull qwen3:14b` is sometimes more obedient than
the larger variant.

**Output is much shorter than input**
The model summarized instead of editing. Re-run with a stronger style guide
emphasizing "preserve every sentence."

**Italics/bold are missing in output**
The model dropped Markdown markers. Run `consistency_checker.py` on the
output and check the formatting signature warnings in the diff file.
