# Spellbook

A shared prompt library, plus the view-tracking backend for every app on
`strongtechnicalconsulting.com`.

Runs as Cloud Run service `spellbook` in `us-central1`, GCP project
`metal-celerity-236019`, with its own Firestore database (`spellbook`, Native
mode). It lives in this repo under `spellbook/` rather than in a repo of its
own — see "Why it's in this repo" below.

## What it does

**Publish a prompt.** Title, body, a one-line summary, the platforms it's
written for (Claude, Claude Code, ChatGPT, Gemini, Copilot, Cursor,
Perplexity, Grok, Midjourney, raw API, a local model, other), an optional model
list, a category and free-text tags. Public by default; private if you'd rather
keep it to yourself.

**Fill in the blanks.** Wrap anything the reader should substitute in
`{{double braces}}` and Spellbook turns those into a form. Fill it in, hit
copy, and you get the finished prompt — not a template you have to hand-edit.
This is the difference between a library and a notes app.

**Vote.** One vote per account, changeable, revocable, and not on your own
prompts. Counters are updated in a transaction alongside the vote document, so
the score can never drift from the votes that justify it.

**Save and remix.** Save someone's prompt to your own list. Remix it into your
version and the copy keeps a link back to the original with its author's name —
attribution is the price of a fork being welcome rather than rude, and it's also
how an author finds out their prompt turned into five better ones.

**Sort by what's actually good.** Four sorts — Trending, Top, New, Most used.
"Most used" is copy count, which is the strongest signal in the app: a copy is
someone actually using the thing, where a vote is only an opinion. Trending
weights copies above saves above votes, then decays with age, so the front page
turns over instead of freezing on whatever once went round a group chat.

**Draft or improve with Claude** (`claude-opus-5`). Describe what you need and
get a draft; or ask for an existing prompt to be tightened. Both return a
*proposal* rendered as Apply/Discard — nothing is written until you tap Apply.
Improving someone else's prompt opens it as a remix rather than editing theirs.

## Views are counted on the root domain, not here

Spellbook used to be the view-tracking backend for every app on the domain: the
beacon landed here, the dashboard lived at `/dashboard.html`, and the landing
page read `GET /api/stats/public` from this service. That moved to the landing
service on 2026-09-22 — the counts for seven apps had no business living inside
one of the seven.

It is `lib/views.js`, `site/views.html` and `test/views.js` in `eriks-projects`
now, serving `POST /api/beacon`, `GET /api/stats/public` and the admin-gated
`/admin/views` from the root domain. What is stored and what deliberately is
not — and why `santa-rosa-beach-trip` is absent from the allowlist and must
stay absent — is documented there, beside the code that enforces it.

Spellbook's remaining part is one tag in `public/index.html`:

```html
<script src="/beacon.js" data-app="spellbook" async></script>
```

`public/beacon.js` is a copy of `eriks-projects/shared/beacon.js`; edit it there
and run `node scripts/sync-shared.js`.

## It comes with a shelf

A fresh install writes twelve starter prompts — real ones, across coding,
writing, analysis, learning and productivity, each with `{{blanks}}` so the
fill-in form has something to show. They are written once and are then ordinary
prompts: votable, remixable, editable, deletable. A restart does not bring back
one you deleted.

See `seed.js`, which explains why this is a write-once seed rather than the
read-path seeds the sibling apps use.

## Sign-in and the AI gate

Open registration (email + a 10-character minimum password), with a passkey
addable afterwards for Face ID. Accounts are `users/<uid>` where `uid` is the
base64url of the lowercased email — deterministic, so `create()` fails on a
duplicate rather than needing a uniqueness index Firestore doesn't have.

**Reading takes no account at all** — the public library, and any prompt in it,
is open to anyone. Everything that writes needs a session.

Everything free is free the moment you sign up: publish, vote, save, remix.

**Anything that calls Claude needs the shared account and a budget** — the gate
is `requireLogin, requireSharedAccount, requireBudget, requireDailyCap`.
Registration is open, so a login-only gate on those two routes would let any
stranger who found the URL run Opus 5 on Erik's API key; and Spellbook's own
sign-in carries no balance, because the ledger lives on the
`strongtechnicalconsulting.com` account rather than in any one app. Signing in
with that account is offered beside Spellbook's own on the sign-in sheet.

