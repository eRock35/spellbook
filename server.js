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
const path = require('path');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const { createAccounts } = require('./accounts');
const identityLib = require('./identity');
const identityStore = require('./identity-store');
const {
  PLATFORMS, CATEGORIES, clean, pickList, cleanTags, extractVariables,
  computeTrend, bodyToPromptFields,
} = require('./promptfields');

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
app.set('trust proxy', true);

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
    displayName: (own && own.displayName) || u.displayName || u.email,
    // The owner flag can come from either side. Identity's `admin` is the
    // domain-wide one; a local isAdmin predates it and still stands.
    isAdmin: u.admin === true || !!(own && own.isAdmin),
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
  const key = req.get('X-Cron-Key');
  if (CRON_SECRET && key && key === CRON_SECRET) {
    req.isCron = true;
    return next();
  }
  return requireLogin(req, res, next);
}

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const prompts = () => db.collection('prompts');

function publicPrompt(id, d, extra) {
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
    authorId: d.authorId || null,
    authorName: d.authorName || 'anonymous',
    visibility: d.visibility || 'public',
    score: d.score || 0,
    upvotes: d.upvotes || 0,
    downvotes: d.downvotes || 0,
    copyCount: d.copyCount || 0,
    saveCount: d.saveCount || 0,
    remixCount: d.remixCount || 0,
    viewCount: d.viewCount || 0,
    remixOf: d.remixOf || null,
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
app.get('/api/prompts', requireLogin, async (req, res) => {
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
    const ids = rows.slice(0, 60).map((p) => p.id);
    const [myVotes, mySaves] = await Promise.all([
      ids.length ? db.getAll(...ids.map((id) => prompts().doc(id).collection('votes').doc(req.user.uid))) : [],
      ids.length ? db.getAll(...ids.map((id) => db.collection('users').doc(req.user.uid).collection('saves').doc(id))) : [],
    ]);
    const voteBy = {};
    myVotes.forEach((d, i) => { if (d.exists) voteBy[ids[i]] = d.data().value; });
    const savedBy = {};
    mySaves.forEach((d, i) => { if (d.exists) savedBy[ids[i]] = true; });

    res.json({
      total: rows.length,
      truncated: snap.size >= SCAN_LIMIT,
      prompts: rows.slice(0, 60).map((p) => Object.assign(p, {
        myVote: voteBy[p.id] || 0,
        saved: !!savedBy[p.id],
      })),
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

app.get('/api/prompts/:id', requireLogin, async (req, res) => {
  const found = await loadVisiblePrompt(req, res);
  if (!found) return;
  try {
    const [vote, save] = await Promise.all([
      found.ref.collection('votes').doc(req.user.uid).get(),
      db.collection('users').doc(req.user.uid).collection('saves').doc(req.params.id).get(),
    ]);
    // Fire-and-forget: a view counter is not worth failing a read over, and
    // awaiting it puts a write in the latency path of every page open.
    found.ref.update({ viewCount: FieldValue.increment(1) }).catch(() => {});
    res.json(publicPrompt(found.doc.id, found.data, {
      myVote: vote.exists ? vote.data().value : 0,
      saved: save.exists,
      isMine: found.data.authorId === req.user.uid,
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
        base.remixOf = { id: parent.id, title: parent.data().title, authorName: parent.data().authorName };
        parent.ref.update({ remixCount: FieldValue.increment(1) }).catch(() => {});
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
        authorName: found.data.authorName,
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

app.post('/api/cron/rollup', requireLoginOrCron, async (req, res) => {
  try {
    const snap = await prompts().orderBy('trendScore', 'desc').limit(MAX_RESCORE_PER_RUN).get();
    let rescored = 0;
    // Batched in chunks because a Firestore write batch caps at 500 and a
    // per-document update would be 500 round trips.
    let batch = db.batch();
    let inBatch = 0;
    for (const doc of snap.docs) {
      const next = computeTrend(doc.data());
      if (Math.abs(next - (doc.data().trendScore || 0)) > 1e-9) {
        batch.update(doc.ref, { trendScore: next });
        rescored += 1;
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
    }, { merge: true });

    res.json({ scanned: snap.size, rescored });
  } catch (err) {
    console.error('POST /api/cron/rollup', err);
    res.status(500).json({ error: 'Rollup failed.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Spellbook listening on :${PORT}`);
});
