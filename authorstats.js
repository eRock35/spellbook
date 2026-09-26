// Author stats, badges and copy milestones (2026-09-26).
//
// The pure half: sums, a rank, badges and milestones, from prompt documents
// the server has already read. No Firestore, no model call, nothing stored
// here - badges are computed on read from the counters the prompts already
// carry, so there is no second ledger to drift from the first.
//
// Every figure counts PUBLIC prompts only, for the author as for a stranger.
// A private prompt can only be copied or saved by its own author (the routes
// 404 it for everyone else), so its counters are self-use, not an audience -
// and a private prompt must never move a number a stranger can see.

const crypto = require('crypto');

/** Copy counts that earn a one-time "copied N times" toast. */
const MILESTONES = [10, 100, 1000];

/** Percentile is shown only when there is a crowd to be in the top of. */
const MIN_AUTHORS_FOR_RANK = 20;
/** "Top 5%" rather than "Top 7%": coarse, and never above "Top 50%". */
const RANK_BUCKETS = [1, 5, 10, 25, 50];

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const isPublic = (p) => p && p.visibility === 'public';

/**
 * The public handle in /u/<key>.
 *
 * NOT the uid. A uid is base64url(lowercased email), which decodes back to the
 * address in one line, so a URL built from it would publish every author's
 * email. This is an HMAC of the uid under a key derived from SESSION_SECRET:
 * stable, opaque, and not something a stranger can compute for an address
 * they are curious about. Rotating SESSION_SECRET changes every key (old
 * /u/ links then 404); the rollup rewrites the stored copies on its next run.
 */
function authorKey(uid, secret) {
  if (!uid) return null;
  const k = crypto.createHmac('sha256', String(secret || 'spellbook-dev')).update('author-key:v1').digest();
  return crypto.createHmac('sha256', k).update(String(uid)).digest('base64url').slice(0, 16);
}
const AUTHOR_KEY_RE = /^[A-Za-z0-9_-]{16}$/;

/** Sums over an author's public prompts. `prompts` are stored documents. */
function totals(prompts) {
  const pub = (prompts || []).filter(isPublic);
  const t = { prompts: pub.length, copies: 0, saves: 0, remixes: 0, votes: 0, views: 0 };
  for (const p of pub) {
    t.copies += n(p.copyCount);
    t.saves += n(p.saveCount);
    t.remixes += n(p.remixCount);
    t.views += n(p.viewCount);
    t.votes += Number.isFinite(Number(p.score)) ? Math.trunc(Number(p.score)) : 0;
  }
  return t;
}

/** The public prompt that got used most: copies, then saves, then score. */
function bestPrompt(prompts) {
  let best = null;
  for (const p of (prompts || []).filter(isPublic)) {
    if (!best) { best = p; continue; }
    const a = [n(p.copyCount), n(p.saveCount), Number(p.score) || 0];
    const b = [n(best.copyCount), n(best.saveCount), Number(best.score) || 0];
    for (let i = 0; i < a.length; i++) {
      if (a[i] > b[i]) { best = p; break; }
      if (a[i] < b[i]) break;
    }
  }
  return best;
}

/** Copies per author over a window of public prompts: Map<authorId, copies>. */
function authorTable(publicPrompts) {
  const m = new Map();
  for (const p of publicPrompts || []) {
    if (!isPublic(p) || !p.authorId) continue;
    m.set(p.authorId, (m.get(p.authorId) || 0) + n(p.copyCount));
  }
  return m;
}

/**
 * Where an author's copies sit among every author's, or null when there is
 * nothing honest to say: fewer than MIN_AUTHORS_FOR_RANK authors (being "top
 * 10%" of eight people is not a claim), no copies yet, or outside the top
 * half (nobody needs to be told they are in the bottom 60%).
 *
 * `table` is authorTable() over a bounded window; the author's own figure
 * comes from their own full totals and replaces the window's, so an author
 * whose prompts fall partly outside the window is not undercounted.
 */
function percentile(table, authorId, myCopies, { minAuthors = MIN_AUTHORS_FOR_RANK } = {}) {
  const others = [];
  for (const [id, c] of table || []) if (id !== authorId) others.push(c);
  const authors = others.length + 1;
  const mine = n(myCopies);
  if (authors < minAuthors || mine <= 0) return null;
  const rank = 1 + others.filter((c) => c > mine).length;
  const exact = (rank / authors) * 100;
  const bucket = RANK_BUCKETS.find((b) => exact <= b);
  if (!bucket) return null;
  return { rank, authors, topPercent: bucket, label: `Top ${bucket}% author` };
}

/**
 * Every badge, earned or not. Locked ones are shown greyed with how to get
 * them - a greyed "Thousand club" is a reason to come back.
 */
const BADGES = [
  { id: 'first-prompt', name: 'First spell', hint: 'Publish your first public prompt.', stat: 'prompts', need: 1 },
  { id: 'five-prompts', name: 'Spellcaster', hint: 'Publish 5 public prompts.', stat: 'prompts', need: 5 },
  { id: 'first-copy', name: 'Someone used it', hint: 'Get your first copy.', stat: 'copies', need: 1 },
  { id: 'copies-100', name: 'Hundred club', hint: 'Get 100 copies across your prompts.', stat: 'copies', need: 100 },
  { id: 'copies-1000', name: 'Thousand club', hint: 'Get 1,000 copies across your prompts.', stat: 'copies', need: 1000 },
  { id: 'saved-50', name: 'Keeper', hint: 'Get saved 50 times.', stat: 'saves', need: 50 },
  { id: 'remixed-10', name: 'Remixed 10x', hint: 'Have your prompts remixed 10 times.', stat: 'remixes', need: 10 },
  { id: 'trending-1', name: '#1 on Trending', hint: 'Reach the top of the Trending list.', stat: 'trendingTop', need: 1 },
];

/**
 * @param t        totals()
 * @param prompts  the author's stored prompts (for the trending mark)
 */
function badges(t, prompts) {
  const have = Object.assign({}, t, {
    trendingTop: (prompts || []).some((p) => isPublic(p) && p.trendingTopAt) ? 1 : 0,
  });
  return BADGES.map((b) => {
    const got = n(have[b.stat]);
    return {
      id: b.id, name: b.name, hint: b.hint,
      earned: got >= b.need,
      progress: { have: Math.min(got, b.need), need: b.need },
    };
  });
}

/** The highest milestone a copy count has reached, or 0. */
function milestoneFor(copies) {
  const c = n(copies);
  let m = 0;
  for (const x of MILESTONES) if (c >= x) m = x;
  return m;
}

/**
 * Milestones the author has not been shown yet: one per prompt, the highest
 * reached, when it is above `celebratedCopies` (the stored flag). A prompt
 * that went from 8 to 150 copies between visits says 100 once, not 10 and
 * then 100.
 */
function pendingMilestones(prompts) {
  const out = [];
  for (const p of prompts || []) {
    if (!isPublic(p)) continue;
    const m = milestoneFor(p.copyCount);
    if (m && m > n(p.celebratedCopies)) out.push({ id: p.id, title: p.title || 'Untitled', milestone: m });
  }
  return out.sort((a, b) => b.milestone - a.milestone).slice(0, 5);
}

module.exports = {
  MILESTONES, MIN_AUTHORS_FOR_RANK, RANK_BUCKETS, BADGES, AUTHOR_KEY_RE,
  authorKey, totals, bestPrompt, authorTable, percentile, badges, milestoneFor, pendingMilestones,
};
