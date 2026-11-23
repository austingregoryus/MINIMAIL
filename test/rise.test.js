'use strict';
// The new-mail detector for accounts whose only signal is the page title.
// Short thresholds are passed in so time can be simulated exactly.
const test = require('node:test');
const assert = require('node:assert');
const { createRiseTracker, riseStep, RISE_SETTLE_MS, RISE_HOLD_MS } = require('../src/parsers');
const run = (steps) => {
  const state = createRiseTracker(1000, 500); // settle after 1 s, a drop counts after 0.5 s
  return steps.map(([count, now]) => riseStep(state, count, now));
};

test('riseStep: the first count after a load is a baseline, never new mail', () => {
  assert.equal(RISE_SETTLE_MS, 15000); // the real defaults, for reference
  assert.equal(RISE_HOLD_MS, 10000);
  assert.deepEqual(run([[216447, 0]]), [0]);
  assert.deepEqual(run([[0, 0], [0, 3000]]), [0, 0]);
});

test('riseStep: a rise once the page has settled is new mail', () => {
  assert.deepEqual(run([[5, 0], [8, 2000], [9, 2500]]), [0, 3, 1]);
});

test('riseStep: rises while the page is still filling in are not new mail', () => {
  assert.deepEqual(run([[0, 0], [3, 300], [5, 700], [9, 1500]]), [0, 0, 0, 4]); // the baseline moves along with them
});

test('riseStep: reading mail lowers the count; mail after that is measured from the new level', () => {
  assert.deepEqual(run([[5, 0], [2, 3000], [4, 5000]]), [0, 0, 2]);
  assert.deepEqual(run([[5, 0], [0, 3000], [1, 9000]]), [0, 0, 1]);
});

test('riseStep: a dip that bounces back is a reconnect, not new mail', () => {
  assert.deepEqual(run([[5, 0], [0, 3000], [5, 3100], [6, 4000]]), [0, 0, 0, 1]);
  // The low count repeats inside the hold (measured from when the dip started), then recovers.
  assert.deepEqual(run([[5, 0], [0, 3000], [0, 3100], [5, 3200]]), [0, 0, 0, 0]);
});

test('riseStep: …but a dip that lasts the whole hold is taken as real', () => {
  // After 500 ms at zero the page has had time to say so: a later 5 is reported as new.
  assert.deepEqual(run([[5, 0], [0, 3000], [0, 3600], [5, 3700]]), [0, 0, 0, 5]);
  assert.deepEqual(run([[5, 0], [0, 3000], [5, 3600]]), [0, 0, 5]);
});

test('riseStep: mail that arrives during a dip is counted against the level before it', () => {
  assert.deepEqual(run([[5, 0], [0, 3000], [7, 3100]]), [0, 0, 2]);
  // 5 → 0 → 3 settles at 3: neither the fall nor the partial recovery is an arrival.
  assert.deepEqual(run([[5, 0], [0, 3000], [3, 3100], [3, 9000], [5, 9500]]), [0, 0, 0, 0, 2]);
});
