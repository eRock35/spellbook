// Spellbook — a shared prompt library.
//
// The shape, in one paragraph: a prompt is a document anyone signed in can
// publish; other people vote on it, copy it, save it, and remix it into their
// own version with attribution back to the original. Every prompt says which
// platform and model it was written for, because a prompt tuned for Claude
// Code is not the same artifact as one tuned for Midjourney and a library that
// pretends otherwise is useless. Ranking is time-decayed, so "trending" means
// recent rather than merely popular.


const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const { createAccounts } = require('./accounts');
const seed = require('./seed');
const identityLib = require('./identity');
const identityStore = require('./identity-store');
const {
  PLATFORMS, CATEGORIES, clean, pickList, cleanTags, extractVariables,
  computeTrend, bodyToPromptFields, publicByline, bylineFor, NO_NAME,
} = require('./promptfields');
const stats = require('./authorstats');
const cards = require('./cards');

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const FIRESTORE_DB = process.env.FIRESTORE_DATABASE_ID || 'spellbook';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

// Claude Opus 5. Both AI routes are single-shot and short, and both sit behind
// the shared budget, so the per-call cost is bounded by a dollar figure rather
// than by an approval list. effort 'medium' because rewriting a prompt is a
// small, well-specified job — 'high' spent thinking tokens without changing
// answers.
const MODEL = 'claude-opus-5';
const AI_EFFORT = 'medium';

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const db = new Firestore({ projectId: PROJECT_ID, databaseId: FIRESTORE_DB });

const app = express();
app.use(express.json({ limit: '256kb' }));
// `1`, not `true` (2026-09-27): with `true` a client could write its own
// X-Forwarded-For and choose req.ip, which the sign-in limit below keys on.
// Cloud Run's front end is the one hop in front of this app.
app.set('trust proxy', 1);

// Every response (2026-09-27). nosniff so nothing served here is read as a
// type it was not sent as; frame-ancestors so only this app and the landing
// page - which previews each app in an iframe - may frame it. A signed-in app
// inside a hostile page is the setup for clickjacking.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  next();
});

/** Constant-time comparison of two secrets of any length. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const h = (v) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

/*
 * Failed own-door sign-ins, per client address (2026-09-27). Ten failures in
 * fifteen minutes and /api/auth/login answers 429 to that address until the
 * window passes - a right password included, or the limit would only slow a
 * guesser down. A success clears the count. In memory, per instance. The
 * shared account's own sign-in is identity's to limit, not this app's.
 */
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // ip -> { n, since }

function loginBlocked(ip) {
  const e = loginFailures.get(ip);
  if (!e) return false;
  if (Date.now() - e.since > LOGIN_FAIL_WINDOW_MS) { loginFailures.delete(ip); return false; }
  return e.n >= LOGIN_FAIL_LIMIT;
}

app.post('/api/auth/login', (req, res, next) => {
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
  res.on('finish', () => {
    if (res.statusCode === 200) { loginFailures.delete(ip); return; }
    if (res.statusCode !== 401) return;
    const now = Date.now();
    let e = loginFailures.get(ip);
    if (!e || now - e.since > LOGIN_FAIL_WINDOW_MS) e = { n: 0, since: now };
    e.n++;
    loginFailures.set(ip, e);
    if (loginFailures.size > 10000) {
      for (const [k, v] of loginFailures) if (now - v.since > LOGIN_FAIL_WINDOW_MS) loginFailures.delete(k);
      if (loginFailures.size > 10000) loginFailures.clear();
    }
  });
  next();
});

// Sorting and the bounded browse window. The taxonomy and every pure field
// rule live in promptfields.js, which is testable without a Firestore.
const SORTS = {
  trending: 'trendScore',
  top: 'score',
  new: 'createdAt',
  copied: 'copyCount',
};
// A bounded page. Filtering by platform/category/tag happens in memory over
// this window rather than as Firestore composite indexes: at this library's
// size that is one index instead of a dozen, and the cutoff is honest and
// visible rather than a silently wrong query. Revisit past a few thousand
// public prompts.
const SCAN_LIMIT = 300;

const accounts = createAccounts({
  db,
  sessionSecret: SESSION_SECRET,
  rpName: 'Spellbook',
  adminEmail: ADMIN_EMAIL,
  // The old own-door sign-up is closed (see accounts.js). The suites that
  // drive features through it reopen it, and only under NODE_ENV=test.
  openRegistration: process.env.NODE_ENV === 'test' && process.env.SPELLBOOK_OWN_REGISTRATION === '1',
});
const { requireLogin, requireAdmin } = accounts;

// The account that covers every app on this domain: one email, one password,
// one passkey, one credit balance. Mounted BESIDE this app's own sign-in
// rather than instead of it, the same way the football app does it - the
// original door keeps working and nobody is signed out by the change.
//
// `requireAiAccess` is deliberately NOT destructured any more. It was this
// app's own approval list, which is the pattern every other app here retired:
// a human approving people one at a time is a slower version of a budget and
// never actually bounded anything. See the AI routes below.
const identity = identityLib.create({
  store: identityStore.store,
  secret: () => process.env.IDENTITY_SESSION_SECRET || '',
  app: 'spellbook',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Spellbook',
});

app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

/**
 * Both doors, in the order that makes the shared one actually work.
 *
 * identity.mount() installs its own attachUser with app.use(), and a use()
 * registered AFTER a get() never runs for that route. Mounting identity below
 * accounts.mount() therefore left /api/auth/me reading only Spellbook's own
 * cookie: someone holding a perfectly good shared session was told
 * `signedIn: false` and the page bounced them to /login. Hence attachUser
 * here, before any route is registered.
 *
 * The shared account WINS when both are present - identity's attachUser only
 * assigns when it finds a session of its own, so this is an overwrite, not a
 * merge, and the bridge below puts the two shapes back together.
 */
app.use(accounts.attachUser);
app.use(identity.attachUser);

