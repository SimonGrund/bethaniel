# Cron Triggers do not fire on this Cloudflare account

Investigated 8 September 2026. **Not a Bethaniel bug** — reproduced on a
four-line Worker with no dependencies.

## What happens

`bethaniel-cloud` declares `crons = ["0 * * * *"]`. Wrangler reports the
trigger deployed, and the dashboard (Settings → Trigger Events) shows the cron
registered with a next-run time. The `scheduled()` handler is never invoked.

Observed over ~95 minutes from first deploy:

- 93 quotes still in D1 that the sweep deletes after 15 minutes
- 0 credentials swept, including one force-expired to the year 2020
- `wrangler tail` across two full minute boundaries at `* * * * *`: zero
  scheduled invocations

The same Worker's `fetch` handler served every request correctly throughout.

## The isolating test

To rule out Durable Objects, D1, the `[[unsafe.bindings]]` rate limiter, or
anything else in this codebase, a separate Worker was deployed to the same
account containing nothing else:

```toml
name = "bethaniel-crontest"
main = "index.js"
compatibility_date = "2026-09-01"

[triggers]
crons = ["* * * * *"]
```

```js
export default {
  async fetch() { return new Response("crontest alive"); },
  async scheduled(event) {
    console.log("CRONTEST FIRED at " + new Date().toISOString() + " cron=" + event.cron);
  },
};
```

Deployed successfully, `schedule: * * * * *` confirmed in the output. Tailed
for 90 seconds — which contains at least one minute boundary — while a request
was made to its `fetch` handler as a control:

```
fetch events captured: 1        <- tail is working
scheduled events:      0        <- cron never fires
event types seen:      "request"
```

A minimal Worker whose only purpose is a cron trigger does not fire either. The
problem is account- or platform-side, not in this repository.

## What it does NOT appear to be

- Not the Worker's code — reproduced with four lines.
- Not the config — wrangler and the dashboard both report the trigger deployed.
- Not Durable Objects, D1, or the unsafe rate-limit binding — absent from the
  minimal Worker.
- Not `wrangler tail` missing scheduled events — the control fetch appeared in
  the same tail session.
- Not propagation delay — first deploy was 15:57 UTC; nothing by 18:45.

## Impact

`/admin/sweep` exists because of this and covers it manually, but three things
silently do not happen on their own: credential expiry, quote-table cleanup,
and automatic refunds. The last is the serious one — the success page promises
automatic refunds in writing. See `docs/launch-checklist.md`.

## Next steps

1. Raise with Cloudflare support with the reproduction above. Account
   `7f0aa4b368ca2c7a89d3469015e7765d`, Worker `bethaniel-crontest`.
2. Meanwhile, drive `POST /admin/sweep` from something that does run — a
   scheduled GitHub Action is the obvious candidate, since the repo is already
   on GitHub and the admin token can be a repository secret.
3. `bethaniel-crontest` is still deployed as the reproduction. Delete it once
   support has what they need.
