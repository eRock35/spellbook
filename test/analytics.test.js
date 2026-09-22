// Run with: node test/analytics.test.js
'use strict';
const assert = require('assert');
const { APPS, trendScore } = require('../analytics');

let ran = 0;
function test(name, fn) { fn(); ran += 1; process.stdout.write('  ok  ' + name + '\n'); }

test('the vacation app is NOT in the tracked allowlist', () => {
  // This is a standing decision, not an oversight: santa-rosa-beach-trip is
  // private, holds family PII, and both its CLAUDE.md and DEPLOY.md say its
  // hostname stays off public surfaces. /api/stats/public is a public surface
  // and this file is in a public repo. If someone "helpfully" adds it, this
  // test is the thing that says no.
  const names = Object.keys(APPS).join(' ');
  assert.ok(!/santa|rosa|vacation|beach/i.test(names), 'vacation app must not be tracked');
  assert.ok(!/santa|rosa|vacation|beach/i.test(JSON.stringify(APPS)), 'and must not appear in any label or URL');
});

test('every tracked app has a label, an https URL and an icon', () => {
  Object.keys(APPS).forEach((k) => {
    assert.ok(APPS[k].label, k + ' needs a label');
    assert.ok(/^https:\/\//.test(APPS[k].url), k + ' needs an https url');
    assert.ok(APPS[k].icon, k + ' needs an icon');
  });
});

test('trendScore decays with age and rises with weight', () => {
  assert.ok(trendScore(10, 1) > trendScore(10, 100));
  assert.ok(trendScore(20, 5) > trendScore(10, 5));
  assert.ok(Number.isFinite(trendScore(0, 0)));
  // A negative age (a clock skew between instances) must not produce Infinity.
  assert.ok(Number.isFinite(trendScore(5, -10)));
});

console.log(`\n${ran} assertions passed.`);