/**
 * One user shape, whichever door they came through.
 *
 * The two systems derive a uid identically - base64url of the lowercased
 * email - so a shared-account session names exactly the same person as a
 * Spellbook one. Their prompts, votes and saves are already keyed to it;
 * nothing needs migrating and nobody's library moves.
 *
 * identity's fields are spread LAST on purpose: it owns entitlements, so
 * spentUsd, plan and byok must come from the shared record and not from a
 * stale local copy - the same rule DataViz learned the hard way.
 */
async function bridgeSharedAccount(req, _res, next) {
  const u = req.user;
  // Signed out, or in through Spellbook's own door: already the right shape.
  if (!u || u.uid) return next();
  const uid = u.id;
  let own = null;
  try {
    const d = await db.collection('users').doc(uid).get();
    own = d.exists ? d.data() : null;
  } catch (e) { own = null; }
  req.user = Object.assign({}, own || {}, u, {
    uid,
    // Never the email (2026-09-27): it became the public byline's source for
    // anyone who had not chosen a name. The page's own "signed in as" falls
    // back to the address by itself; nothing public does.
    displayName: (own && own.displayName) || u.displayName || '',
    // Only the shared account's owner flag (2026-09-27). A local isAdmin
    // could be set by registering an unverified address, so it no longer
    // counts for a shared session.
    isAdmin: u.admin === true,
    sharedAccount: true,
  });
  next();
}
app.use(bridgeSharedAccount);

accounts.mount(app);
identity.mount(app);
// Again, deliberately. identity.mount() installs its OWN attachUser, which
// reassigns req.user to the raw identity shape - no uid, no sharedAccount -
// for every route registered after this line, which is most of this file.
// Bridging once before the mounts fixes the account routes; bridging again
// here fixes the library and the AI routes. Found by a test that signed in
// through the shared door and was then told to sign in through the shared
// door.
app.use(bridgeSharedAccount);

// Price and record every model call this app makes.
identity.meter(anthropic);

// View counting used to live here, and it was the wrong address: Erik's
// numbers for every app sat inside one of the apps being counted. It is on
// the root domain now, next to the admin panel that reads it - see
// eriks-projects/lib/views.js. Spellbook still reports itself, through the
// same shared/beacon.js every other app carries.

/**
 * An AI call needs the SHARED account, not just a Spellbook login.
 *
 * This is the piece that makes the move off requireAiAccess safe rather than
 * a widening. identity.requireBudget deliberately waves through a request
 * with no identity session - most apps here are readable signed-out and it
 * must not 402 a passer-by - so on its own it would have let any registered
 * Spellbook user run Opus 5 unmetered, which is looser than the approval
 * list it replaced, not tighter.
 *
 * Spellbook's own sign-in carries no balance and never will: the ledger lives
 * on the shared account. So the honest answer to "can this person spend" is
 * "not until we know who they are across the domain".
 */
function requireSharedAccount(req, res, next) {
  // Specifically the shared door. req.user is truthy for a Spellbook-only
  // login as well, and that one carries no balance.
  if (req.user && req.user.sharedAccount) return next();
  return res.status(401).json({
    error: 'Sign in with your account for all the apps to use Claude here.',
    accountUrl: 'https://acct.strongtechnicalconsulting.com',
  });
}

function requireLoginOrCron(req, res, next) {
  if (CRON_SECRET && sameSecret(req.get('X-Cron-Key') || '', CRON_SECRET)) {
    req.isCron = true;
    return next();
  }
  return requireLogin(req, res, next);
}

/** The rollup rescores every prompt: the scheduler's key, or the admin.
 *  It used to take any signed-in session (2026-09-26). */
function requireCronOrAdmin(req, res, next) {
  return requireLoginOrCron(req, res, () => {
    if (req.isCron) return next();
    // By the owner flag, not by matching an (unverified) email address.
    if (req.user && req.user.isAdmin === true && req.user.sharedAccount === true) return next();
    return res.status(403).json({ error: 'Only the scheduler runs this.' });
  });
}

// The front page gets the app's own link-preview tags; express.static would
// otherwise answer `/` with the bare file before the routes below ran.
app.get('/', (req, res) => sendIndex(req, res, siteMeta(req)));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const prompts = () => db.collection('prompts');

/** The opaque public handle for an author - see authorstats.authorKey. */
const keyFor = (uid) => stats.authorKey(uid, SESSION_SECRET);

/**
 * What any reader may see of a prompt.
 *
 * `authorId` is deliberately NOT in it any more (2026-09-26). A uid is
 * base64url(lowercased email), so sending it with every public prompt put
 * every author's email address one decode away from anyone who opened the
 * network tab. `isMine` answers the only question the page used it for, and
 * `authorKey` is the opaque handle that links to /u/<key>.
 */
/** A remix's "remix of ... by" name. Written since 2026-09-27 as a checked
 *  byline (bylineChecked); an older one holds the parent's raw authorName,
 *  which may be an email's local part, and a remix cannot check it without
 *  the parent's uid - so it reads as no name until the rollup rewrites it. */
function remixByline(r) {
  return r.bylineChecked ? publicByline(r.authorName) : NO_NAME;
}

/** What a remix stores as its parent's name: the checked byline, or '' for
 *  none (storing "A Spellbook writer" would read back as its first word). */
function remixNameFor(parent) {
  const b = parent ? bylineFor(parent) : NO_NAME;
  return b === NO_NAME ? '' : b;
}

function publicPrompt(id, d, extra) {
  const remixOf = d.remixOf && typeof d.remixOf === 'object'
    ? { id: d.remixOf.id || null, title: d.remixOf.title || '', authorName: remixByline(d.remixOf) }
    : null;
  return Object.assign({
    id,
    title: d.title || 'Untitled',
    summary: d.summary || '',
    body: d.body || '',
    platforms: d.platforms || [],
    models: d.models || [],
    category: d.category || 'other',
    tags: d.tags || [],
    variables: d.variables || [],
    authorKey: d.authorId ? keyFor(d.authorId) : null,
    authorName: bylineFor(d),
    visibility: d.visibility || 'public',
    score: d.score || 0,
    upvotes: d.upvotes || 0,
    downvotes: d.downvotes || 0,
    copyCount: d.copyCount || 0,
    saveCount: d.saveCount || 0,
    remixCount: d.remixCount || 0,
    viewCount: d.viewCount || 0,
    remixOf,
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  }, extra || {});
}

