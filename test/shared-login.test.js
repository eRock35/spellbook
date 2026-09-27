// Does a shared-account session actually sign you in to Spellbook?
const h = require('./harness.js');
h.install();
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn',
  SESSION_SECRET: 'spellbook-secret-abcdefghij',
  FIRESTORE_DATABASE_ID: 'spellbook', IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test', ANTHROPIC_API_KEY: 'sk-ant-test',
  PASSKEY_RP_ID: 'strongtechnicalconsulting.com', ADMIN_EMAIL: 'boss@example.com',
  PORT: '9252',
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9252';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const get = (p, c) => fetch(B + p, { headers: c ? { cookie: c } : {} });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

(async () => {
  await new Promise((r) => setTimeout(r, 1000));

  let r = await get('/api/auth/me');
  ok('signed out reads as signed out', (await r.json()).signedIn === false);

  // Register on the SHARED account only. This person has never touched
  // Spellbook's own sign-up - which is the whole point of "same login".
  r = await post('/api/id/register', { email: 'shared@example.com', password: 'a-long-password-1' });
  ok('the shared account registers from inside Spellbook', r.status === 200, String(r.status));
  const cookie = jar(r);

  r = await get('/api/auth/me', cookie);
  const me = await r.json();
  ok('...and Spellbook reports them signed in', me.signedIn === true, JSON.stringify(me));
  ok('...under the uid both systems derive the same way',
      me.user && me.user.id === Buffer.from('shared@example.com').toString('base64url'),
      JSON.stringify(me.user && me.user.id));
  ok('...with their email', me.user && me.user.email === 'shared@example.com');

  // The library itself has to work, not just the greeting.
  r = await post('/api/prompts', { title: 'A prompt', body: 'Do the thing with {{x}}.', visibility: 'public', platforms: ['claude'], category: 'other' }, cookie);
  ok('they can publish a prompt on that session', r.status === 200, String(r.status));
  r = await get('/api/my/prompts', cookie);
  const mine = await r.json();
  ok('...and it comes back as theirs', (mine.mine || []).length === 1,
      JSON.stringify(mine).slice(0, 120));

  // AI is metered and needs the shared door specifically.
  r = await post('/api/ai/draft', { description: 'write me a thing that does stuff' }, cookie);
  ok('AI is reachable on a shared session', r.status !== 401, String(r.status));
  r = await post('/api/ai/draft', { description: 'write me a thing that does stuff' });
  ok('...and closed without one', r.status === 401, String(r.status));

  /* ---------- takeovers closed (2026-09-27) ---------- */
  // Spellbook's own sign-up is closed: registering an address there used to
  // take over whoever held it on the shared account, and ADMIN_EMAIL made
  // you admin.
  r = await post('/api/auth/register', { email: 'shared@example.com', password: 'attacker-password-1' });
  ok('the old own-door sign-up is closed', r.status === 410, String(r.status));
  r = await post('/api/auth/register', { email: 'boss@example.com', password: 'attacker-password-1' });
  ok('...including for the admin address', r.status === 410, String(r.status));

  // The owner registers first, so they hold the owner flag.
  r = await post('/api/id/register', { email: 'boss@example.com', password: 'the-real-owner-1' });
  const boss = jar(r);
  r = await get('/api/admin/users', boss);
  ok('the owner (shared-account admin) reaches the admin surface', r.status === 200, String(r.status));

  // A local isAdmin left on a Spellbook row no longer makes a shared session admin.
  const h2 = require('./harness.js');
  h2.bag('spellbook').set('users/' + Buffer.from('shared@example.com').toString('base64url'), { email: 'shared@example.com', isAdmin: true });
  r = await get('/api/admin/users', cookie);
  ok('a local isAdmin flag does not make a shared session admin', r.status === 404, String(r.status));
  r = await post('/api/cron/rollup', {}, cookie);
  ok('...nor open the admin-or-cron rollup', r.status === 403 || r.status === 401, String(r.status));
  r = await post('/api/cron/rollup', {}, boss);
  ok('the owner can still run it', r.status !== 403 && r.status !== 401, String(r.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