This replaced a hand-granted `aiAccess === 'approved'` flag. `/api/admin/*`
still returns **404**, not 403, to everyone else, so the admin surface isn't
advertised.

Forgot your password: prove it with a passkey (the session cookie records
whether it was proved by password or passkey, and a passkey is at least as
strong a proof as the password it replaces), or ask the admin, who issues a
temporary password shown exactly once and never stored in the clear. There is
no mail sender on this project, so there is no reset link — that's the trade.

## Data model (Firestore database `spellbook`)

- `users/<uid>` — account, `aiAccess` state, admin flag.
  - `users/<uid>/saves/<promptId>` — `{savedAt, title, authorName}`.
- `webauthn-credentials/<id>` — passkey public keys, each with the `userId` it
  belongs to and the `rpID` it was registered on.
- `prompts/<id>` — `{title, body, summary, platforms[], models[], category,
  tags[], variables[], authorId, authorName, visibility, score, upvotes,
  downvotes, copyCount, saveCount, remixCount, viewCount, remixOf, trendScore,
  createdAt, updatedAt}`.
  - `prompts/<id>/votes/<uid>` — `{value: 1|-1, at}`. One per account.
- `control/rollup` — `{lastRunAt, scanned, rescored}` from the last cron tick.

The `analytics/<app>` tree is gone; it lives in the `eriks-projects` database
now. Nothing deletes the old documents — they are a day of counts in a database
this app still owns, harmless and not worth a migration script.

Composite indexes are in `firestore.indexes.json` — five, all on `prompts`.
Platform, category and tag filtering is applied in memory over a bounded window
(`SCAN_LIMIT`) instead, which is one index rather than a dozen at this size.

## Cron

One Cloud Scheduler job, `spellbook-rollup`, POSTing `/api/cron/rollup`.
Trend scores are written on every vote and copy, but they *decay*, so without a
periodic sweep a prompt that stopped getting attention keeps yesterday's score
and the front page freezes. The route recomputes them and writes a summary to
`control/rollup`.

It calls no model — it's arithmetic, so it costs nothing and needs no approval
check, unlike trip-planner's watch sweep. Auth is `requireLoginOrCron`: a normal
session, or the `X-Cron-Key` header matching the `cron-secret` value.

## One repo, one app

Spellbook has its own repository, matching Erik's convention. The repo name, the
Cloud Run service, the Firestore database and the `gcpdeploy` alias are all the
single word `spellbook` — deliberately, so this app never needs the bridging
that Hopscotch does (repo `beer-app`, service `hopscotch`, alias `beer`, and a
runbook column to explain it).

It briefly lived inside `eriks-projects/spellbook/` because the session that
built it could not create a repository. That is history now.

**The landing page no longer depends on this service.** It used to: it posted
its view beacon here and read `GET /api/stats/public` from here to badge what
was trending, which meant the root domain made a cross-origin call to an app
subdomain to draw itself. Both endpoints are the landing service's own now, so
that dependency is simply gone rather than made weaker.

The old arrangement was careful about it — the script ran after paint, caught
everything, and the authored card order was already right when no stats
arrived, so a cold Spellbook never showed on the root domain. That care is
worth keeping if anything here is ever called from the landing page again; it
is the only thing that makes a static page calling a service acceptable.

## Running it locally

```bash
npm install
npm test        # pure logic: placeholders, validation, trend decay, the allowlist
ANTHROPIC_API_KEY=... SESSION_SECRET=$(openssl rand -hex 32) \
  GOOGLE_CLOUD_PROJECT=metal-celerity-236019 ADMIN_EMAIL=you@example.com \
  node server.js
```

Every route that touches Firestore needs real credentials; `/healthz`, `/login`,
the static pages and every auth gate work without them.

## Deploy

`./.claude/skills/deploy/gcpdeploy ship spellbook`, then
`... verify spellbook`. Same no-`gcloud`, no-local-Docker REST pipeline as the
other apps — see `DEPLOY.md` at the repo root.