// Reads a prompt and decides whether this caller may see it. A private prompt
// 404s rather than 403s for anyone but its author, so the API never confirms
// that an id exists - same rule as trip-planner's loadOwnedTrip.
async function loadVisiblePrompt(req, res, { mustOwn } = {}) {
  const ref = prompts().doc(req.params.id);
  const doc = await ref.get();
  const missing = () => { res.status(404).json({ error: 'Prompt not found.' }); return null; };
  if (!doc.exists) return missing();
  const data = doc.data();
  const mine = req.user && data.authorId === req.user.uid;
  if (mustOwn && !mine) return missing();
  if (data.visibility !== 'public' && !mine) return missing();
  return { ref, doc, data };
}

// --- browse ----------------------------------------------------------------
// Browsing is open. A shared prompt library that demands an account before it
// will show you a single public prompt is a worse product and a worse pitch -
// and it is the rule the rest of this domain already runs: browse anything,
// pay for a model call. It is also what makes the live preview on the landing
// page show a library rather than a sign-in form.
//
// Only `visibility === 'public'` is ever returned here, signed in or not, so
// nothing private is reachable by dropping the cookie. Everything that WRITES
// - publish, vote, save, remix, improve - still needs a session, and the two
// model calls still need the shared account and a budget on top.
app.get('/api/prompts', async (req, res) => {
  try {
    const sortField = SORTS[String(req.query.sort || 'trending')] || SORTS.trending;
    const snap = await prompts()
      .where('visibility', '==', 'public')
      .orderBy(sortField, 'desc')
      .limit(SCAN_LIMIT)
      .get();

    const q = String(req.query.q || '').trim().toLowerCase();
    const platform = String(req.query.platform || '').toLowerCase();
    const category = String(req.query.category || '').toLowerCase();
    const tag = String(req.query.tag || '').toLowerCase();

    let rows = snap.docs.map((d) => publicPrompt(d.id, d.data()));
    // Who owns what, kept server-side: the page needs "is this mine" (you
    // cannot vote on your own), not anybody's uid.
    const ownerOf = {};
    snap.docs.forEach((d) => { ownerOf[d.id] = d.data().authorId; });
    if (platform) rows = rows.filter((p) => p.platforms.includes(platform));
    if (category) rows = rows.filter((p) => p.category === category);
    if (tag) rows = rows.filter((p) => p.tags.includes(tag));
    if (q) {
      rows = rows.filter((p) => (
        p.title.toLowerCase().includes(q)
        || p.summary.toLowerCase().includes(q)
        || p.body.toLowerCase().includes(q)
        || p.tags.some((t) => t.includes(q))
      ));
    }

    // Which of these has the caller already voted on or saved? Sent with the
    // list so the UI can render its own state in one round trip instead of N.
    // A signed-out reader has neither, and asking costs two fan-out reads per
    // page load to learn nothing.
    const uid = req.user && req.user.uid;
    const ids = rows.slice(0, 60).map((p) => p.id);
    const [myVotes, mySaves] = await Promise.all([
      uid && ids.length ? db.getAll(...ids.map((id) => prompts().doc(id).collection('votes').doc(uid))) : [],
      uid && ids.length ? db.getAll(...ids.map((id) => db.collection('users').doc(uid).collection('saves').doc(id))) : [],
    ]);
    const voteBy = {};
    myVotes.forEach((d, i) => { if (d.exists) voteBy[ids[i]] = d.data().value; });
    const savedBy = {};
    mySaves.forEach((d, i) => { if (d.exists) savedBy[ids[i]] = true; });

    res.json({
      total: rows.length,
      truncated: snap.size >= SCAN_LIMIT,
      prompts: rows.slice(0, 60).map((p) => Object.assign(p, {
        isMine: !!uid && ownerOf[p.id] === uid,
        myVote: voteBy[p.id] || 0,
        saved: !!savedBy[p.id],
      })),
      // So the page knows whether to draw the library's controls or an
      // invitation to sign in, without a second round trip.
      signedIn: !!uid,
      facets: { platforms: PLATFORMS, categories: CATEGORIES },
    });
  } catch (err) {
    console.error('GET /api/prompts', err);
    res.status(500).json({ error: 'Could not load prompts.' });
  }
});

// Everything the signed-in user owns or saved, private prompts included.
app.get('/api/my/prompts', requireLogin, async (req, res) => {
  try {
    const [mineSnap, savesSnap] = await Promise.all([
      prompts().where('authorId', '==', req.user.uid).orderBy('updatedAt', 'desc').limit(200).get(),
      db.collection('users').doc(req.user.uid).collection('saves').orderBy('savedAt', 'desc').limit(100).get(),
    ]);
    const savedIds = savesSnap.docs.map((d) => d.id);
    const savedDocs = savedIds.length ? await db.getAll(...savedIds.map((id) => prompts().doc(id))) : [];
    const visibleSaved = savedDocs.filter((d) => d.exists
      && (d.data().visibility === 'public' || d.data().authorId === req.user.uid));

    // The caller's own votes on the saved list. Without these the vote arrows
    // in the Saved tab render un-pressed even when the user has already voted,
    // which reads as "your vote was lost".
    const votes = visibleSaved.length
      ? await db.getAll(...visibleSaved.map((d) => d.ref.collection('votes').doc(req.user.uid)))
      : [];

    res.json({
      mine: mineSnap.docs.map((d) => publicPrompt(d.id, d.data(), { isMine: true })),
      // "Copied 100 times" toasts not yet shown. Free: computed from the
      // author's own prompts, which this route has just read anyway.
      milestones: stats.pendingMilestones(mineSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()))),
      saved: visibleSaved.map((d, i) => publicPrompt(d.id, d.data(), {
        saved: true,
        myVote: votes[i] && votes[i].exists ? votes[i].data().value : 0,
        isMine: d.data().authorId === req.user.uid,
      })),
    });
  } catch (err) {
    console.error('GET /api/my/prompts', err);
    res.status(500).json({ error: 'Could not load your prompts.' });
  }
});

