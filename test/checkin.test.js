'use strict';
// What a page that was loaded out of sight, read and closed again really said
// (accounts that can only be checked while their page is open).
const test = require('node:test');
const assert = require('node:assert');
const { settleCheckIn, CHECKIN_ZERO_HOLD_MS } = require('../src/parsers');

test('settleCheckIn: the real defaults, for reference', () => {
  assert.equal(CHECKIN_ZERO_HOLD_MS, 8000);
});

test('settleCheckIn: a rise is new mail, measured from the count before', () => {
  assert.deepEqual(settleCheckIn(3957, 3960), { count: 3960, fresh: 3 });
  assert.deepEqual(settleCheckIn(0, 12), { count: 12, fresh: 12 });
  assert.deepEqual(settleCheckIn(3957, 3957), { count: 3957, fresh: 0 });
});

test('settleCheckIn: the first count ever read is a baseline, never new mail', () => {
  assert.deepEqual(settleCheckIn(0, 3957, { known: false }), { count: 3957, fresh: 0 });
  assert.deepEqual(settleCheckIn(0, 0, { known: false }), { count: 0, fresh: 0 });
});

test('settleCheckIn: a drop to a number above zero is real (mail read elsewhere)', () => {
  assert.deepEqual(settleCheckIn(3957, 3900), { count: 3900, fresh: 0 });
  assert.deepEqual(settleCheckIn(3957, 1), { count: 1, fresh: 0 });
});

test('settleCheckIn: a zero seen too early is a page still starting up, not an empty Inbox', () => {
  // Proton Mail shows "Inbox | …" (no number) before "(3957) Inbox | …".
  assert.deepEqual(settleCheckIn(3957, 0), { count: 3957, fresh: 0 });
  assert.deepEqual(settleCheckIn(3957, 0, { heldMs: CHECKIN_ZERO_HOLD_MS - 1 }), { count: 3957, fresh: 0 });
});

test('settleCheckIn: …and so a slow page never turns its own start-up into new mail', () => {
  // Check 1 reads zero too early and keeps 3957. Check 2 reads the real count: unchanged, nothing new.
  const first = settleCheckIn(3957, 0);
  assert.deepEqual(settleCheckIn(first.count, 3957), { count: 3957, fresh: 0 });
});

test('settleCheckIn: a zero that held is real, and mail after it counts from zero', () => {
  assert.deepEqual(settleCheckIn(3957, 0, { heldMs: CHECKIN_ZERO_HOLD_MS }), { count: 0, fresh: 0 });
  assert.deepEqual(settleCheckIn(0, 0), { count: 0, fresh: 0 });
  assert.deepEqual(settleCheckIn(0, 2), { count: 2, fresh: 2 });
});

test('settleCheckIn: how long a zero has to hold can be shortened, for tests', () => {
  assert.deepEqual(settleCheckIn(3957, 0, { heldMs: 1400, holdMs: 1500 }), { count: 3957, fresh: 0 });
  assert.deepEqual(settleCheckIn(3957, 0, { heldMs: 1500, holdMs: 1500 }), { count: 0, fresh: 0 });
});
