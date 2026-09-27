# docs/

Analysis and decision records for the Bethaniel repository. Not the website.

## The website lives elsewhere

`bethaniel.eu` is published from **[SimonGrund/bethaniel_webpage](https://github.com/SimonGrund/bethaniel_webpage)**
via Vercel, and that repository is the only copy. `performance.html` and
`how-it-works.html` used to be duplicated here as well, and were removed on
9 September 2026 after the two copies disagreed with each other in public:
the live page said Betty runs one editor agent and one reviewer, while the
copy in this repository still described three editors and two reviewers.

Nothing served the copies here — GitHub Pages is not enabled on this repo — so
the stale version rendered perfectly and looked authoritative to anyone reading
the source. That is the same failure shape as a benchmark that runs with its
grammar checks off: wrong, and indistinguishable from right.

**To change the site, edit `bethaniel_webpage`.** Vercel deploys on push.

The numbers on the performance page come from this repository — regenerate them
with `npx tsx scripts/test-models.ts`, derive the figures with
`scripts/performance-summary.ts` (it writes `sample_texts/performance_summary.json`),
and carry them across by hand. That
is deliberate friction: the page makes claims a customer reads, and a copy step
is a reasonable place to be reminded of it.

## What is here

| File | What it is |
|---|---|
| `language-quality-roadmap.md` | What the editor gets wrong, ranked, with what was tried |
| `cloud-token-model.md` | Tokens per pass as the provider bills them, and the model the cloud estimate is fitted to |
| `energy.md` | Electricity per 60,000-word copy edit: measured for Local Betty, estimated for the cloud |
| `missing-words.md` | How the dropped-word check was chosen: the prompt routes that failed, the verdict comparison, per-language results |
| `launch-checklist.md` | What stands between the current deployment and taking real money |
| `admin-surface.md` | Planned operator endpoints, and the questions behind them |
| `cloud-provider-options.md` | Inference providers surveyed and measured |
| `languagetool-is-load-bearing.md` | Why grammar checks are not optional, and what it cost to learn |
| `comma-scoring.md` | Why the comma number is two measurements, and what splitting them shows |
| `cron-investigation.md` | Cloudflare cron triggers do not fire on this account |