// Open for the same reason the list is, and with the same floor:
// loadVisiblePrompt only returns a private prompt to the person who owns it,
// and a signed-out caller owns nothing - so this is the public shelf or a 404,
// never someone else's draft.
app.get('/api/prompts/:id', async (req, res) => {
  const found = await loadVisiblePrompt(req, res);
  if (!found) return;
  try {
    const uid = req.user && req.user.uid;
    const [vote, save] = await Promise.all([
      uid ? found.ref.collection('votes').doc(uid).get() : { exists: false },
      uid ? db.collection('users').doc(uid).collection('saves').doc(req.params.id).get() : { exists: false },
    ]);
    // Awaited (2026-09-26): the service is billed per request and throttled
    // between them, so a write left running after the response can stall.
    // A failed counter still never fails the read.
    await found.ref.update({ viewCount: FieldValue.increment(1) }).catch(() => {});
    res.json(publicPrompt(found.doc.id, found.data, {
      myVote: vote.exists ? vote.data().value : 0,
      saved: save.exists,
      isMine: !!uid && found.data.authorId === uid,
    }));
  } catch (err) {
    console.error('GET /api/prompts/:id', err);
    res.status(500).json({ error: 'Could not load that prompt.' });
  }
});

// --- create, edit, delete --------------------------------------------------
app.post('/api/prompts', requireLogin, async (req, res) => {
  try {
    const parsed = bodyToPromptFields(req.body || {}, req.user);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const now = new Date().toISOString();
    const base = Object.assign({}, parsed.fields, {
      authorKey: keyFor(req.user.uid),
      score: 0, upvotes: 0, downvotes: 0,
      copyCount: 0, saveCount: 0, remixCount: 0, viewCount: 0,
      remixOf: null, createdAt: now, updatedAt: now,
    });

    // A remix keeps a pointer home. Attribution is the price of a fork being
    // welcome rather than rude, and it is also how an author sees that their
    // prompt turned into five better ones.
    const remixOfId = clean((req.body || {}).remixOf, 64);
    if (remixOfId) {
      const parent = await prompts().doc(remixOfId).get();
      if (parent.exists && parent.data().visibility === 'public') {
        // The byline is worked out HERE, against the parent's author's
        // address, because a remix does not know that author's uid on read.
        base.remixOf = { id: parent.id, title: parent.data().title, authorName: remixNameFor(parent.data()), bylineChecked: true };
        await parent.ref.update({ remixCount: FieldValue.increment(1) }).catch(() => {});
      }
    }
    base.trendScore = computeTrend(base);

    const ref = await prompts().add(base);
    res.json(publicPrompt(ref.id, base, { isMine: true, myVote: 0, saved: false }));
  } catch (err) {
    console.error('POST /api/prompts', err);
    res.status(500).json({ error: 'Could not save that prompt.' });
  }
});

app.patch('/api/prompts/:id', requireLogin, async (req, res) => {
  const found = await loadVisiblePrompt(req, res, { mustOwn: true });
  if (!found) return;
  try {
    const parsed = bodyToPromptFields(Object.assign({}, found.data, req.body || {}), req.user);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const update = Object.assign({}, parsed.fields, { updatedAt: new Date().toISOString() });
    // Counters and authorship are never client-supplied — they are derived
    // from real actions, and bodyToPromptFields must not be able to reset them.
    delete update.authorId;
    update.authorKey = keyFor(found.data.authorId);
    update.trendScore = computeTrend(Object.assign({}, found.data, update));
    await found.ref.update(update);
    res.json(publicPrompt(found.doc.id, Object.assign({}, found.data, update), { isMine: true }));
  } catch (err) {
    console.error('PATCH /api/prompts/:id', err);
    res.status(500).json({ error: 'Could not update that prompt.' });
  }
});

app.delete('/api/prompts/:id', requireLogin, async (req, res) => {
  const found = await loadVisiblePrompt(req, res, { mustOwn: true });
  if (!found) return;
  try {
    // Votes are a subcollection and do not cascade. Left behind they would be
    // resurrected by a later id collision, which Firestore ids make unlikely
    // but not impossible, and they would keep counting against a quota.
    const votes = await found.ref.collection('votes').limit(500).get();
    await Promise.all(votes.docs.map((d) => d.ref.delete()));
    await found.ref.delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/prompts/:id', err);
    res.status(500).json({ error: 'Could not delete that prompt.' });
  }
});

