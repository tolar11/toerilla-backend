// test/pricing-and-matching.test.js
//
// Dependency-light tests for the pure business logic in lib/matching.js
// (pricing rules + matching filters). These stub out db/index.js's `query`
// function so this file runs with ZERO npm packages installed — no need
// for `pg`, `express`, etc. Run with: node --test test/
//
// This does NOT replace integration testing against a real Postgres
// instance (see README "Testing" section) — it exists so the core pricing
// math and matching filters, which are the parts PROJECT_BRIEF says "must
// match exactly", can be verified quickly and in CI without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

// --- Stub out db/index.js before lib/matching.js (or anything else) requires it ---
const dbPath = require.resolve(path.join(__dirname, '..', 'db', 'index.js'));
let fakeFirstFilledAt = null; // controls the "30-day window" check

const dbStub = {
  query: async (sql, params) => {
    if (sql.includes('FROM gigs') && sql.includes('ORDER BY filled_at ASC')) {
      return { rows: fakeFirstFilledAt ? [{ filled_at: fakeFirstFilledAt }] : [] };
    }
    if (sql.includes('FROM musicians WHERE available')) {
      return { rows: fakeMusicians };
    }
    throw new Error('Unexpected query in stub: ' + sql);
  },
  getClient: async () => {
    throw new Error('getClient not stubbed — not needed for these tests');
  },
};

const stubModule = new Module(dbPath, null);
stubModule.exports = dbStub;
stubModule.loaded = true;
require.cache[dbPath] = stubModule;

const { calculatePricing, findMatchingMusicians } = require('../lib/matching');

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Pricing rules
// ---------------------------------------------------------------------------

test('growth subscription: always $0', async () => {
  const venue = { id: 1, subscription_tier: 'growth', free_fill_credits: 0, gigs_completed: 5 };
  const result = await calculatePricing(venue, { budget: 300 });
  assert.equal(result.amountDueCents, 0);
  assert.equal(result.reason, 'covered by subscription');
});

test('auto_book_premium subscription: always $0', async () => {
  const venue = { id: 1, subscription_tier: 'auto_book_premium', free_fill_credits: 0, gigs_completed: 9 };
  const result = await calculatePricing(venue, { budget: 500 });
  assert.equal(result.amountDueCents, 0);
});

test('free-fill referral credit overrides normal pricing', async () => {
  const venue = { id: 1, subscription_tier: 'pay_per_fill', free_fill_credits: 1, gigs_completed: 4 };
  const result = await calculatePricing(venue, { budget: 400 });
  assert.equal(result.amountDueCents, 0);
  assert.equal(result.usedFreeFillCredit, true);
});

test('first gig (gigs_completed=0): free', async () => {
  const venue = { id: 1, subscription_tier: 'pay_per_fill', free_fill_credits: 0, gigs_completed: 0 };
  const result = await calculatePricing(venue, { budget: 300 });
  assert.equal(result.amountDueCents, 0);
  assert.equal(result.reason, 'first gig free');
});

test('second gig within 30 days: 50% of 15% commission', async () => {
  fakeFirstFilledAt = daysAgo(10);
  const venue = { id: 1, subscription_tier: 'pay_per_fill', free_fill_credits: 0, gigs_completed: 1 };
  const result = await calculatePricing(venue, { budget: 400 }); // 15% of $400 = $60 -> 50% off = $30
  assert.equal(result.amountDueCents, 3000);
  assert.match(result.reason, /50% off/);
});

test('second gig AFTER 30 days: standard 15%, no discount', async () => {
  fakeFirstFilledAt = daysAgo(45);
  const venue = { id: 1, subscription_tier: 'pay_per_fill', free_fill_credits: 0, gigs_completed: 1 };
  const result = await calculatePricing(venue, { budget: 400 }); // 15% of $400 = $60, full price
  assert.equal(result.amountDueCents, 6000);
  assert.match(result.reason, /30-day discount window has passed/);
});

test('third gig onward: standard 15% commission', async () => {
  fakeFirstFilledAt = null;
  const venue = { id: 1, subscription_tier: 'pay_per_fill', free_fill_credits: 0, gigs_completed: 2 };
  const result = await calculatePricing(venue, { budget: 1000 }); // 15% of $1000 = $150
  assert.equal(result.amountDueCents, 15000);
  assert.equal(result.reason, 'standard 15% commission');
});

// ---------------------------------------------------------------------------
// Matching filters
// ---------------------------------------------------------------------------

let fakeMusicians = [];

test('genre must overlap, regardless of reach', async () => {
  fakeMusicians = [
    { id: 1, genres: 'jazz,blues', reach: 'nationwide', city: 'Austin', state: 'TX', rate_min: 200 },
    { id: 2, genres: 'metal', reach: 'nationwide', city: 'Austin', state: 'TX', rate_min: 200 },
  ];
  const venue = { city: 'Austin', state: 'TX' };
  const matches = await findMatchingMusicians({ genre_needed: 'jazz', budget: 200 }, venue);
  assert.deepEqual(matches.map((m) => m.id), [1]);
});

test('regional musician matches same state, not other states', async () => {
  fakeMusicians = [
    { id: 1, genres: 'acoustic', reach: 'regional', city: 'Dallas', state: 'TX', rate_min: 200 },
    { id: 2, genres: 'acoustic', reach: 'regional', city: 'Miami', state: 'FL', rate_min: 200 },
  ];
  const venue = { city: 'Austin', state: 'TX' };
  const matches = await findMatchingMusicians({ genre_needed: 'acoustic', budget: 200 }, venue);
  assert.deepEqual(matches.map((m) => m.id), [1]);
});

test('local musician must match city AND state', async () => {
  fakeMusicians = [
    { id: 1, genres: 'covers', reach: 'local', city: 'Austin', state: 'TX', rate_min: 200 },
    { id: 2, genres: 'covers', reach: 'local', city: 'Dallas', state: 'TX', rate_min: 200 },
  ];
  const venue = { city: 'Austin', state: 'TX' };
  const matches = await findMatchingMusicians({ genre_needed: 'covers', budget: 200 }, venue);
  assert.deepEqual(matches.map((m) => m.id), [1]);
});

test('nationwide musician matches regardless of venue location', async () => {
  fakeMusicians = [{ id: 1, genres: 'covers', reach: 'nationwide', city: 'Seattle', state: 'WA', rate_min: 200 }];
  const venue = { city: 'Austin', state: 'TX' };
  const matches = await findMatchingMusicians({ genre_needed: 'covers', budget: 200 }, venue);
  assert.deepEqual(matches.map((m) => m.id), [1]);
});

test('sorted by closeness of rate_min to gig budget', async () => {
  fakeMusicians = [
    { id: 1, genres: 'jazz', reach: 'nationwide', city: 'X', state: 'X', rate_min: 100 },
    { id: 2, genres: 'jazz', reach: 'nationwide', city: 'X', state: 'X', rate_min: 290 },
    { id: 3, genres: 'jazz', reach: 'nationwide', city: 'X', state: 'X', rate_min: 500 },
  ];
  const venue = { city: 'X', state: 'X' };
  const matches = await findMatchingMusicians({ genre_needed: 'jazz', budget: 300 }, venue);
  assert.deepEqual(matches.map((m) => m.id), [2, 1, 3]); // 290 closest to 300, then 100, then 500
});
