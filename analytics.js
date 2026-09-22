// Cross-app view tracking and trending, for every app on
// strongtechnicalconsulting.com.
//
// Why this lives in Spellbook rather than in the landing page: the landing page
// is deliberately a static, dependency-light Express server that must scale to
// zero (see eriks-projects/server.js for the cost reasoning). Giving it a
// Firestore client, a write path and a stats aggregator would make it a real
// backend and put a database round trip in front of the root domain. Spellbook
// already has a Firestore database and an admin account, so the beacon lands
// here and the page stays a page.
//
// What is stored, and what deliberately is not:
//   stored      — app name, coarse path, referrer HOST, a random opaque
//                 visitor id in a first-party cookie, and counters.
//   NOT stored  — IP addresses, user agents, full referrer URLs, query
//                 strings, or anything tied to a signed-in identity.
// That is the whole privacy position: enough to count and rank, not enough to
// follow a person. Don't add an IP column "just for geo" without deciding that
// tradeoff out loud.

const crypto = require('crypto');
const { FieldValue } = require('@google-cloud/firestore');

// The apps that may report views. An allowlist rather than free text so a
// stray or hostile beacon can't invent an app and pollute the charts.
//
// santa-rosa-beach-trip is deliberately ABSENT. It is private, holds family
// PII, and both its repo and DEPLOY.md say its hostname stays off public
// surfaces — this file is in a public repo, and a public /api/stats response
// naming it would undo that. Don't add it.
const APPS = {
  landing:   { label: 'Landing page', url: 'https://www.strongtechnicalconsulting.com', icon: '\u{1F3E0}' },
  football:  { label: 'College Football', url: 'https://footballapp.strongtechnicalconsulting.com', icon: '\u{1F3C8}' },
  hopscotch: { label: 'Hopscotch', url: 'https://beer.strongtechnicalconsulting.com', icon: '\u{1F37A}' },
  trip:      { label: 'Trip Planner', url: 'https://trip.strongtechnicalconsulting.com', icon: '✈️' },
  // The custom domain is the intended address and is what this field should
  // say, but it only resolves once the Cloud Run DOMAIN MAPPING exists -- the
  // DNS CNAME alone is not enough, Google needs the mapping to know which
  // service to route to. Until then the landing page's beacon targets the
  // *.run.app hostname instead (see site/index.html in eriks-projects). This
  // field is metadata in the stats payload, not the beacon target, so the
  // mismatch costs nothing while it lasts.
  spellbook: { label: 'Spellbook', url: 'https://spellbook.strongtechnicalconsulting.com', icon: '✨' },
  dataviz:   { label: 'DataViz', url: 'https://dataviz.strongtechnicalconsulting.com', icon: '\u{1F4CA}' },
  friction:  { label: 'Friction', url: 'https://friction.strongtechnicalconsulting.com', icon: '\u{1F9ED}' },
};

const VISITOR_COOKIE = 'sbvid';
const VISITOR_TTL_SECONDS = 60 * 60 * 24 * 400;
const SERIES_DAYS = 90;          // how much history the dashboard can draw
const PUBLIC_SERIES_DAYS = 30;   // what the landing page gets

// One instance can only be shouted at so fast. This is not a security control
// (a determined caller just waits); it stops an accidental render loop in a
// page from writing thousands of documents and running up a Firestore bill.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 40;
const recentHits = new Map(); // visitor id -> {count, windowStart}

// Cheap, deliberately incomplete bot screen. The goal is to keep obvious
// crawlers out of the counts, not to win an arms race.
const BOT_RE = /bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python-requests|facebookexternalhit|bingpreview|lighthouse/i;

function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function dayList(days) {
  const out = [];
  const today = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(isoDay(today - i * 86400000));
  }
  return out;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

// The beacon is cross-site: the landing page at www. posts to spellbook. so
// the cookie needs SameSite=None, which in turn requires Secure. Partitioned
// keeps it working under Chrome's third-party cookie phase-out — it gives each
// top-level site its own copy, which is fine here because the count we care
// about is per-app anyway.
function setVisitorCookie(res, vid) {
  res.setHeader('Set-Cookie',
    `${VISITOR_COOKIE}=${vid}; Path=/; Max-Age=${VISITOR_TTL_SECONDS}; HttpOnly; Secure; SameSite=None; Partitioned`);
}

