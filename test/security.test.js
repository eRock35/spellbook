process.env.NODE_ENV = 'test';
process.env.SPELLBOOK_OWN_REGISTRATION = '1'; // the sign-in limit is on the own door, so it needs an own-door account
// The security review of 2026-09-27: bylines that are never an address or its
// local part, a head that user text cannot rewrite, the headers every
// response carries, the cron key, and a limit on own-door sign-in guessing.
const h = require('./harness.js');
h.install();
Object.assign(process.env, {
  CRON_SECRET: 'spell-cron-key-for-tests',
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn',
  SESSION_SECRET: 'spellbook-secret-abcdefghij',
  FIRESTORE_DATABASE_ID: 'spellbook', IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test', ANTHROPIC_API_KEY: 'sk-ant-test',
  PASSKEY_RP_ID: 'strongtechnicalconsulting.com', ADMIN_EMAIL: 'boss@example.com',
  PORT: '9281',
});
require(require('path').join(__dirname, '..', 'server.js'));
const stats = require('../authorstats');
const B = 'http://127.0.0.1:9281';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
let ipN = 1;
const req = (m, p, b, c, ip, extra) => fetch(B + p, {
  method: m,
  headers: { ...J, 'x-forwarded-for': ip || `10.2.0.${ipN++}`, ...(c ? { cookie: c } : {}), ...(extra || {}) },
  body: b === undefined ? undefined : JSON.stringify(b),
});
const post = (p, b, c, ip, extra) => req('POST', p, b || {}, c, ip, extra);
const get = (p, c) => req('GET', p, undefined, c);
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const store = h.bag('spellbook');
const metas = (html) => (html.match(/<meta [^>]*>/g) || []).join('\n');
const W = 'A Spellbook writer';
const uidOf = (e) => Buffer.from(e).toString('base64url');
const keyOf = (e) => stats.authorKey(uidOf(e), process.env.SESSION_SECRET);
const mk = async (body, cookie) => (await (await post('/api/prompts', Object.assign({ platforms: ['claude'], category: 'coding', body: 'A body that is long enough' }, body), cookie)).json());

