// Run with: node test/authorstats.test.js
//
// The pure half of author stats and link-preview cards (2026-09-26): the sums
// an author is shown, the rank that must stay hidden until there is a crowd,
// the badges, the one-time copy milestones, the handle that must not be an
// email, and the card SVG that user text is drawn into.
'use strict';
const assert = require('assert');
const st = require('../authorstats');
const pf = require('../promptfields');
const cards = require('../cards');

let ran = 0;
function test(name, fn) { fn(); ran += 1; process.stdout.write('  ok  ' + name + '\n'); }

const P = (o) => Object.assign({ visibility: 'public', copyCount: 0, saveCount: 0, remixCount: 0, score: 0 }, o);

// --- sums ------------------------------------------------------------------
test('totals add up public prompts and ignore private ones', () => {
  const t = st.totals([
    P({ copyCount: 1000, saveCount: 300, remixCount: 20, score: 12, viewCount: 5 }),
    P({ copyCount: 240, saveCount: 10, remixCount: 2, score: -2 }),
    P({ visibility: 'private', copyCount: 999, saveCount: 999, remixCount: 999, score: 999 }),
  ]);
  assert.deepStrictEqual(t, { prompts: 2, copies: 1240, saves: 310, remixes: 22, votes: 10, views: 5 });
});

test('junk counters count as nothing rather than NaN', () => {
  const t = st.totals([P({ copyCount: 'abc', saveCount: -4, remixCount: null, score: undefined })]);
  assert.deepStrictEqual(t, { prompts: 1, copies: 0, saves: 0, remixes: 0, votes: 0, views: 0 });
});

test('best prompt is the most copied, then saved, then scored - never a private one', () => {
  const a = P({ id: 'a', copyCount: 50, saveCount: 1 });
  const b = P({ id: 'b', copyCount: 50, saveCount: 9 });
  const hidden = P({ id: 'h', visibility: 'private', copyCount: 5000 });
  assert.strictEqual(st.bestPrompt([a, hidden, b]).id, 'b');
  assert.strictEqual(st.bestPrompt([hidden]), null);
});

// --- percentile --------------------------------------------------------------
function tableOf(nOthers, copiesFn) {
  const m = new Map();
  for (let i = 0; i < nOthers; i++) m.set('u' + i, copiesFn(i));
  return m;
}

test('no rank with fewer than 20 authors', () => {
  const t = tableOf(18, () => 0); // 18 others + me = 19
  assert.strictEqual(st.percentile(t, 'me', 500), null);
  const t2 = tableOf(19, () => 0); // 20
  assert.deepStrictEqual(st.percentile(t2, 'me', 500), { rank: 1, authors: 20, topPercent: 5, label: 'Top 5% author' });
});

test('rank buckets are coarse and stop at the top half', () => {
  // 100 authors: others have copies 0..98, I have 95 -> 3 above me -> rank 4 -> 4% -> Top 5%.
  const t = tableOf(99, (i) => i);
  assert.strictEqual(st.percentile(t, 'me', 95).topPercent, 5);
  assert.strictEqual(st.percentile(t, 'me', 99).label, 'Top 1% author');
  assert.strictEqual(st.percentile(t, 'me', 60).topPercent, 50); // 38 above -> 39%
  assert.strictEqual(st.percentile(t, 'me', 20), null);           // 78 above: bottom half, say nothing
});

test('no copies, no rank; my own table entry is replaced by my full total', () => {
  const t = tableOf(30, () => 5);
  t.set('me', 1); // the window undercounted me
  assert.strictEqual(st.percentile(t, 'me', 0), null);
  assert.strictEqual(st.percentile(t, 'me', 6).rank, 1);
});

test('authorTable sums copies per author over public prompts only', () => {
  const m = st.authorTable([
    P({ authorId: 'a', copyCount: 3 }), P({ authorId: 'a', copyCount: 4 }),
    P({ authorId: 'b', copyCount: 9, visibility: 'private' }), P({ copyCount: 2 }),
  ]);
  assert.deepStrictEqual([...m], [['a', 7]]);
});

// --- badges ------------------------------------------------------------------
test('every badge is listed, locked ones with a hint and progress', () => {
  const t = st.totals([P({ copyCount: 120, saveCount: 3, remixCount: 10 })]);
  const b = st.badges(t, []);
  assert.strictEqual(b.length, st.BADGES.length);
  const by = Object.fromEntries(b.map((x) => [x.id, x]));
  assert.ok(by['first-prompt'].earned && by['first-copy'].earned && by['copies-100'].earned && by['remixed-10'].earned);
  assert.ok(!by['copies-1000'].earned && !by['five-prompts'].earned && !by['saved-50'].earned && !by['trending-1'].earned);
  assert.deepStrictEqual(by['copies-1000'].progress, { have: 120, need: 1000 });
  assert.ok(b.every((x) => x.hint && x.name));
});

test('trending #1 comes from a stamped PUBLIC prompt only', () => {
  const t = st.totals([]);
  assert.ok(!st.badges(t, [P({ visibility: 'private', trendingTopAt: '2026-09-01' })]).find((b) => b.id === 'trending-1').earned);
  assert.ok(st.badges(t, [P({ trendingTopAt: '2026-09-01' })]).find((b) => b.id === 'trending-1').earned);
});

