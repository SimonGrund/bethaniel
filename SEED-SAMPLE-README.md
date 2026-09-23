# Sample review data (temporary — delete this file when done)

Three finished tasks are seeded into `backend/data/bethaniel.db` so the review
screens can be looked at without running a model.

## To see them

```bash
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
sqlite3 backend/data/bethaniel.db "delete from tasks where id like 'seed-%';"
rm backend/seed-sample.mjs SEED-SAMPLE-README.md
```