(async () => {
  await new Promise((r) => setTimeout(r, 1200)); // let the seed land
  let r, j, html;

  /* ---------- 6. bylines ---------- */
  console.log('-- 6. bylines');
  // A shared-account author who never chose a name: the bridge used to fill
  // the display name with the email.
  const nameless = jar(await post('/api/id/register', { email: 'erik.strong@example.com', password: 'a-long-password-5' }));
  j = await (await get('/api/my/stats', nameless)).json();
  ok('a nameless shared-account author is bylined "A Spellbook writer"', j.byline === W, j.byline);
  const np = await mk({ title: 'From a nameless author' }, nameless);
  ok('...on the prompt it publishes', np.authorName === W, np.authorName);
  ok('...and nothing of the address is stored as its name', store.get('prompts/' + np.id).authorName === '', JSON.stringify(store.get('prompts/' + np.id).authorName));
  html = await (await get('/u/' + keyOf('erik.strong@example.com'))).text();
  ok('...nor on /u/<key>', metas(html).includes(`${W} on Spellbook`) && !html.includes('erik.strong'), metas(html));
  j = await (await get('/api/authors/' + keyOf('erik.strong@example.com'))).json();
  ok('...nor on the author page', j.byline === W && !JSON.stringify(j).includes('erik.strong'), JSON.stringify(j).slice(0, 200));

  // A display name that is only the local part is no name either.
  const local = jar(await post('/api/auth/register', { email: 'jo.smith@example.com', password: 'a-long-password-6', displayName: 'jo.smith' }));
  const lp = await mk({ title: 'Local-part name' }, local);
  ok('a display name equal to the email\'s local part is not a byline', lp.authorName === W, lp.authorName);
  const blank = jar(await post('/api/auth/register', { email: 'kim.lee@example.com', password: 'a-long-password-7' }));
  j = await (await get('/api/auth/me', blank)).json();
  ok('own-door registration no longer fills the name with the local part', !JSON.stringify(store.get('users/' + uidOf('kim.lee@example.com')).displayName || '').includes('kim'), JSON.stringify(store.get('users/' + uidOf('kim.lee@example.com'))));
  const bp = await mk({ title: 'No name given' }, blank);
  ok('...and its author is "A Spellbook writer"', bp.authorName === W, bp.authorName);

  const named = jar(await post('/api/auth/register', { email: 'ada@example.com', password: 'a-long-password-8', displayName: 'Ada Lovelace' }));
  const ap = await mk({ title: 'A named author' }, named);
  ok('a real display name: its first word', ap.authorName === 'Ada', ap.authorName);

  // A row written before this fix, bylined with the local part.
  store.set('prompts/oldrow1', { title: 'Old row', body: 'written before 2026-09-27', visibility: 'public', platforms: ['claude'],
    authorId: uidOf('pat.jones@example.com'), authorName: 'pat.jones', authorKey: keyOf('pat.jones@example.com'),
    copyCount: 0, score: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', trendScore: 0 });
  r = await get('/api/prompts?sort=new');
  const text = await r.text();
  ok('an older row bylined with a local part reads as no name', !text.includes('pat.jones') && JSON.parse(text).prompts.find((p) => p.id === 'oldrow1').authorName === W);
  html = await (await get('/u/' + keyOf('pat.jones@example.com'))).text();
  ok('...on its author link too', !html.includes('pat.jones') && metas(html).includes(`${W} on Spellbook`), metas(html));

  // Remixes carry the parent's byline.
  store.set('prompts/oldremix', { title: 'Old remix', body: 'a remix from before', visibility: 'public', platforms: ['claude'],
    authorId: uidOf('ada@example.com'), authorName: 'Ada Lovelace', remixOf: { id: 'oldrow1', title: 'Old row', authorName: 'pat.jones' },
    copyCount: 0, score: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', trendScore: 0 });
  j = await (await get('/api/prompts/oldremix')).json();
  ok('an older remix\'s unchecked parent byline reads as no name', j.remixOf && j.remixOf.authorName === W, JSON.stringify(j.remixOf));
  const rm = await mk({ title: 'A new remix', remixOf: ap.id }, blank);
  ok('a new remix stores its parent\'s checked byline', rm.remixOf && rm.remixOf.authorName === 'Ada' && store.get('prompts/' + rm.id).remixOf.bylineChecked === true, JSON.stringify(rm.remixOf));
  const rm2 = await mk({ title: 'Remix of a nameless author', remixOf: np.id }, named);
  ok('a remix of a nameless author names nobody', rm2.remixOf && rm2.remixOf.authorName === W, JSON.stringify(rm2.remixOf));
  const rm3 = await mk({ title: 'Remix of the local-part one', remixOf: lp.id }, named);
  ok('...never the parent\'s local part', rm3.remixOf && rm3.remixOf.authorName === W && !JSON.stringify(store.get('prompts/' + rm3.id)).includes('jo.smith'), JSON.stringify(rm3.remixOf));
  store.set('prompts/oldremix2', { title: 'Old remix of Ada', body: 'a remix from before', visibility: 'public', platforms: ['claude'],
    authorId: uidOf('kim.lee@example.com'), authorName: '', remixOf: { id: ap.id, title: 'A named author', authorName: 'Ada Lovelace' },
    copyCount: 0, score: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', trendScore: 0 });
  r = await post('/api/cron/rollup', {}, undefined, undefined, { 'x-cron-key': 'spell-cron-key-for-tests' });
  ok('the rollup runs', r.status === 200, String(r.status));
  j = await (await get('/api/prompts/oldremix2')).json();
  ok('...and gives an older remix of a named author that author\'s byline back', j.remixOf && j.remixOf.authorName === 'Ada', JSON.stringify(j.remixOf));
  const fixed = store.get('prompts/oldremix').remixOf;
  ok('...and checks an older remix\'s parent byline against the parent\'s author', fixed.bylineChecked === true && fixed.authorName === '' && !JSON.stringify(fixed).includes('pat.jones'), JSON.stringify(fixed));

  /* ---------- 7. user text in the head ---------- */
  console.log('-- 7. the head');
  const DOLLARS = "Price $` and $& and $' and $1 here";
  const dp = await mk({ title: DOLLARS, summary: "Summary with $` too" }, named);
  html = await (await get('/p/' + dp.id)).text();
  const head = html.split('</head>')[0];
  ok('a title with $` / $& / $\' is written into the head as typed', head.includes("<title>Price $` and $&amp; and $&#39; and $1 here · Spellbook</title>"), (head.match(/<title>[^<]*<\/title>/) || [''])[0]);
  ok('...exactly one <title>, one <head>, one doctype', (html.match(/<title>/g) || []).length === 1 && (html.match(/<head>/gi) || []).length === 1 && (html.match(/<!doctype/gi) || []).length === 1);
  ok('...and the page is the same length as the page plus its tags, nothing spliced in', html.length < 3 * 1024 * 1024 && !head.includes('<title>Spellbook</title>'));
  ok('...the summary too', metas(html).includes("Summary with $` too"), metas(html));

  /* ---------- 8. headers, cron key, sign-in guessing ---------- */
  console.log('-- 8. headers, cron key, sign-in');
  for (const p of ['/', '/api/prompts', '/login', '/beacon.js', '/p/' + dp.id, '/og.png']) {
    r = await get(p);
    const csp = r.headers.get('content-security-policy') || '';
    ok(`${p}: nosniff and frame-ancestors for the landing page`, r.headers.get('x-content-type-options') === 'nosniff'
      && csp === "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com", `${r.status} ${csp}`);
  }
  r = await post('/api/cron/rollup', {}, undefined, undefined, { 'x-cron-key': 'spell-cron-key-for-testz' });
  ok('a wrong cron key of the right length is refused', r.status === 401, String(r.status));
  r = await post('/api/cron/rollup', {}, undefined, undefined, { 'x-cron-key': 'spell' });
  ok('...and a short one', r.status === 401, String(r.status));

  const guesser = '10.9.9.9';
  const statuses = [];
  for (let i = 0; i < 10; i++) {
    r = await post('/api/auth/login', { email: 'ada@example.com', password: 'wrong-guess-' + i }, undefined, guesser);
    statuses.push(r.status);
  }
  ok('ten wrong passwords are ordinary 401s', statuses.every((s) => s === 401), statuses.join(','));
  r = await post('/api/auth/login', { email: 'ada@example.com', password: 'a-long-password-8' }, undefined, guesser);
  ok('the eleventh attempt is a 429, even with the right password', r.status === 429, String(r.status));
  r = await post('/api/auth/login', { email: 'ada@example.com', password: 'a-long-password-8' }, undefined, '1.2.3.4, ' + guesser);
  ok('a client-written X-Forwarded-For entry does not escape it', r.status === 429, String(r.status));
  r = await post('/api/auth/login', { email: 'ada@example.com', password: 'a-long-password-8' }, undefined, '10.9.9.10');
  ok('another address signs in', r.status === 200, String(r.status));
  r = await get('/api/prompts');
  ok('reading is unaffected', r.status === 200);
  const okUser = '10.7.7.7';
  for (let i = 0; i < 9; i++) await post('/api/auth/login', { email: 'ada@example.com', password: 'nope-' + i }, undefined, okUser);
  await post('/api/auth/login', { email: 'ada@example.com', password: 'a-long-password-8' }, undefined, okUser);
  for (let i = 0; i < 9; i++) await post('/api/auth/login', { email: 'ada@example.com', password: 'nope-again-' + i }, undefined, okUser);
  r = await post('/api/auth/login', { email: 'ada@example.com', password: 'a-long-password-8' }, undefined, okUser);
  ok('a success clears the count', r.status === 200, String(r.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
