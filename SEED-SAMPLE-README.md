# Sample review data (temporary — delete this file when done)

Three finished tasks are seeded into the INSTALLED app's database
(`~/Library/Application Support/Bethaniel/data/bethaniel.db`) so the review
screens can be looked at without running a model.

That is the database the Electron window uses. `npm run dev` starts TWO
backends: the workspace one on :4000 against `backend/data` (what a browser at
:5173 talks to), and a second forked by Electron against Application Support
(what the app window talks to). The sample is in the second, so it shows up in
the app window.

## To see them

**Restart the app if it is already running.** The backend reads finished tasks
from the database only at startup (`loadTaskStates`, queue.ts) and then serves
its in-memory copy, so a server that was up before these rows were written
will not know about them — the run simply does not appear.

```bash
pkill -f "tsx src/index.ts"   # only if something is already on :4000
npm run dev
```

Then: **Former Runs** → *Results for vaelfyre-sample.docx* → pick
**Chapter One** → **Review suggestions**.

Two jobs are seeded:

| job | what it shows |
|---|---|
| `job-copyedit` | the copy-edit deck — a fix-less finding with **Add to dictionary** / **Correct to** |
| `job-scan` | the same findings on a scan job — read-only, "Unknown spelling", no actions |

The scan job only appears if you pick its chapter from the run list; both are
under the same "Former Runs" view.

## What to look for

- `vaelfyre`, `barque`, `Per'aps` — reported with **no suggestion**. These are
  the new card: no accept/dismiss, two real actions instead.
- `form the` → `from the` — a confusable pattern, an ordinary correction, so
  it still has Accept/Dismiss. The two shapes sit side by side.
- Typing into **Correct to** and pressing Apply should advance the deck
  (`0 of 4 decided` → `1 of 4`).
- **Add to dictionary** should withdraw every finding for that word and drop
  the total (`4` → `3`).

## To remove

```bash
sqlite3 ~/Library/Application\ Support/Bethaniel/data/bethaniel.db \
  "delete from tasks where id like 'seed-%';"
rm backend/seed-sample.mjs SEED-SAMPLE-README.md
```

A backup of the database as it was before seeding is in `/tmp` —
`bethaniel-appsupport-backup-*.db` — if anything looks wrong.

## One side effect worth knowing

The app keeps the newest 200 finished tasks and prunes the rest at startup
(`MAX_KEPT_TASKS`). The database held 233; adding three pushes three of the
oldest out on the next launch — proofread tasks for *Hand of the Giver V2*
from 16 September. They were already past the limit and would have gone at the
next prune regardless, but the seeding brings it forward by three.