// Keep only the host. A full referrer URL can carry a search query or a
// session token in a path, and none of that is needed to answer "where did
// they come from".
function referrerHost(ref) {
  if (!ref) return '';
  try {
    const h = new URL(String(ref)).hostname.toLowerCase();
    return h.length > 100 ? '' : h;
  } catch (e) {
    return '';
  }
}

// Firestore document ids cannot contain '/', and a path is mostly slashes.
function pathKey(p) {
  const clean = String(p || '/').split('?')[0].split('#')[0].slice(0, 120);
  return clean.replace(/[^A-Za-z0-9._~-]+/g, '_') || 'root';
}

function rateLimited(vid) {
  const now = Date.now();
  const seen = recentHits.get(vid);
  if (!seen || now - seen.windowStart > RATE_WINDOW_MS) {
    recentHits.set(vid, { count: 1, windowStart: now });
    // Bounded so a long-lived instance can't grow this map without limit.
    if (recentHits.size > 5000) recentHits.clear();
    return false;
  }
  seen.count += 1;
  return seen.count > RATE_MAX_PER_WINDOW;
}

/**
 * Hacker-News-shaped decay. Views alone would let a months-old app that once
 * went round a group chat sit at the top forever; dividing by age makes
 * "trending" mean recent, which is what the word means to a reader.
 */
function trendScore(weight, ageHours) {
  return weight / Math.pow(Math.max(ageHours, 0) + 2, 1.5);
}