// --- vote, save, copy -----------------------------------------------------
// One vote per account, changeable and revocable. Run in a transaction so the
// denormalized counters on the prompt can never drift from the vote documents
// that justify them — two people voting at once is the ordinary case, not the
// exotic one.
app.post('/api/prompts/:id/vote', requireLogin, async (req, res) => {
  const found = await loadVisiblePrompt(req, res);
  if (!found) return;
  const wanted = Number((req.body || {}).value);
  if (![1, 0, -1].includes(wanted)) {
    return res.status(400).json({ error: 'Vote must be 1, 0 or -1.' });
  }
  if (found.data.authorId === req.user.uid) {
    return res.status(400).json({ error: 'You cannot vote on your own prompt.' });
  }
  try {
    const voteRef = found.ref.collection('votes').doc(req.user.uid);
    const result = await db.runTransaction(async (tx) => {
      const [promptSnap, voteSnap] = await Promise.all([tx.get(found.ref), tx.get(voteRef)]);
      if (!promptSnap.exists) throw new Error('gone');
      const d = promptSnap.data();
      const was = voteSnap.exists ? voteSnap.data().value : 0;
      if (was === wanted) {
        return { score: d.score || 0, upvotes: d.upvotes || 0, downvotes: d.downvotes || 0, myVote: was };
      }
      const up = (d.upvotes || 0) + (wanted === 1 ? 1 : 0) - (was === 1 ? 1 : 0);
      const down = (d.downvotes || 0) + (wanted === -1 ? 1 : 0) - (was === -1 ? 1 : 0);
      const next = {
        upvotes: up, downvotes: down, score: up - down,
      };
      next.trendScore = computeTrend(Object.assign({}, d, next));
      tx.update(found.ref, next);
      if (wanted === 0) tx.delete(voteRef);
      else tx.set(voteRef, { value: wanted, at: new Date().toISOString() });
      return { score: next.score, upvotes: up, downvotes: down, myVote: wanted };
    });
    res.json(result);
  } catch (err) {
    if (err && err.message === 'gone') return res.status(404).json({ error: 'Prompt not found.' });
    console.error('POST /api/prompts/:id/vote', err);
    res.status(500).json({ error: 'Could not record that vote.' });
  }
});

app.post('/api/prompts/:id/save', requireLogin, async (req, res) => {
  const found = await loadVisiblePrompt(req, res);
  if (!found) return;
  try {
    const saveRef = db.collection('users').doc(req.user.uid).collection('saves').doc(req.params.id);
    const existing = await saveRef.get();
    const wantSaved = (req.body || {}).saved !== false;
    if (wantSaved && !existing.exists) {
      await saveRef.set({
        savedAt: new Date().toISOString(),
        title: found.data.title,
        authorName: bylineFor(found.data),
      });
      await found.ref.update({ saveCount: FieldValue.increment(1) });
    } else if (!wantSaved && existing.exists) {
      await saveRef.delete();
      await found.ref.update({ saveCount: FieldValue.increment(-1) });
    }
    res.json({ ok: true, saved: wantSaved });
  } catch (err) {
    console.error('POST /api/prompts/:id/save', err);
    res.status(500).json({ error: 'Could not save that prompt.' });
  }
});

// Copying is the signal that a prompt actually got used, which is why it is
// counted at all and why it is weighted above votes in the trend score.
app.post('/api/prompts/:id/copied', requireLogin, async (req, res) => {
  const found = await loadVisiblePrompt(req, res);
  if (!found) return;
  try {
    await found.ref.update({
      copyCount: FieldValue.increment(1),
      trendScore: computeTrend(Object.assign({}, found.data, { copyCount: (found.data.copyCount || 0) + 1 })),
    });
    res.json({ ok: true, copyCount: (found.data.copyCount || 0) + 1 });
  } catch (err) {
    console.error('POST /api/prompts/:id/copied', err);
    res.status(500).json({ error: 'Could not record that.' });
  }
});

// ---------------------------------------------------------------------------
// AI. Both routes below spend Erik's Anthropic key, so both sit behind
// requireBudget AND requireDailyCap — never requireLogin alone. Registration
// is open, so a login-only gate here would mean any stranger who found the URL
// could run Opus 5 on his account.
//
// This replaces requireAiAccess, which was this app's own approval list. The
// instinct it encoded is still right; only the mechanism moved. Every account
// gets FREE_ALLOWANCE_USD of AI once across the whole domain, every call is
// priced against it, and an exhausted one gets a 402 carrying somewhere to top
// up. A human approving people one at a time is a slower version of that, and
// it never actually bounded the money.
//
// Both follow the same confirm-before-save shape the other apps use: the model
// returns a proposal, the frontend renders it as Apply/Discard, and nothing is
// written until the user's own tap hits the ordinary create/patch route. An LLM
// never silently rewrites someone's saved prompt.
// ---------------------------------------------------------------------------
const PROPOSAL_TOOL = {
  name: 'propose_prompt',
  description: 'Return the improved or drafted prompt, ready for the author to review.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Short, specific title.' },
      summary: { type: 'string', description: 'One line on what this prompt is for.' },
      body: {
        type: 'string',
        description: 'The full prompt text. Use {{placeholder}} for anything the user should fill in.',
      },
      notes: { type: 'string', description: 'One or two sentences on what you changed and why.' },
      suggestedTags: { type: 'array', items: { type: 'string' }, description: 'Up to 5 lowercase tags.' },
    },
    required: ['title', 'summary', 'body', 'notes', 'suggestedTags'],
  },
};

const AI_SYSTEM = [
  'You help authors write reusable prompts for a shared prompt library.',
  'A good library prompt is specific about the task, states the output format,',
  'gives the model the context it needs, and uses {{double_brace}} placeholders',
  'for anything that changes between uses instead of hardcoding one example.',
  'Keep the author\'s voice and intent. Tighten and clarify; do not pad, and do',
  'not add role-play preamble ("You are a world-class...") that does no work.',
  'Always answer by calling the propose_prompt tool.',
].join(' ');

async function proposePrompt(userText) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: AI_EFFORT },
    system: AI_SYSTEM,
    tools: [PROPOSAL_TOOL],
    tool_choice: { type: 'tool', name: 'propose_prompt' },
    messages: [{ role: 'user', content: userText }],
  });
  // A refusal is an HTTP 200 with no tool call, so check it before reading
  // content rather than after failing to find a block.
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details && response.stop_details.explanation;
    const err = new Error(why || 'Claude declined this request.');
    err.userFacing = true;
    throw err;
  }
  const call = response.content.find((b) => b.type === 'tool_use' && b.name === 'propose_prompt');
  if (!call) {
    const err = new Error('Claude did not return a usable proposal. Try rephrasing.');
    err.userFacing = true;
    throw err;
  }
  const out = call.input || {};
  return {
    title: clean(out.title, 120),
    summary: clean(out.summary, 240),
    body: clean(out.body, 8000),
    notes: clean(out.notes, 600),
    suggestedTags: cleanTags(out.suggestedTags),
    variables: extractVariables(clean(out.body, 8000)),
  };
}

