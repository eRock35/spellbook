# For Claude: this repo

Spellbook — a shared prompt library that is *also* the view-tracking backend for
every app on `strongtechnicalconsulting.com`. See `README.md` for what the app
does and the full data model.

**This repo is public** (it holds no secrets, no PII, no credentials — those
live in Secret Manager and env vars). The deployed app is open to registration,
but anything that spends Anthropic tokens is approval-gated; see below.

Cloud Run service `spellbook`, Firestore database `spellbook`, GCP project
`metal-celerity-236019`, `us-central1`. Repo name, service, database and
`gcpdeploy` alias are all the same word on purpose.

## The one rule that must not drift

**Never put an Anthropic call behind `requireLogin` alone.** Registration is
open, so a login-only gate lets any stranger who finds the URL run Opus 5 on
Erik's API key. Every model call goes behind `requireAiAccess`, which demands
`aiAccess === 'approved'` — granted by hand by the admin.

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

## What the analytics path stores

Stored: app name, coarse path, referrer **host**, an opaque random visitor id in
a first-party cookie, and counters.

Not stored: IP addresses, user agents, full referrer URLs, query strings, or any
link to a signed-in identity. Enough to count and rank, not enough to follow a
person. Don't add an IP column "just for geo" without deciding that tradeoff out
loud.

**`santa-rosa-beach-trip` is not in the tracked-app allowlist in `analytics.js`
and must not be added.** It is private, holds family PII, and its hostname is
deliberately kept off public surfaces — `/api/stats/public` is a public surface
and this repo is public. `test/analytics.test.js` asserts its absence so the
addition fails loudly rather than quietly.

## Indexes and the in-memory filter

Five composite indexes, in `firestore.indexes.json`, backing the four
visibility+sort pairs and `authorId`+`updatedAt`. Platform, category and tag
filtering is applied **in memory** over a bounded window (`SCAN_LIMIT` in
`server.js`) rather than as more composite indexes — one index instead of a
dozen at this size, with a cutoff that is visible rather than a silently wrong
query. Revisit past a few thousand public prompts.

## Charts

`public/dashboard.html` follows a validated categorical palette: slots 1–5 of
the default data-viz palette, light and dark steps chosen separately (the dark
column is not an automatic flip). Colour is assigned from the fixed `APP_ORDER`
list, **never by rank** — a filter or a reshuffle must not repaint the
survivors. One y-axis, never two. The table view is a peer of the chart, not a
fallback: it is also the relief the palette's light-mode contrast warning
requires. If you add a sixth app, fold it in rather than generating a hue.

## Deploy

`gcpdeploy ship spellbook` from `eriks-projects`
(`.claude/skills/deploy/`), then `gcpdeploy verify spellbook`. The deploy
tooling and runbook live in that repo, not this one — it is shared across all
the apps. No `gcloud`, no local Docker; direct REST calls.

`verify` forces the `spellbook-rollup` Scheduler job and reads back
`control/rollup`. An empty `status` `{}` with a fresh `lastAttemptTime` proves
Cloud Run booted, the secrets mounted, the cron key matched and the handler
reached Firestore.

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
