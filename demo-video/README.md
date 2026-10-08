# Intro-video recorder

Scripted, portrait (1080×1920, 30 fps) screen recordings of Bethaniel for the
intro video: one clip per task per language, framed as a desktop window with
a camera that zooms to whatever is happening and a drawn mouse pointer. No
sound — that is added in the edit.

Not part of the app and not in the npm workspaces.

## Clips

| File | What happens |
|---|---|
| `en-1-writing-feedback.mp4` / `da-…` | upload → **Improve my writing** → run → scroll the writing report |
| `en-2-copy-edits.mp4` / `da-…` | upload → **Find errors** → run → answer six suggestions in the review deck (one Dismiss, the rest Accept) → scroll the result |
| `en-3-publication-scan.mp4` / `da-…` | upload → **Final readthrough** → run → scroll the publication-readiness report |
| `en-4-style-guide.mp4` | upload → **Find errors** → open **Style guide** → close-ups along the names & terms list → type a note into "Your own notes" → save. Nothing is run. English only |
| `en-5-translation.mp4` / `da-…` | upload → **Translate** → pick the language → type a 100% code → **Run in Cloud** → accept → Betty's questions (tone, then hers, one card at a time) → run → scroll the translation. Only with `--task translate --code CODE`; each take spends one use of the code |

English uses `texts/The Weather Station.md` (5 chapters, ~1,550 words) and an
English interface; Danish uses `texts/Bogbinderen i Havnsø.md` (4 chapters, ~2,300
words) and a Danish interface. Both have planted errors, from `sample_texts/`.

The style-guide clip needs names no dictionary knows, or the names & terms
list comes up empty (Marta and Erik are ordinary names). It uploads
`private/Rage of the Rule.md` instead: the first three chapters of a real
book, gitignored, so it has to be in place on the machine that records.
The style sheet is one per install, so the clip puts back whatever was in
it before.

Each clip gets a `.markers.json` beside it: the second at which the upload,
the task choice, Run, the finish and the results begin — for cutting. The
wait between `run pressed` and `done` is recorded in real time; speed it up
or cut it in the edit.

## Setup (once)

Needs Node 22+ and `ffmpeg` on the PATH (`brew install ffmpeg`,
`winget install ffmpeg`, or `apt install ffmpeg`).

```bash
cd demo-video
npm install
npx playwright install chromium
```

## Recording

1. Open Bethaniel (updated to the current version) and leave it open. Make
   sure the local model is installed: the script presses **Run Betty
   locally**, never the cloud button.
2. Run:

```bash
node record.mjs                        # all six clips, into out/
node record.mjs --lang da --task scan  # just one
node record.mjs --dry                  # everything up to Run — checks framing in ~2 min
```

The script finds the open app on its own (through `backend-port.json` in the
app's data folder) and drives it from its own hidden browser, so the window
on your screen is untouched. What it does is real, though: each clip uploads
its manuscript and runs the job in your app, so the two demo manuscripts will
appear in the app's document list afterwards.

| Option | Default | |
|---|---|---|
| `--lang en,da` | both | Which languages |
| `--task writing,errors,scan` | all three | Which tasks |
| `--out DIR` | `out/` | Where the clips go |
| `--decisions N` | 6 | Suggestions answered in the copy-edit deck |
| `--max-scroll S` | 60 | Longest the results scroll may run, in seconds |
| `--timeout M` | 30 | Give up on a job after M minutes |
| `--code CODE` | — | A 100% Betty in the Cloud code for the translation clip (mint one translation-only, see `worker/README.md`) |
| `--url URL` | found automatically | Point at a specific backend, e.g. `http://127.0.0.1:4000` for `npm run dev` |
| `--headed` | off | Show the recording browser |
| `--keep-frames` | off | Keep the raw JPEG frames |

The translation clip uses `texts/The Ferryman of Kragehøj.md` in English (into
French) — a short story written to give Betty something to ask about: a place
name, an invented word, "Mr", miles and a book title — and the Danish demo
manuscript in Danish (into English). It claims the paid credential through the
browser's paste-code field, hidden, which is the same claim the desktop app
makes when payment hands back through `bethaniel://`. Betty's questions come
from the model, so they differ a little between takes.

If a clip fails (Run not ready, a dialog opened, the job timed out) the
script says why and moves on to the next one.

## Changing the look

- **Window size, frame size**: `APP` and `STAGE` at the top of `record.mjs`.
  The window is 960 px wide because that is the narrowest width that keeps
  the sidebar and an unclipped header; wider shrinks the results text.
- **Camera, pointer, window frame, background**: `stage.html`.
- **Pacing**: the `sleep(...)` calls in `recordClip`, and `pxPerSec` /
  `pauseMs` in `readThrough`.