test('five published counts public prompts', () => {
  const five = [1, 2, 3, 4].map(() => P({})).concat([P({ visibility: 'private' })]);
  assert.ok(!st.badges(st.totals(five), five).find((b) => b.id === 'five-prompts').earned);
  five.push(P({}));
  assert.ok(st.badges(st.totals(five), five).find((b) => b.id === 'five-prompts').earned);
});

// --- milestones --------------------------------------------------------------
test('milestones: highest reached, once, public only', () => {
  assert.strictEqual(st.milestoneFor(9), 0);
  assert.strictEqual(st.milestoneFor(10), 10);
  assert.strictEqual(st.milestoneFor(999), 100);
  assert.strictEqual(st.milestoneFor(1000), 1000);
  const pend = st.pendingMilestones([
    P({ id: 'a', title: 'A', copyCount: 150 }),                         // jumped 8 -> 150: says 100, not 10
    P({ id: 'b', title: 'B', copyCount: 150, celebratedCopies: 100 }),  // already shown
    P({ id: 'c', title: 'C', copyCount: 1001, celebratedCopies: 100 }), // crossed 1,000 since
    P({ id: 'd', title: 'D', copyCount: 12, visibility: 'private' }),   // self-copies, no party
  ]);
  assert.deepStrictEqual(pend, [{ id: 'c', title: 'C', milestone: 1000 }, { id: 'a', title: 'A', milestone: 100 }]);
});

// --- identity ------------------------------------------------------------------
test('the author key is opaque, stable, and not the uid', () => {
  const uid = Buffer.from('erik@example.com').toString('base64url');
  const k = st.authorKey(uid, 'secret-1');
  assert.match(k, st.AUTHOR_KEY_RE);
  assert.strictEqual(k, st.authorKey(uid, 'secret-1'));
  assert.notStrictEqual(k, st.authorKey(uid, 'secret-2'));
  assert.ok(!Buffer.from(k, 'base64url').toString('latin1').includes('example'));
  assert.ok(!k.includes(uid.slice(0, 8)));
  assert.strictEqual(st.authorKey('', 's'), null);
});

test('a byline is never an email address', () => {
  assert.strictEqual(pf.publicByline('erik@example.com'), 'erik');
  assert.strictEqual(pf.publicByline('  Ada ‮Lovelace\u0007 '), 'Ada Lovelace');
  assert.strictEqual(pf.publicByline(''), 'anonymous');
  assert.strictEqual(pf.publicByline('@example.com'), 'anonymous');
  const f = pf.bodyToPromptFields({ title: 't', body: 'long enough body', platforms: ['claude'] },
    { uid: 'u', email: 'shy@example.com' });
  assert.strictEqual(f.fields.authorName, 'shy');
});

// --- cards ---------------------------------------------------------------------
test('card text is escaped: markup and quotes in a title cannot become SVG', () => {
  const svg = cards.promptSvg({
    title: '</text><script>alert(1)</script><image href="x" onerror="y"/> "quoted" & \'single\'',
    body: 'Body with <b>tags</b> and {{a "blank"}} & {{name}}',
    platforms: ['claude', 'not-a-platform'], copyCount: 3, by: '<img src=x>',
  });
  assert.ok(!/<script|<image|<img|<b>|onerror="/.test(svg), svg);
  assert.ok(svg.includes('&lt;/text&gt;&lt;script&gt;'));
  const short = cards.promptSvg({ title: '"quoted" & \'single\'', body: 'x', platforms: [], copyCount: 0 });
  assert.ok(short.includes('&quot;quoted&quot; &amp; &#39;single&#39;'), short);
  assert.ok(!svg.includes('not-a-platform'));
});

test('card text drops what the font cannot draw and control characters', () => {
  assert.strictEqual(cards.latin('Launch \u{1F680} plan\u0000\u0007 café č — ok'), 'Launch plan café c — ok');
  assert.strictEqual(cards.latin('\u{1F600}\u{1F600}'), '');
  const svg = cards.promptSvg({ title: '\u{1F600}', body: '', platforms: [], copyCount: 0 });
  assert.ok(svg.includes('A prompt on Spellbook'));
});

test('long text wraps within bounds and is cut with an ellipsis', () => {
  const lines = cards.wrap('word '.repeat(200).trim(), 54, 1080, 900, 2);
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
  lines.forEach((l) => assert.ok(cards.measure(l, 54, 900) <= 1080));
  const one = cards.wrap('W'.repeat(300), 54, 1080, 900, 2);
  assert.ok(one.length === 1 && cards.measure(one[0], 54, 900) <= 1080);
});

test('the card renders to a PNG of the right size', () => {
  const buf = cards.png(cards.promptSvg({ title: 'T', body: 'b {{x}}', platforms: ['claude'], copyCount: 1, by: 'A' }));
  assert.ok(buf, 'resvg is installed');
  assert.deepStrictEqual([...buf.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.strictEqual(buf.readUInt32BE(16), 1200);
  assert.strictEqual(buf.readUInt32BE(20), 630);
});

console.log(`\n${ran} assertions passed.`);