function createAnalytics(opts) {
  const { db, requireAdmin, requireLogin } = opts;
  const appDoc = (app) => db.collection('analytics').doc(app);

  // --- write path ----------------------------------------------------------
  async function record(app, path, ref, vid) {
    const day = isoDay(Date.now());
    const dailyRef = appDoc(app).collection('daily').doc(day);

    // A visitor is "unique for today" the first time their id is written under
    // today's date. create() fails if it already exists, which is the cheapest
    // available test-and-set — no read needed on the common repeat-view path.
    let isNewToday = false;
    try {
      await dailyRef.collection('visitors').doc(vid).create({ at: new Date().toISOString() });
      isNewToday = true;
    } catch (e) {
      if (!e || e.code !== 6) throw e; // 6 = ALREADY_EXISTS, the expected case
    }

    const writes = [
      appDoc(app).set({
        app,
        label: APPS[app].label,
        totalViews: FieldValue.increment(1),
        totalUniques: FieldValue.increment(isNewToday ? 1 : 0),
        lastSeenAt: new Date().toISOString(),
      }, { merge: true }),
      dailyRef.set({
        date: day,
        views: FieldValue.increment(1),
        uniques: FieldValue.increment(isNewToday ? 1 : 0),
      }, { merge: true }),
      appDoc(app).collection('paths').doc(pathKey(path)).set({
        path: String(path || '/').slice(0, 120),
        views: FieldValue.increment(1),
      }, { merge: true }),
    ];

    const host = referrerHost(ref);
    // Self-referrals are noise — every in-app navigation would otherwise show
    // the app as its own top traffic source.
    if (host && !host.endsWith('strongtechnicalconsulting.com')) {
      writes.push(appDoc(app).collection('refs').doc(pathKey(host)).set({
        host, hits: FieldValue.increment(1),
      }, { merge: true }));
    }

    await Promise.all(writes);
    return { isNewToday };
  }

  // --- read path -----------------------------------------------------------
  async function seriesFor(app, days) {
    const wanted = dayList(days);
    const snap = await appDoc(app).collection('daily')
      .where('date', '>=', wanted[0]).get();
    const byDay = new Map();
    snap.docs.forEach((d) => byDay.set(d.id, d.data()));
    return wanted.map((date) => {
      const d = byDay.get(date) || {};
      return { date, views: d.views || 0, uniques: d.uniques || 0 };
    });
  }

  function summarize(series) {
    const n = series.length;
    const sum = (from, to) => series.slice(from, to).reduce((a, b) => a + b.views, 0);
    const last7 = sum(n - 7, n);
    const prev7 = sum(n - 14, n - 7);
    return {
      views7: last7,
      views7Prev: prev7,
      views30: sum(Math.max(0, n - 30), n),
      // No previous window means no comparison to make. null renders as "new",
      // which is honest; 0 or Infinity would both be lies.
      trendPct: prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : null,
    };
  }

  async function overview(days) {
    const names = Object.keys(APPS);
    const totals = await db.getAll(...names.map((a) => appDoc(a)));
    const rows = await Promise.all(names.map(async (app, i) => {
      const series = await seriesFor(app, days);
      const t = totals[i].exists ? totals[i].data() : {};
      // Ranked on the newest week, with trendPct carrying the direction. No
      // decay term here: unlike a prompt, an app does not age out of the list -
      // there are five of them and all five always belong on the chart.
      const s = summarize(series);
      return {
        app,
        label: APPS[app].label,
        icon: APPS[app].icon,
        url: APPS[app].url,
        totalViews: t.totalViews || 0,
        totalUniques: t.totalUniques || 0,
        lastSeenAt: t.lastSeenAt || null,
        series,
        ...s,
      };
    }));
    rows.sort((a, b) => b.views7 - a.views7 || b.totalViews - a.totalViews);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  function mount(app) {
    // The beacon is called from other origins, so it needs CORS — and
    // credentials:'include' on the caller's side means the allowed origin must
    // be echoed exactly, never '*'.
    const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?strongtechnicalconsulting\.com$/;
    function cors(req, res, next) {
      const origin = req.get('Origin');
      if (origin && ALLOWED_ORIGIN.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }

    app.options('/api/beacon', cors, (req, res) => res.status(204).end());
    app.post('/api/beacon', cors, async (req, res) => {
      // Always 204, whatever happened. A beacon that reports errors teaches a
      // caller how to probe the allowlist, and a page must never be slowed or
      // broken by its own analytics failing.
      try {
        const name = String((req.body && req.body.app) || '').toLowerCase();
        if (!APPS[name]) return res.status(204).end();
        if (BOT_RE.test(req.get('User-Agent') || '')) return res.status(204).end();

        let vid = parseCookies(req)[VISITOR_COOKIE];
        if (!vid || !/^[a-f0-9]{24}$/.test(vid)) {
          vid = crypto.randomBytes(12).toString('hex');
          setVisitorCookie(res, vid);
        }
        if (rateLimited(vid)) return res.status(204).end();

        await record(name, (req.body && req.body.path) || '/', (req.body && req.body.ref) || '', vid);
        return res.status(204).end();
      } catch (err) {
        console.error('POST /api/beacon', err);
        return res.status(204).end();
      }
    });

    // Public because the landing page consumes it to rank its own cards, and
    // because view counts on Erik's own hobby projects are not a secret. It
    // returns counts and shape only — no visitor ids, no referrers, no paths.
    // If that ever stops feeling right, this is the one route to gate.
    app.get('/api/stats/public', cors, async (req, res) => {
      try {
        const rows = await overview(PUBLIC_SERIES_DAYS);
        res.set('Cache-Control', 'public, max-age=300');
        res.json({
          days: PUBLIC_SERIES_DAYS,
          apps: rows.map((r) => ({
            app: r.app, label: r.label, icon: r.icon, url: r.url, rank: r.rank,
            totalViews: r.totalViews, views7: r.views7, views30: r.views30,
            trendPct: r.trendPct,
            spark: r.series.map((d) => d.views),
          })),
        });
      } catch (err) {
        console.error('GET /api/stats/public', err);
        res.status(500).json({ error: 'Could not load stats.' });
      }
    });

    // The full picture: uniques, per-path and referrer breakdowns, 90 days.
    // requireAdmin 404s for everyone else, same as the other apps.
    app.get('/api/admin/stats', requireLogin, requireAdmin, async (req, res) => {
      try {
        const rows = await overview(SERIES_DAYS);
        const detail = await Promise.all(rows.map(async (r) => {
          const [paths, refs] = await Promise.all([
            appDoc(r.app).collection('paths').orderBy('views', 'desc').limit(10).get(),
            appDoc(r.app).collection('refs').orderBy('hits', 'desc').limit(10).get(),
          ]);
          return {
            ...r,
            topPaths: paths.docs.map((d) => d.data()),
            topRefs: refs.docs.map((d) => d.data()),
          };
        }));
        res.json({ days: SERIES_DAYS, apps: detail });
      } catch (err) {
        console.error('GET /api/admin/stats', err);
        res.status(500).json({ error: 'Could not load stats.' });
      }
    });
  }

  return { mount, overview, trendScore, APPS };
}

module.exports = { createAnalytics, trendScore, APPS };
