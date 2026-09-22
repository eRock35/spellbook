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

## Analytics: `/dashboard.html`

Every app on the domain posts a one-line beacon to `POST /api/beacon` here.
The dashboard shows a ranked bar chart of the last seven days, a multi-series
line chart of daily views with a crosshair and a table view, stat tiles, and —
for the admin only — unique visitors, top pages and referrer hosts per app.

The landing page consumes `GET /api/stats/public` to order its own cards by
what's trending and badge the leader.

**What is stored:** the app name, a coarse path, the referrer *host*, an opaque
random visitor id in a first-party cookie, and counters.
**What is deliberately not:** IP addresses, user agents, full referrer URLs,
query strings, or any link to a signed-in identity. Enough to count and rank,
not enough to follow a person.

`santa-rosa-beach-trip` is **not** tracked, and must not be added. It's private,
holds family PII, and its hostname is deliberately kept off public surfaces —
`/api/stats/public` is a public surface and this repo is public.
`test/analytics.test.js` asserts its absence so a future "helpful" addition
fails loudly.

## Sign-in and the AI gate

Open registration (email + a 10-character minimum password), with a passkey
addable afterwards for Face ID. Accounts are `users/<uid>` where `uid` is the
base64url of the lowercased email — deterministic, so `create()` fails on a
duplicate rather than needing a uniqueness index Firestore doesn't have.

Everything free is free the moment you sign up: publish, vote, save, remix.
**Anything that calls Claude needs `aiAccess === 'approved'`**, granted by hand
by the admin (whichever account registers with `ADMIN_EMAIL`). Registration is
open, so a login-only gate on those two routes would let any stranger who found
the URL run Opus 5 on Erik's API key. `/api/admin/*` returns **404**, not 403,
to everyone else, so the admin surface isn't advertised.

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
- `analytics/<app>` — rolling totals.
  - `analytics/<app>/daily/<YYYY-MM-DD>` — `{date, views, uniques}`.
    - `.../visitors/<vid>` — existence means "seen today"; the cheapest
      test-and-set available, no read on the repeat-view path.
  - `analytics/<app>/paths/<key>`, `analytics/<app>/refs/<key>`.
- `control/rollup` — `{lastRunAt, scanned, rescored, appRanking}` from the last
  cron tick.

Composite indexes are in `firestore.indexes.json` — five, all on `prompts`.
Platform, category and tag filtering is applied in memory over a bounded window
(`SCAN_LIMIT`) instead, which is one index rather than a dozen at this size.

## Cron

One Cloud Scheduler job, `spellbook-rollup`, POSTing `/api/cron/rollup`.
Trend scores are written on every vote and copy, but they *decay*, so without a
periodic sweep a prompt that stopped getting attention keeps yesterday's score
and the front page freezes. The route recomputes them and writes a leaderboard
snapshot to `control/rollup`.

It calls no model — it's arithmetic, so it costs nothing and needs no approval
check, unlike trip-planner's watch sweep. Auth is `requireLoginOrCron`: a normal
session, or the `X-Cron-Key` header matching the `cron-secret` value.

## Why it's in this repo

Erik's convention is one repo per project, and this should have been
`eRock35/prompt-library`. The session that built it could not create a
repository — the GitHub App token returns `403 Resource not accessible by
integration` on `POST /user/repos` — so rather than stall, it shipped here.

`eriks-projects` is a defensible home: this service is the analytics backend for
the landing page that this repo already contains, so the two genuinely belong
together. But if Erik wants it split out, it is a `git mv` plus a new repo and
one line in `.claude/skills/deploy/apps.json`; nothing in the code knows where
it lives.

The landing page keeps its own `Dockerfile`, `package.json` and `server.js` at
the repo root and is **completely untouched by this app** beyond one deferred
`<script>` in `site/index.html`. It must stay that way: it is deliberately
dependency-light and scales to zero, which is the only reason it's affordable on
Cloud Run. `gcpdeploy` builds this app from the `spellbook/` subtree via a
`subdir` key in `apps.json`, so the two never share a build context.

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
