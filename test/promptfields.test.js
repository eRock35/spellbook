// Run with: node test/promptfields.test.js
//
// Covers the rules a bad change would break silently: the placeholder regex
// (the feature the library is built around), the trending decay (the front page
// turning over), and the validation that stops a client setting its own score.
'use strict';
const assert = require('assert');
const pf = require('../promptfields');

let ran = 0;
function test(name, fn) { fn(); ran += 1; process.stdout.write('  ok  ' + name + '\n'); }

// --- placeholders ---------------------------------------------------------
test('finds placeholders, de-duplicates, keeps author order', () => {
  assert.deepStrictEqual(
    pf.extractVariables('Review {{language}} code in {{file}}; focus on {{language}}.'),
    ['language', 'file']);
});

test('tolerates inner whitespace and rejects junk', () => {
  assert.deepStrictEqual(pf.extractVariables('a {{  spaced name  }} b'), ['spaced name']);
  // Empty braces, nested braces and over-long names must not become variables.
  assert.deepStrictEqual(pf.extractVariables('{{}} {{{x}}} ' + '{{' + 'z'.repeat(41) + '}}'), ['x']);
});

test('no placeholders means no form', () => {
  assert.deepStrictEqual(pf.extractVariables('a plain prompt with { one } brace'), []);
});

test('caps the variable list so a pathological body cannot blow up the UI', () => {
  const body = Array.from({ length: 40 }, (_, i) => `{{v${i}}}`).join(' ');
  assert.strictEqual(pf.extractVariables(body).length, 20);
});

// --- validation -----------------------------------------------------------
const USER = { uid: 'u1', displayName: 'Erik', email: 'e@example.com' };
const OK = { title: 'T', body: 'a body long enough', platforms: ['claude'], category: 'coding' };

test('rejects a missing title, a stub body, and no platform', () => {
  assert.ok(pf.bodyToPromptFields({ ...OK, title: '  ' }, USER).error);
  assert.ok(pf.bodyToPromptFields({ ...OK, body: 'short' }, USER).error);
  assert.ok(pf.bodyToPromptFields({ ...OK, platforms: [] }, USER).error);
  assert.ok(pf.bodyToPromptFields({ ...OK, platforms: ['not-a-platform'] }, USER).error);
});

test('an unknown category falls back to other rather than failing the save', () => {
  assert.strictEqual(pf.bodyToPromptFields({ ...OK, category: 'nonsense' }, USER).fields.category, 'other');
});

test('a client cannot set its own counters, author or visibility typo', () => {
  const f = pf.bodyToPromptFields({
    ...OK, score: 9999, copyCount: 500, authorId: 'someone-else',
    visibility: 'PUBLIC-ish',
  }, USER).fields;
  assert.strictEqual(f.score, undefined);
  assert.strictEqual(f.copyCount, undefined);
  assert.strictEqual(f.authorId, 'u1');           // taken from the session, not the body
  assert.strictEqual(f.visibility, 'public');     // anything but 'private' is public
});

test('private is honoured exactly', () => {
  assert.strictEqual(pf.bodyToPromptFields({ ...OK, visibility: 'private' }, USER).fields.visibility, 'private');
});

test('variables are derived from the body, never accepted from the client', () => {
  const f = pf.bodyToPromptFields({ ...OK, body: 'do {{x}} now', variables: ['lies'] }, USER).fields;
  assert.deepStrictEqual(f.variables, ['x']);
});

test('tags are slugged, de-duplicated and capped', () => {
  assert.deepStrictEqual(
    pf.cleanTags(['Unit Tests', 'unit-tests', 'C++', '  ', 'x'.repeat(30)]),
    ['unit-tests', 'c++']);
  assert.ok(pf.cleanTags(Array.from({ length: 20 }, (_, i) => 't' + i)).length <= 8);
});

test('platforms de-duplicate and cap at six', () => {
  assert.deepStrictEqual(pf.pickList(['claude', 'CLAUDE', 'chatgpt'], pf.PLATFORMS, 6), ['claude', 'chatgpt']);
  assert.strictEqual(pf.pickList(pf.PLATFORMS, pf.PLATFORMS, 6).length, 6);
});

// --- trending -------------------------------------------------------------
const NOW = Date.parse('2026-09-22T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test('a copy outweighs an upvote, because it is evidence of real use', () => {
  const copied = pf.computeTrend({ createdAt: hoursAgo(5), copyCount: 10 }, NOW);
  const voted = pf.computeTrend({ createdAt: hoursAgo(5), score: 4 }, NOW);
  assert.ok(copied > voted, `${copied} should beat ${voted}`);
});

test('age decays: equal engagement, older loses', () => {
  const fresh = pf.computeTrend({ createdAt: hoursAgo(2), score: 5 }, NOW);
  const stale = pf.computeTrend({ createdAt: hoursAgo(200), score: 5 }, NOW);
  assert.ok(fresh > stale);
});

test('a brand-new prompt with no votes still outranks a week-old one with a few', () => {
  const brandNew = pf.computeTrend({ createdAt: hoursAgo(0), score: 0 }, NOW);
  const weekOld = pf.computeTrend({ createdAt: hoursAgo(168), score: 3 }, NOW);
  assert.ok(brandNew > weekOld, 'the front page has to turn over');
});

test('a downvoted prompt scores below an ignored one of the same age', () => {
  assert.ok(pf.computeTrend({ createdAt: hoursAgo(10), score: -3 }, NOW)
          < pf.computeTrend({ createdAt: hoursAgo(10), score: 0 }, NOW));
});

test('score stays finite and non-negative-infinity for odd input', () => {
  const v = pf.computeTrend({}, NOW);
  assert.ok(Number.isFinite(v) && v > 0);
});

console.log(`\n${ran} assertions passed.`);
