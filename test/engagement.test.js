process.env.NODE_ENV = 'test';
process.env.SPELLBOOK_OWN_REGISTRATION = '1'; // these suites create accounts through the old door
// Author stats, public author pages, copy milestones and link previews,
// through the real routes (2026-09-26).
//
// The half that could go wrong quietly is privacy: a private prompt's title
// turning up in a preview tag, a stranger's author page summing a private
// prompt's counters, or an author's uid (which decodes to their email) riding
// along in a public response. Every one of those would look like the feature
// working, so each is asserted here.
const h = require('./harness.js');
h.install();
Object.assign(process.env, {
  CRON_SECRET: 'spell-cron-key-for-tests',
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn',
  SESSION_SECRET: 'spellbook-secret-abcdefghij',
  FIRESTORE_DATABASE_ID: 'spellbook', IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test', ANTHROPIC_API_KEY: 'sk-ant-test',
  PASSKEY_RP_ID: 'strongtechnicalconsulting.com', ADMIN_EMAIL: 'boss@example.com',
  PORT: '9271',
});
require(require('path').join(__dirname, '..', 'server.js'));
const stats = require('../authorstats');
const B = 'http://127.0.0.1:9271';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const req = (m, p, b, c) => fetch(B + p, { method: m, headers: c ? { ...J, cookie: c } : J, body: b === undefined ? undefined : JSON.stringify(b) });
const post = (p, b, c) => req('POST', p, b || {}, c);
const get = (p, c) => fetch(B + p, { headers: c ? { cookie: c } : {} });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const store = h.bag('spellbook');
const bump = (id, patch) => store.set('prompts/' + id, Object.assign({}, store.get('prompts/' + id), patch));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (buf) => PNG.every((b, i) => buf[i] === b);
const metas = (html) => (html.match(/<meta [^>]*>/g) || []).join('\n');

const HOSTILE = '"><script>alert(1)</script> & \'quotes\' <img src=x onerror=alert(2)>';
const SECRET_TITLE = 'SECRET-TITLE-do-not-leak';
const SECRET_BODY = 'TOPSECRET-PRIVATE-BODY {{thing}}';

