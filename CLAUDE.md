# For Claude: this repo

Spellbook — a shared prompt library. See `README.md` for what the app does and
the full data model.

It used to be *also* the view-tracking backend for every app on the domain.
That moved to `eriks-projects/lib/views.js` on 2026-09-22 — Erik's numbers for
seven apps had no business living inside one of the seven, and the reason they
did (the landing service being "static and dependency-light") had stopped
being true well before the split — that service already carries a Firestore, an
admin gate, the identity store, an uptime prober and a cron. Spellbook now reports itself through the same
`public/beacon.js` every other app carries, and nothing more.

**This repo is public** (it holds no secrets, no PII, no credentials — those
live in Secret Manager and env vars). The deployed app is open to registration,
but anything that spends Anthropic tokens needs the shared account and a
budget; see below.

Cloud Run service `spellbook`, Firestore database `spellbook`, GCP project
`metal-celerity-236019`, `us-central1`. Repo name, service, database and
`gcpdeploy` alias are all the same word on purpose.

## The one rule that must not drift

**Never put an Anthropic call behind `requireLogin` alone.** Registration is
open, so a login-only gate lets any stranger who finds the URL run Opus 5 on
Erik's API key.

The gate is `requireLogin, requireSharedAccount, identity.requireBudget,
identity.requireDailyCap`. `requireSharedAccount` is the load-bearing one and
is easy to mistake for ceremony: `requireBudget` deliberately waves through a
request carrying no identity session, because most apps here are readable
signed-out and it must not 402 a passer-by. On its own it would therefore let
any registered Spellbook user spend unmetered. Spellbook's own sign-in carries
no balance and never will — the ledger is on the shared account — so the
honest answer to "may this person spend" is "not until we know who they are
across the domain".

This replaced `requireAiAccess`, which demanded `aiAccess === 'approved'` from
the admin by hand. Same reasoning as trip-planner's: a person approving people
one at a time is a slower version of a budget that never actually bounded
anything. `requireAiAccess` still exists and is on no route — do not put it
back in front of a model call.

There are exactly two call sites, both in `server.js`: `/api/ai/draft` and
`/api/prompts/:id/improve`. Both funnel through `proposePrompt()`. If you add a
third, gate it the same way.

`/api/cron/rollup` is deliberately *not* gated that way — it calls no model, it
is arithmetic, so it is free to run. Don't "helpfully" make it summarise
anything with Claude; that would turn a free tick into a billable one.

## Confirm-before-save is deliberate

Both AI routes return a **proposal** and write nothing. The frontend renders it
as Apply/Discard and only the user's own tap hits the ordinary create/patch
route. This is the same shape as `trip-planner`'s schedule changes, and it is
the point: an LLM never silently rewrites someone's saved prompt. Improving
*someone else's* prompt opens a remix rather than editing theirs.

Keep this shape if you touch that flow.

## `accounts.js` is a fork, not a shared file

It was copied from `trip-planner`'s `accounts.js` on 2026-09-22 because the
access model was already settled there. It is **a fork**. The four apps' auth
modules diverged on purpose:

- `santa-rosa-beach-trip` — single-account, deliberately.
- `college-football-app` — per-email accounts with its own research allowlist.
- `trip-planner` — multi-user, `accounts.js`.
- here — multi-user, forked from trip-planner's, and free to drift.

**Never "re-sync" any of them from another.** Copying the football or vacation
version in here would replace open registration with a one-account gate;
copying this one out would do the reverse to an app that does not want it.

## View tracking lives on the landing service now

`analytics.js`, `public/dashboard.html` and `test/analytics.test.js` are gone
from this repo. They are `lib/views.js`, `site/views.html` and `test/views.js`
in `eriks-projects`, served at `/api/beacon`, `/api/stats/public` and the
admin-gated `/admin/views` on the root domain. Everything that used to be said
here about what is stored, what is deliberately not, and why
`santa-rosa-beach-trip` may never join the allowlist is said there now, next to
the code that enforces it.

What stays here is one line in `public/index.html`:

```html
<script src="/beacon.js" data-app="spellbook" async></script>
```

`beacon.js` is a **copy** — the source is `eriks-projects/shared/beacon.js` and
`scripts/sync-shared.js` keeps it honest. Don't edit it here.

## Indexes and the in-memory filter

Five composite indexes, in `firestore.indexes.json`, backing the four
visibility+sort pairs and `authorId`+`updatedAt`. Platform, category and tag
filtering is applied **in memory** over a bounded window (`SCAN_LIMIT` in
`server.js`) rather than as more composite indexes — one index instead of a
dozen at this size, with a cutoff that is visible rather than a silently wrong
query. Revisit past a few thousand public prompts.

## Deploy

`gcpdeploy ship spellbook` from `eriks-projects`
(`.claude/skills/deploy/`), then `gcpdeploy verify spellbook`. The deploy
tooling and runbook live in that repo, not this one — it is shared across all
the apps. No `gcloud`, no local Docker; direct REST calls.

`verify` forces the `spellbook-rollup` Scheduler job and reads back
`control/rollup`. An empty `status` `{}` with a fresh `lastAttemptTime` proves
Cloud Run booted, the secrets mounted, the cron key matched and the handler
reached Firestore. The rollup no longer writes a cross-app view snapshot — that
moved with the tracker — but it still rescores prompts, so it remains the right
end-to-end probe.

You cannot curl the live app from a session container — the proxy blocks
`*.run.app` and the custom domains. Verify through GCP's own APIs and ask Erik
to open a browser.

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
