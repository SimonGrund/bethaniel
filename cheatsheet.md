# Ollama & Aider Cheat Sheet

## Ollama — Service Management

```bash
brew services start ollama       # start (auto-starts on login)
brew services stop ollama        # stop (frees RAM)
brew services restart ollama     # restart
brew services list               # check if running
```

## Ollama — Manual Run (live logs in terminal)

```bash
brew services stop ollama        # stop the background service first
ollama serve                     # run in foreground with visible logs
```

## Run Book software

```
~/Documents/Bethaniel/Code/launch_ui.sh
```

## Ollama — Logs (when running as brew service)

```bash
tail -f ~/.ollama/logs/server.log
```

## Ollama — Models

```bash
ollama list                      # show installed models + sizes
ollama pull qwen3:32b            # download a model
ollama rm modelname              # delete a model (frees disk)
ollama show betty                # show model details (params, system prompt)
ollama search gemma              # search available models online
ollama ps                        # shows loaded models + VRAM usage
```

## Ollama — Chat

```bash
ollama run betty                 # chat with Betty
ollama run qwen3:32b             # chat with any model
ollama run betty --think=false   # disable thinking mode
```

### Inside a chat session

```
/set quiet           # hide stats
/set verbose         # show stats
/set nothink         # disable thinking
/?                   # show all commands
/bye                 # exit
```

## Ollama — Environment Tweaks

```bash
launchctl setenv OLLAMA_KEEP_ALIVE 24h    # keep model loaded in RAM
brew services restart ollama               # apply after env change
```

---

## Aider

### Start

```bash
source ~/Documents/Bethaniel/.venv/bin/activate   # activate venv first
aider --model ollama/qwen3:32b                     # start with a model
aider --model ollama/betty                         # start with Betty
```

### Inside Aider

```
/add file.py             # add a file to the chat context
/drop file.py            # remove a file from context
/ls                      # list files in context
/diff                    # show pending changes
/undo                    # undo last edit
/commit                  # commit changes to git
/clear                   # clear chat history
/help                    # show all commands
/quit                    # exit
```

---

## Book Editor UI

### Launch

```bash
~/Documents/Bethaniel/Code/launch_ui.sh
```

### CLI (no UI)

```bash
source ~/Documents/Bethaniel/.venv/bin/activate

# Full book
python Code/book_editor.py mybook.md --model qwen3:32b

# With style guide + options
python Code/book_editor.py mybook.md --style-guide style.md --words 2500 --overlap 1

# DOCX workflow (converts both ways)
Code/edit_docx.sh mybook.docx

# Overnight run
nohup Code/edit_docx.sh mybook.docx > edit.log 2>&1 &

# Consistency checker (no LLM, instant)
python Code/consistency_checker.py mybook.md
```

---

## Quick Combos

```bash
# Start everything fresh
brew services start ollama && ~/Documents/Bethaniel/Code/launch_ui.sh

# Kill everything
brew services stop ollama        # stops Ollama
# Ctrl+C in the terminal running launch_ui.sh stops the UI

# Check what's eating RAM
ollama ps                        # shows loaded models + VRAM usage
```