// Draft from a description. The user never has to start from a blank box.
//
// Metered, not approved. The standing rule across these apps: an Anthropic
// call never sits behind a login alone - it goes behind requireBudget AND
// requireDailyCap, so what bounds the spend is a dollar figure rather than
// somebody's memory of who they said yes to.
app.post('/api/ai/draft', requireLogin, requireSharedAccount, identity.requireBudget, identity.requireDailyCap,
  async (req, res) => {
  try {
    const want = clean((req.body || {}).description, 1500);
    if (want.length < 8) return res.status(400).json({ error: 'Describe what the prompt should do.' });
    const platforms = pickList((req.body || {}).platforms, PLATFORMS, 6);
    const proposal = await proposePrompt([
      `Write a reusable library prompt for this request:\n\n${want}`,
      platforms.length ? `\n\nIt will be used on: ${platforms.join(', ')}.` : '',
    ].join(''));
    res.json({ proposal });
  } catch (err) {
    if (err && err.userFacing) return res.status(502).json({ error: err.message });
    console.error('POST /api/ai/draft', err);
    res.status(500).json({ error: 'Could not draft a prompt.' });
  }
});

// Critique and tighten an existing prompt. Readable by anyone who can see the
// prompt — you may want to improve someone else's into a remix of your own —
// but it writes nothing either way.
app.post('/api/prompts/:id/improve', requireLogin, requireSharedAccount, identity.requireBudget, identity.requireDailyCap,
  async (req, res) => {
  const found = await loadVisiblePrompt(req, res);
  if (!found) return;
  try {
    const d = found.data;
    const ask = clean((req.body || {}).instruction, 500);
    const proposal = await proposePrompt([
      'Improve this library prompt.\n',
      `\nPlatforms: ${(d.platforms || []).join(', ') || 'unspecified'}`,
      `\nCategory: ${d.category || 'other'}`,
      `\nTitle: ${d.title}`,
      `\n\nPrompt body:\n${d.body}`,
      ask ? `\n\nThe author specifically asks: ${ask}` : '',
    ].join(''));
    res.json({ proposal });
  } catch (err) {
    if (err && err.userFacing) return res.status(502).json({ error: err.message });
    console.error('POST /api/prompts/:id/improve', err);
    res.status(500).json({ error: 'Could not improve that prompt.' });
  }
});

// ---------------------------------------------------------------------------
// Cron. Trend scores are written on every vote and copy, but they decay with
// age, so without a periodic sweep a prompt that stops getting attention keeps
// the score it earned yesterday and the front page freezes. This recomputes
// them. It calls no model — it is arithmetic, so it costs nothing and needs no
// approval check, unlike trip-planner's watch sweep.
// ---------------------------------------------------------------------------
const MAX_RESCORE_PER_RUN = 500;

