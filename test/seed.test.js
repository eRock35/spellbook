// The starter library: is it actually there, is it usable, and is it written
// exactly once?
//
// "Once" is the part worth testing. A seed that re-runs would resurrect a
// prompt someone deleted on purpose, and two instances booting together would
// double the shelf - both are the kind of bug that shows up as a confusing
// library rather than as an error anyone would notice.
const h = require('./harness.js');
h.install();
const assert = require('assert');
const seed = require('../seed');
const pf = require('../promptfields');

let ran = 0;
function test(name, fn) { fn(); ran += 1; process.stdout.write('  ok  ' + name + '\n'); }
async function atest(name, fn) { await fn(); ran += 1; process.stdout.write('  ok  ' + name + '\n'); }

test('every seeded prompt passes the validator real authors go through', () => {
  seed.PROMPTS.forEach((p) => {
    const r = pf.bodyToPromptFields(
      { title: p.title, body: p.body, summary: p.summary, platforms: p.platforms,
        category: p.category, tags: p.tags },
      { uid: 'u', displayName: 'Spellbook' },
    );
    assert.ok(!r.error, `${p.title}: ${r.error}`);
    // A category or platform silently falling back to "other" would make the
    // filters useless on exactly the prompts a first visitor sees.
    assert.strictEqual(r.fields.category, p.category, p.title + ' category drifted');
    assert.strictEqual(r.fields.platforms.length, p.platforms.length, p.title + ' lost a platform');
    assert.strictEqual(r.fields.tags.length, p.tags.length, p.title + ' lost a tag');
  });
});

test('every {{placeholder}} in a seed is a blank the form will render', () => {
  // This is the feature the seed exists to demonstrate. A placeholder the
  // extractor does not match is invisible to the fill-in form and the reader
  // has to hand-edit the body - which is the thing a prompt library is for.
  seed.PROMPTS.forEach((p) => {
    const written = [...p.body.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1].trim());
    const found = pf.extractVariables(p.body);
    written.forEach((w) => assert.ok(found.includes(w),
      `${p.title}: {{${w}}} is written but never becomes a field`));
    assert.ok(written.length > 0, p.title + ' has no blanks at all');
  });
});

test('no seed claims engagement nobody gave it', () => {
  // Fabricated upvotes on the starter shelf would be a lie on the one surface
  // this app asks people to trust.
  seed.seedDocuments('u').forEach((d) => {
    assert.strictEqual(d.score, 0, d.title);
    assert.strictEqual(d.upvotes, 0, d.title);
    assert.strictEqual(d.copyCount, 0, d.title);
  });
});

test('the shelf is ordered, not simultaneous', () => {
  const docs = seed.seedDocuments('u', Date.parse('2026-09-22T12:00:00Z'));
  const times = docs.map((d) => d.createdAt);
  assert.deepStrictEqual(times, [...times].sort(), 'seeds must be strictly ordered');
  assert.strictEqual(new Set(times).size, times.length, 'identical timestamps reshuffle the page');
  // And all in the past: a future createdAt would make the decay negative.
  docs.forEach((d) => assert.ok(Date.parse(d.createdAt) < Date.parse('2026-09-22T12:00:00Z')));
});

test('the shelf covers more than one kind of work', () => {
  const cats = new Set(seed.PROMPTS.map((p) => p.category));
  assert.ok(cats.size >= 4, 'a library of one category teaches the wrong thing: ' + [...cats]);
  const plats = new Set(seed.PROMPTS.flatMap((p) => p.platforms));
  assert.ok(plats.size >= 3, 'seeds should not all be for one tool: ' + [...plats]);
});

(async () => {
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({ databaseId: 'seed-test' });

  await atest('a fresh database gets the whole shelf', async () => {
    const r = await seed.ensureSeeded(db, { authorId: 'admin-uid' });
    assert.strictEqual(r.seeded, true);
    assert.strictEqual(r.count, seed.PROMPTS.length);
    const snap = await db.collection('prompts').get();
    assert.strictEqual(snap.size, seed.PROMPTS.length);
    assert.ok(snap.docs.every((d) => d.data().visibility === 'public'));
    assert.ok(snap.docs.every((d) => d.data().authorId === 'admin-uid'),
      'the admin owns them, so a typo can be fixed from inside the app');
    assert.ok(snap.docs.every((d) => d.data().authorName === seed.SEED_AUTHOR_NAME),
      'the byline is Spellbook, because Spellbook wrote them');
  });

  await atest('booting again does not stock it twice', async () => {
    const r = await seed.ensureSeeded(db, { authorId: 'admin-uid' });
    assert.strictEqual(r.seeded, false);
    assert.strictEqual(r.reason, 'already-seeded');
    assert.strictEqual((await db.collection('prompts').get()).size, seed.PROMPTS.length);
  });

  await atest('a deleted seed stays deleted across a restart', async () => {
    // The real thing this protects: someone removes a starter prompt they do
    // not want, the service cold-starts, and it comes back.
    const first = (await db.collection('prompts').get()).docs[0];
    await db.collection('prompts').doc(first.id).delete();
    await seed.ensureSeeded(db, { authorId: 'admin-uid' });
    assert.strictEqual((await db.collection('prompts').get()).size, seed.PROMPTS.length - 1);
  });

  await atest('two instances booting together seed once between them', async () => {
    const fresh = new Firestore({ databaseId: 'seed-race' });
    const [a, b] = await Promise.all([
      seed.ensureSeeded(fresh, { authorId: 'admin-uid' }),
      seed.ensureSeeded(fresh, { authorId: 'admin-uid' }),
    ]);
    assert.strictEqual([a.seeded, b.seeded].filter(Boolean).length, 1, 'exactly one should win');
    assert.strictEqual((await fresh.collection('prompts').get()).size, seed.PROMPTS.length);
  });

  await atest('with no admin configured the shelf is read-only, not unowned', async () => {
    const fresh = new Firestore({ databaseId: 'seed-noadmin' });
    await seed.ensureSeeded(fresh);
    const snap = await fresh.collection('prompts').get();
    assert.ok(snap.docs.every((d) => d.data().authorId === seed.RESERVED_AUTHOR_ID));
    // A reserved id can never equal a real uid, which is base64url of an
    // email - so mustOwn never matches and nobody can edit them by accident.
    assert.ok(!/^[A-Za-z0-9_-]+$/.test(seed.RESERVED_AUTHOR_ID)
      || Buffer.from(seed.RESERVED_AUTHOR_ID, 'base64url').toString().indexOf('@') === -1,
      'the reserved id must not decode to an email address');
  });

  console.log(`\n${ran} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
