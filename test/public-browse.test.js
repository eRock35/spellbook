// Browsing is open; writing is not.
//
// This is the half of the change that could go wrong quietly. Opening the read
// routes is only safe if "public" really means public-only and every write
// still asks for a session - and a mistake there would not look like an error,
// it would look like the app working.
const h = require('./harness.js');
h.install();
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn',
  SESSION_SECRET: 'spellbook-secret-abcdefghij',
  FIRESTORE_DATABASE_ID: 'spellbook', IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test', ANTHROPIC_API_KEY: 'sk-ant-test',
  PASSKEY_RP_ID: 'strongtechnicalconsulting.com', ADMIN_EMAIL: 'boss@example.com',
  PORT: '9264',
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9264';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b || {}) });
const get = (p, c) => fetch(B + p, { headers: c ? { cookie: c } : {} });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

(async () => {
  await new Promise((r) => setTimeout(r, 1200));

  // Someone with a private prompt, so there is something to fail to see.
  const reg = await post('/api/auth/register', { email: 'owner@example.com', password: 'a-long-password-1', displayName: 'Owner' });
  const owner = jar(reg);
  const made = await post('/api/prompts', {
    title: 'A private note to self', body: 'Do not show this to anyone {{secret}}',
    platforms: ['claude'], category: 'other', visibility: 'private',
  }, owner);
  const privateId = (await made.json()).id;
  ok('the fixture private prompt was created', made.status === 200 && !!privateId, String(made.status));

  // --- reading, with no cookie at all --------------------------------------
  let r = await get('/api/prompts');
  const list = await r.json();
  ok('the library reads without an account', r.status === 200, String(r.status));
  ok('...and it is not empty', (list.total || 0) > 0, String(list.total));
  ok('...and it says the reader is signed out', list.signedIn === false);
  ok('...and no private prompt is in it',
    !list.prompts.some((p) => p.visibility === 'private' || p.id === privateId));
  ok('...and no per-user state is invented', list.prompts.every((p) => p.myVote === 0 && p.saved === false));

  const publicId = list.prompts[0].id;
  r = await get('/api/prompts/' + publicId);
  ok('a public prompt opens without an account', r.status === 200, String(r.status));
  const one = await r.json();
  ok('...and is not marked as the guest’s own', one.isMine === false);

  r = await get('/api/prompts/' + privateId);
  ok('someone else’s private prompt 404s, it does not 403', r.status === 404, String(r.status));

  // --- writing, with no cookie ---------------------------------------------
  const refused = [
    ['vote', await post('/api/prompts/' + publicId + '/vote', { value: 1 })],
    ['save', await post('/api/prompts/' + publicId + '/save', { saved: true })],
    ['copy count', await post('/api/prompts/' + publicId + '/copied', {})],
    ['publish', await post('/api/prompts', { title: 'x', body: 'yyyyyyyyyyyy', platforms: ['claude'] })],
    ['my prompts', await get('/api/my/prompts')],
    ['AI draft', await post('/api/ai/draft', { idea: 'anything' })],
    ['AI improve', await post('/api/prompts/' + publicId + '/improve', {})],
  ];
  refused.forEach(([name, res]) => ok(name + ' still needs an account', res.status === 401, String(res.status)));

  r = await fetch(B + '/api/prompts/' + publicId, { method: 'DELETE' });
  ok('delete still needs an account', r.status === 401, String(r.status));

  // --- and the owner is unaffected -----------------------------------------
  r = await get('/api/prompts/' + privateId, owner);
  ok('the owner still sees their own private prompt', r.status === 200, String(r.status));
  r = await get('/api/prompts', owner);
  ok('a signed-in reader is told so', (await r.json()).signedIn === true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