app.post('/api/cron/rollup', requireCronOrAdmin, async (req, res) => {
  try {
    const snap = await prompts().orderBy('trendScore', 'desc').limit(MAX_RESCORE_PER_RUN).get();
    let rescored = 0;
    // Which public prompt is #1 on Trending once this run's scores land. It
    // earns its author the "#1 on Trending" badge, stamped once and kept, so
    // the badge outlives the hour it was true for. (2026-09-26)
    let top = null;
    for (const doc of snap.docs) {
      if (doc.data().visibility !== 'public') continue;
      const sc = computeTrend(doc.data());
      if (!top || sc > top.score) top = { doc, score: sc };
    }
    // Batched in chunks because a Firestore write batch caps at 500 and a
    // per-document update would be 500 round trips.
    const byId = new Map(snap.docs.map((doc) => [doc.id, doc.data()]));
    let batch = db.batch();
    let inBatch = 0;
    for (const doc of snap.docs) {
      const d = doc.data();
      const patch = {};
      const next = computeTrend(d);
      if (Math.abs(next - (d.trendScore || 0)) > 1e-9) { patch.trendScore = next; rescored += 1; }
      // Backfill the public author handle on prompts written before it
      // existed (and rewrite it if SESSION_SECRET ever rotates).
      const key = d.authorId ? keyFor(d.authorId) : null;
      if (key && d.authorKey !== key) patch.authorKey = key;
      if (top && top.doc.id === doc.id && !d.trendingTopAt) patch.trendingTopAt = new Date().toISOString();
      // A remix written before its byline was checked (2026-09-27) gets it
      // checked against the parent's author, or no name if the parent is gone.
      if (d.remixOf && typeof d.remixOf === 'object' && d.remixOf.id && !d.remixOf.bylineChecked) {
        let parent = byId.get(d.remixOf.id);
        if (!parent) {
          const p = await prompts().doc(String(d.remixOf.id)).get().catch(() => null);
          parent = p && p.exists ? p.data() : null;
        }
        patch.remixOf = Object.assign({}, d.remixOf, { authorName: remixNameFor(parent), bylineChecked: true });
      }
      if (Object.keys(patch).length) {
        batch.update(doc.ref, patch);
        inBatch += 1;
        if (inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
      }
    }
    if (inBatch > 0) await batch.commit();

    // The cross-app leaderboard used to be snapshotted here too. It belongs to
    // the service that now owns the counting, not to this one.
    await db.collection('control').doc('rollup').set({
      lastRunAt: new Date().toISOString(),
      scanned: snap.size,
      rescored,
      topTrendingId: top ? top.doc.id : null,
    }, { merge: true });

    res.json({ scanned: snap.size, rescored });
  } catch (err) {
    console.error('POST /api/cron/rollup', err);
    res.status(500).json({ error: 'Rollup failed.' });
  }
});

// ---------------------------------------------------------------------------
// Author stats, badges, public author pages, copy milestones and link
// previews (2026-09-26). No model call anywhere in this block: sums over
// counters the prompts already carry, and pictures drawn from them.
// ---------------------------------------------------------------------------

// Copies per author across the public shelf, for "Top 5% author". Read over
// the same bounded window as browsing (SCAN_LIMIT, by copyCount - the existing
// visibility+copyCount index) and held for five minutes, filled by whichever
// request finds it stale: no timer, since this service is billed per request.
const RANK_TTL_MS = 5 * 60 * 1000;
let rankCache = null;
async function authorRankTable() {
  if (rankCache && Date.now() - rankCache.at < RANK_TTL_MS) return rankCache.table;
  const snap = await prompts().where('visibility', '==', 'public')
    .orderBy('copyCount', 'desc').limit(SCAN_LIMIT).get();
  const table = stats.authorTable(snap.docs.map((d) => d.data()));
  rankCache = { at: Date.now(), table };
  return table;
}

const withId = (d) => Object.assign({ id: d.id }, d.data());

// The signed-in author's own numbers. Everything is summed over their PUBLIC
// prompts (see authorstats.js for why); private ones are only counted.
app.get('/api/my/stats', requireLogin, async (req, res) => {
  try {
    const uid = req.user.uid;
    const [mineSnap, table] = await Promise.all([
      prompts().where('authorId', '==', uid).orderBy('updatedAt', 'desc').limit(200).get(),
      authorRankTable().catch(() => new Map()),
    ]);
    const docs = mineSnap.docs.map(withId);
    const t = stats.totals(docs);
    const best = stats.bestPrompt(docs);
    const key = keyFor(uid);
    res.json({
      byline: publicByline(req.user.displayName, req.user.email),
      totals: t,
      privateCount: docs.length - t.prompts,
      best: best ? publicPrompt(best.id, best, { isMine: true }) : null,
      rank: stats.percentile(table, uid, t.copies),
      badges: stats.badges(t, docs),
      // Only once there is something public to show on it.
      publicPath: t.prompts ? `/u/${key}` : null,
      milestones: stats.pendingMilestones(docs),
    });
  } catch (err) {
    console.error('GET /api/my/stats', err);
    res.status(500).json({ error: 'Could not load your stats.' });
  }
});

// The author has seen their "copied N times" toast: stamp each prompt with
// the milestone it has reached so it is never shown twice. The client names
// prompts, never numbers - the milestone is worked out here from the count.
app.post('/api/my/milestones/seen', requireLogin, async (req, res) => {
  try {
    const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : [])
      .map((v) => String(v || '')).filter((v) => /^[A-Za-z0-9_-]{1,64}$/.test(v)).slice(0, 10);
    if (!ids.length) return res.json({ ok: true, marked: 0 });
    const snaps = await db.getAll(...ids.map((id) => prompts().doc(id)));
    let marked = 0;
    for (const d of snaps) {
      if (!d.exists || d.data().authorId !== req.user.uid) continue;
      const m = stats.milestoneFor(d.data().copyCount);
      if (m > (Number(d.data().celebratedCopies) || 0)) {
        await prompts().doc(d.id).update({ celebratedCopies: m });
        marked += 1;
      }
    }
    res.json({ ok: true, marked });
  } catch (err) {
    console.error('POST /api/my/milestones/seen', err);
    res.status(500).json({ error: 'Could not record that.' });
  }
});

/**
 * An author's PUBLIC prompts, by their opaque key, or null. Stored
 * `authorKey` first (a single-field equality: no composite index); prompts
 * the rollup has not backfilled yet are found by scanning the public window.
 * Every hit is re-checked against its authorId, so a stale stored key can
 * never file one author's prompt under another.
 */
async function publicPromptsByKey(key) {
  if (!stats.AUTHOR_KEY_RE.test(String(key || ''))) return [];
  const mine = (d) => d.visibility === 'public' && d.authorId && keyFor(d.authorId) === key;
  const snap = await prompts().where('authorKey', '==', key).limit(200).get();
  let docs = snap.docs.map(withId).filter(mine);
  if (!docs.length) {
    const scan = await prompts().where('visibility', '==', 'public')
      .orderBy('copyCount', 'desc').limit(SCAN_LIMIT).get();
    docs = scan.docs.map(withId).filter(mine);
  }
  return docs;
}

const newest = (docs) => docs.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];