(async () => {
  await new Promise((r) => setTimeout(r, 1200)); // let the seed land

  const ownerEmail = 'owner@example.com';
  const ownerUid = Buffer.from(ownerEmail).toString('base64url');
  const owner = jar(await post('/api/auth/register', { email: ownerEmail, password: 'a-long-password-1', displayName: 'Owner Olga' }));
  const stranger = jar(await post('/api/auth/register', { email: 'stranger@example.com', password: 'a-long-password-2', displayName: 'Stan' }));

  const mk = async (body, cookie) => (await (await post('/api/prompts', Object.assign({ platforms: ['claude'], category: 'coding' }, body), cookie)).json());
  const pub = await mk({ title: HOSTILE, summary: 'Summary with "quotes" & <b>tags</b>', body: 'Review {{language}} code for {{audience}}. ' + 'x'.repeat(50) }, owner);
  const pub2 = await mk({ title: 'Second public one', body: 'Another public prompt body' }, owner);
  const priv = await mk({ title: SECRET_TITLE, body: SECRET_BODY, visibility: 'private' }, owner);
  ok('fixtures created', pub.id && pub2.id && priv.id, JSON.stringify([pub.id, pub2.id, priv.id]));

  // Real engagement numbers, written as the counters would have left them.
  bump(pub.id, { copyCount: 1000, saveCount: 300, remixCount: 20, score: 7 });
  bump(pub2.id, { copyCount: 240, saveCount: 10, remixCount: 2 });
  bump(priv.id, { copyCount: 9999, saveCount: 999, remixCount: 999, score: 999 });

  // A crowd of 25 other authors, so a rank is allowed to show.
  for (let i = 0; i < 25; i++) {
    store.set('prompts/crowd' + i, { title: 'Crowd ' + i, body: 'crowd body text', visibility: 'public', platforms: ['claude'],
      authorId: 'crowd-author-' + i, authorName: 'Crowd ' + i, copyCount: i, saveCount: 0, remixCount: 0, score: 0,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', trendScore: 0 });
  }

  // --- the uid is no longer public -------------------------------------------
  let r = await get('/api/prompts?sort=copied');
  let text = await r.text();
  ok('no public prompt carries authorId', !text.includes('"authorId"'));
  ok("...and the owner's uid (their email, base64url) appears nowhere", !text.includes(ownerUid));
  ok('...nor the private prompt', !text.includes(SECRET_TITLE) && !text.includes('TOPSECRET'));
  const listed = JSON.parse(text).prompts.find((p) => p.id === pub.id);
  ok('...each carries an opaque author key instead', listed && stats.AUTHOR_KEY_RE.test(listed.authorKey), listed && listed.authorKey);
  r = await get('/api/prompts', owner);
  ok('a signed-in author sees isMine on their own cards', (await r.json()).prompts.some((p) => p.id === pub.id && p.isMine === true));

  // --- your stats -------------------------------------------------------------
  r = await get('/api/my/stats');
  ok('stats need an account', r.status === 401, String(r.status));
  r = await get('/api/my/stats', owner);
  const s = await r.json();
  ok('stats: totals sum PUBLIC prompts only', s.totals && s.totals.copies === 1240 && s.totals.saves === 310
    && s.totals.remixes === 22 && s.totals.prompts === 2, JSON.stringify(s.totals));
  ok('stats: the private one is counted, not summed', s.privateCount === 1, String(s.privateCount));
  ok('stats: best prompt is the most copied public one', s.best && s.best.id === pub.id);
  ok('stats: Top 5% among 27 authors', s.rank && s.rank.label === 'Top 5% author' && s.rank.authors >= 20, JSON.stringify(s.rank));
  ok('stats: every badge listed, some locked with hints', s.badges.length === stats.BADGES.length
    && s.badges.some((b) => !b.earned && b.hint) && s.badges.find((b) => b.id === 'copies-1000').earned);
  ok('stats: a public page to share', s.publicPath === '/u/' + listed.authorKey, s.publicPath);
  ok('stats: byline, not email - the first word of the name', s.byline === 'Owner', s.byline);
  r = await get('/api/my/stats', stranger);
  const ss = await r.json();
  ok('an author with no prompts: zero totals, no rank, no page', ss.totals.prompts === 0 && ss.rank === null && ss.publicPath === null);

  // --- the public author page -------------------------------------------------
  const key = listed.authorKey;
  r = await get('/api/authors/' + key);
  text = await r.text();
  const a = JSON.parse(text);
  ok('an author page opens signed out', r.status === 200, String(r.status));
  ok('...listing only public prompts', a.prompts.length === 2 && a.prompts.every((p) => p.visibility === 'public'));
  ok('...with totals that never include a private prompt', a.totals.copies === 1240 && a.totals.saves === 310, JSON.stringify(a.totals));
  ok('...and no trace of the private prompt, the uid or the email',
    !text.includes(SECRET_TITLE) && !text.includes('TOPSECRET') && !text.includes(ownerUid) && !text.includes('owner@'));
  ok('...no rank on the public page', a.rank === undefined);
  ok('...earned badges only', a.badges.length > 0 && a.badges.every((b) => b.earned === undefined && b.name));
  ok('...byline shown', a.byline === 'Owner', a.byline);
  r = await get('/api/authors/' + key, owner);
  ok('the author sees it is theirs', (await r.json()).isMe === true);
  r = await get('/api/authors/' + key, stranger);
  ok('a stranger does not', (await r.json()).isMe === false);
  r = await get('/api/authors/' + ownerUid);
  ok('the uid is not a way in', r.status === 404, String(r.status));
  r = await get('/api/authors/AAAAAAAAAAAAAAAA');
  ok('an unknown key 404s', r.status === 404, String(r.status));

  // Someone whose only prompt is private has no public page at all.
  const shy = jar(await post('/api/auth/register', { email: 'shy@example.com', password: 'a-long-password-3', displayName: 'Shy' }));
  await mk({ title: 'Shy private', body: 'nobody sees this one', visibility: 'private' }, shy);
  const shyKey = stats.authorKey(Buffer.from('shy@example.com').toString('base64url'), process.env.SESSION_SECRET);
  r = await get('/api/authors/' + shyKey);
  ok('only-private author: 404, not an empty page', r.status === 404, String(r.status));
  r = await get('/u/' + shyKey);
  text = await r.text();
  ok('...and /u/ for them carries only the generic tags', !text.includes('Shy') && text.includes('og:image') && !text.includes('nobody sees'));

  // --- link previews ----------------------------------------------------------
  r = await get('/p/' + pub.id);
  let html = await r.text();
  let m = metas(html);
  ok('a public prompt link carries og tags', r.status === 200 && /og:title/.test(m) && /twitter:card" content="summary_large_image/.test(m));
  ok('...escaped: no markup breaks out of the head', !/<script>alert|<img src=x/.test(html.split('<style>')[0]) && (html.split('<style>')[0].match(/<[a-z]/g) || []).length === (html.split('<style>')[0].match(/<(meta|title|html|head)\b/g) || []).length, m);
  ok('...quotes and angle brackets are entities', m.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;quotes&#39;'), m);
  ok('...the image is this prompt’s card, absolute', m.includes(`content="${B}/p/${pub.id}.png"`), m);
  ok('...the description has the copy count and the summary', m.includes('Copied 1,000 times. Summary with &quot;quotes&quot; &amp; &lt;b&gt;tags&lt;/b&gt;'), m);
  ok('...the <title> is the prompt', /<title>&quot;&gt;&lt;script&gt;/.test(html));
  ok('...and exactly one <title>', (html.match(/<title>/g) || []).length === 1);

  const generic = await (await get('/p/doesNotExist123')).text();
  for (const who of [['signed out', undefined], ['the owner', owner], ['a stranger', stranger]]) {
    html = await (await get('/p/' + priv.id, who[1])).text();
    ok(`a private prompt link leaks nothing to ${who[0]}`, !html.includes(SECRET_TITLE) && !html.includes('TOPSECRET') && !html.includes(priv.id + '.png'));
  }
  html = await (await get('/p/' + priv.id)).text();
  ok('...and is byte-identical to a link that never existed', html === generic);
  r = await get('/p/' + priv.id + '.png');
  ok('a private prompt has no card', r.status === 404, String(r.status));
  r = await get('/p/doesNotExist123.png');
  ok('...exactly like a missing one', r.status === 404, String(r.status));

  r = await get('/p/' + pub.id + '.png');
  let buf = Buffer.from(await r.arrayBuffer());
  ok('a public prompt card is a PNG', r.status === 200 && r.headers.get('content-type') === 'image/png' && isPng(buf), r.status + ' ' + r.headers.get('content-type'));
  ok('...1200x630', buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630);
  ok('...nosniff and cacheable', r.headers.get('x-content-type-options') === 'nosniff' && /max-age/.test(r.headers.get('cache-control') || ''));
  const again = Buffer.from(await (await get('/p/' + pub.id + '.png')).arrayBuffer());
  ok('...served from cache the second time', again.equals(buf));
  await req('PATCH', '/api/prompts/' + pub.id, { title: 'Edited title' }, owner);
  const edited = Buffer.from(await (await get('/p/' + pub.id + '.png')).arrayBuffer());
  ok('...and redrawn after an edit', isPng(edited) && !edited.equals(buf));
  html = await (await get('/p/' + pub.id)).text();
  ok('...as are its tags', metas(html).includes('Edited title'));

  r = await get('/og.png');
  buf = Buffer.from(await r.arrayBuffer());
  ok('the front page has a card', r.status === 200 && isPng(buf));
  html = await (await get('/')).text();
  ok('...and the front page links it', metas(html).includes(`${B}/og.png`) && metas(html).includes('og:title" content="Spellbook"'));
  html = await (await get('/u/' + key)).text();
  ok('an author link unfolds with their byline', metas(html).includes('Owner on Spellbook') && metas(html).includes('2 public prompts, copied 1,240 times'), metas(html));
  ok('...and no email or uid', !html.includes('owner@') && !html.includes(ownerUid));

  // A hostile byline: escaped in the tags, harmless in the card.
  const evil = jar(await post('/api/auth/register', { email: 'evil@example.com', password: 'a-long-password-4', displayName: '"><script>x()</script>' }));
  const ev = await mk({ title: 'Evil‮ \u0007 title \u{1F525}', body: 'An ordinary body here' }, evil);
  const evKey = stats.authorKey(Buffer.from('evil@example.com').toString('base64url'), process.env.SESSION_SECRET);
  html = await (await get('/u/' + evKey)).text();
  ok('a hostile byline reaches the author tags as letters only', !html.includes('<script>x()') && metas(html).includes('scriptxscript on Spellbook'), metas(html));
  html = await (await get('/p/' + ev.id)).text();
  ok('control and bidi characters never reach a tag', !/[\u0007‮]/.test(metas(html)));
  r = await get('/p/' + ev.id + '.png');
  ok('...and the card still draws', r.status === 200 && isPng(Buffer.from(await r.arrayBuffer())));

  // A shared-account author who never chose a name: byline is not their email.
  const shared = jar(await post('/api/id/register', { email: 'noname@example.com', password: 'a-long-password-5' }));
  const nn = await mk({ title: 'From the shared door', body: 'A body long enough' }, shared);
  r = await get('/api/prompts/' + nn.id);
  const nnp = await r.json();
  ok('a nameless shared-account author is not bylined with their email', nnp.authorName && !nnp.authorName.includes('@'), nnp.authorName);

  // --- copy milestones ------------------------------------------------------------
  r = await get('/api/my/prompts', owner);
  let mine = await r.json();
  ok('milestones: the 1,000 is waiting for the author', mine.milestones.some((x) => x.id === pub.id && x.milestone === 1000)
    && mine.milestones.some((x) => x.id === pub2.id && x.milestone === 100), JSON.stringify(mine.milestones));
  ok('...never for a private prompt', !mine.milestones.some((x) => x.id === priv.id));
  r = await post('/api/my/milestones/seen', { ids: [pub.id] });
  ok('marking seen needs an account', r.status === 401, String(r.status));
  r = await post('/api/my/milestones/seen', { ids: [pub.id, pub2.id] }, stranger);
  ok("...and cannot mark someone else's", (await r.json()).marked === 0);
  r = await post('/api/my/milestones/seen', { ids: [pub.id, pub2.id, '../../etc'] }, owner);
  ok('the author marks theirs seen', (await r.json()).marked === 2);
  mine = await (await get('/api/my/prompts', owner)).json();
  ok('...and the toast does not come back', mine.milestones.length === 0, JSON.stringify(mine.milestones));
  ok('the stored flag is the milestone, worked out server-side', store.get('prompts/' + pub.id).celebratedCopies === 1000);
  bump(pub2.id, { copyCount: 1000 });
  mine = await (await get('/api/my/prompts', owner)).json();
  ok('crossing the next milestone raises a new one', mine.milestones.length === 1 && mine.milestones[0].milestone === 1000);

  // --- rollup: trending #1 badge and key backfill --------------------------------
  store.set('prompts/legacy1', { title: 'Old prompt', body: 'written before keys', visibility: 'public', platforms: ['claude'],
    authorId: ownerUid, authorName: 'Owner Olga', copyCount: 0, score: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', trendScore: 0 });
  r = await post('/api/cron/rollup', {}, owner);
  ok('any signed-in reader cannot run the rollup', r.status === 403, String(r.status));
  r = await fetch(B + '/api/cron/rollup', { method: 'POST', headers: { ...J, 'x-cron-key': 'spell-cron-key-for-tests' }, body: '{}' });
  const roll = await r.json();
  ok('the rollup runs', r.status === 200, JSON.stringify(roll));
  ok('...and backfills the public author key', store.get('prompts/legacy1').authorKey === key);
  ok('...stamps the #1 PUBLIC prompt, not the private one with more copies',
    !!store.get('prompts/' + pub.id).trendingTopAt && !store.get('prompts/' + priv.id).trendingTopAt,
    JSON.stringify(store.get('control/rollup')));
  const s2 = await (await get('/api/my/stats', owner)).json();
  ok('...which earns the #1 on Trending badge', s2.badges.find((b) => b.id === 'trending-1').earned);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