// A public author page. Open, like browsing: it shows nothing that is not
// already on the public shelf under that byline - their public prompts and
// sums of those prompts' public counters. No rank here (that is the author's
// own business), no private prompt, no uid, no email. 404 when the key names
// nobody with a public prompt, so it cannot confirm that an account exists.
app.get('/api/authors/:key', async (req, res) => {
  try {
    const docs = await publicPromptsByKey(req.params.key);
    if (!docs.length) return res.status(404).json({ error: 'No public prompts here.' });
    const uid = req.user && req.user.uid;
    const t = stats.totals(docs);
    const best = stats.bestPrompt(docs);
    const list = docs.slice().sort((a, b) => (b.copyCount || 0) - (a.copyCount || 0)
      || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({
      key: req.params.key,
      byline: bylineFor(newest(docs)),
      isMe: !!uid && docs[0].authorId === uid,
      totals: t,
      best: best ? publicPrompt(best.id, best) : null,
      badges: stats.badges(t, docs).filter((b) => b.earned).map(({ id, name, hint }) => ({ id, name, hint })),
      prompts: list.slice(0, 60).map((d) => publicPrompt(d.id, d, { isMine: !!uid && d.authorId === uid })),
    });
  } catch (err) {
    console.error('GET /api/authors/:key', err);
    res.status(500).json({ error: 'Could not load that author.' });
  }
});

// --- link previews ---------------------------------------------------------
// Every path serves the one page. For a prompt link, a public author link and
// the front page, the server writes Open Graph / Twitter tags into its <head>
// first, so a link pasted into a chat unfolds into a card. Crawlers carry no
// session, and neither does this decision: ONLY a public prompt ever gets its
// own tags. A private or missing one gets the site's generic tags, byte for
// byte what an id that never existed gets, so a preview cannot leak a private
// prompt's title or text or confirm that it exists.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const pngCache = cards.createCache(200);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function origin(req) { return `${req.protocol}://${req.get('host')}`; }

/** User text bound for a meta tag: no controls or bidi overrides, one line, bounded. */
function metaText(s, max) {
  const t = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function siteMeta(req) {
  return {
    title: 'Spellbook',
    description: 'Prompts worth keeping \u2014 shared, voted on and remixed, with a form for every blank.',
    image: `${origin(req)}/og.png`,
    url: `${origin(req)}/`,
  };
}

function sendIndex(req, res, m) {
  const e = cards.x;
  const tags = `<title>${e(m.title)}</title>\n`
    + `<meta name="description" content="${e(m.description)}">\n`
    + '<meta property="og:type" content="website"><meta property="og:site_name" content="Spellbook">\n'
    + `<meta property="og:title" content="${e(m.title)}"><meta property="og:description" content="${e(m.description)}">\n`
    + `<meta property="og:image" content="${e(m.image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">\n`
    + `<meta property="og:url" content="${e(m.url)}"><meta name="twitter:card" content="summary_large_image">\n`
    + `<meta name="twitter:title" content="${e(m.title)}"><meta name="twitter:description" content="${e(m.description)}">`
    + `<meta name="twitter:image" content="${e(m.image)}">`;
  // A replacer FUNCTION, not a string (2026-09-27): in a replacement string
  // `$&`, `$\``, `$'` and `$1` are patterns, so a prompt titled with one of
  // them spliced pieces of the page into its own head.
  res.type('html').send(INDEX_HTML.replace('<title>Spellbook</title>', () => tags));
}

async function publicPromptDoc(id) {
  if (!ID_RE.test(id)) return null;
  const doc = await prompts().doc(id).get();
  if (!doc.exists || doc.data().visibility !== 'public') return null;
  return withId(doc);
}

function sendPng(res, key, svgFn, maxAge) {
  let buf = pngCache.get(key);
  if (!buf) {
    buf = cards.png(svgFn());
    if (!buf) return res.status(503).type('text/plain').send('Cards are unavailable.');
    pngCache.set(key, buf);
  }
  res.set('Cache-Control', `public, max-age=${maxAge}`);
  res.set('X-Content-Type-Options', 'nosniff');
  return res.type('image/png').send(buf);
}

// The card for one prompt. Cached by id + updatedAt (an edit redraws it) +
// copyCount (the number it shows); the LRU bounds how many are kept.
app.get(/^\/p\/([A-Za-z0-9_-]{1,64})\.png$/, async (req, res) => {
  try {
    const d = await publicPromptDoc(req.params[0]);
    if (!d) return res.status(404).type('text/plain').send('Not here.');
    const key = `p:${d.id}:${d.updatedAt || ''}:${d.copyCount || 0}`;
    return sendPng(res, key, () => cards.promptSvg({
      title: d.title, platforms: d.platforms, copyCount: d.copyCount,
      body: d.body, by: bylineFor(d),
    }), 600);
  } catch (err) {
    console.error('GET /p/:id.png', err);
    return res.status(500).type('text/plain').send('Could not draw that prompt.');
  }
});

// The front page's card. It shows no data, so it is drawn once per instance.
app.get('/og.png', (req, res) => sendPng(res, 'og:app', () => cards.appSvg(), 86400));

app.get(/^\/p\/([A-Za-z0-9_-]{1,64})$/, async (req, res) => {
  let d = null;
  try { d = await publicPromptDoc(req.params[0]); } catch (err) { console.error('GET /p/:id meta', err.message); }
  if (!d) return sendIndex(req, res, siteMeta(req));
  const title = metaText(d.title, 120) || 'A prompt';
  const blurb = metaText(d.summary, 200) || metaText(d.body, 200);
  const copies = Number(d.copyCount) || 0;
  return sendIndex(req, res, {
    title: `${title} \u00b7 Spellbook`,
    description: `${copies ? `Copied ${copies.toLocaleString('en-US')} time${copies === 1 ? '' : 's'}. ` : ''}${blurb}`,
    image: `${origin(req)}/p/${d.id}.png`,
    url: `${origin(req)}/p/${d.id}`,
  });
});

app.get(/^\/u\/([A-Za-z0-9_-]{16})$/, async (req, res) => {
  let docs = [];
  try { docs = await publicPromptsByKey(req.params[0]); } catch (err) { console.error('GET /u/:key meta', err.message); }
  if (!docs.length) return sendIndex(req, res, siteMeta(req));
  const t = stats.totals(docs);
  const by = metaText(bylineFor(newest(docs)), 60);
  return sendIndex(req, res, {
    title: `${by} on Spellbook`,
    description: `${t.prompts} public prompt${t.prompts === 1 ? '' : 's'}, copied ${t.copies.toLocaleString('en-US')} time${t.copies === 1 ? '' : 's'}.`,
    image: `${origin(req)}/og.png`,
    url: `${origin(req)}/u/${req.params[0]}`,
  });
});

app.get('*', (req, res) => sendIndex(req, res, siteMeta(req)));

app.listen(PORT, () => {
  console.log(`Spellbook listening on :${PORT}`);

  // Stock the shelf, once, ever. After the listener rather than before it so a
  // Firestore that is slow or unreachable delays no request and fails no
  // health check - an empty library is a worse first impression than a small
  // one, but an app that will not boot is worse than both.
  //
  // The owning uid is the admin's so a seeded prompt can be fixed from inside
  // the app; with no ADMIN_EMAIL it falls back to a reserved id and they are
  // read-only. seed.js explains why that is the honest fallback.
  const authorId = ADMIN_EMAIL
    ? Buffer.from(ADMIN_EMAIL.toLowerCase()).toString('base64url')
    : undefined;
  seed.ensureSeeded(db, { authorId }).then((r) => {
    if (r.seeded) console.log(`seed: wrote ${r.count} starter prompts`);
  });
});
