/**
 * test/inventory.test.js
 *
 * The inventory state machine decides whether a competitor is dropped from tracking. Getting it
 * wrong in the permissive direction silently loses a live competitor and its price history, so the
 * asymmetry these tests pin down is the whole point: only an explicit 404/410 removes anything,
 * and every ambiguous signal keeps the property.
 *
 * Run: npm test
 */
'use strict';
const test   = require('node:test');
const assert = require('node:assert');

const {
  MISS_THRESHOLD, LIVE, GONE, MOVED, UNKNOWN,
  canonId, classifyProbe, delistCandidates, applyVerdict, reconcileTracked, purgeableIds,
} = require('../lib/inventory');

const NOW = '2026-08-11T12:00:00.000Z';

// ── classifyProbe: the only thing standing between a sold-out property and deletion ──────────
test('404 is the delisted signal', () => {
  assert.strictEqual(classifyProbe({ status: 404, bytes: 0, hasHotelJsonLd: false, location: '' }), GONE);
});

test('410 Gone is also delisted', () => {
  assert.strictEqual(classifyProbe({ status: 410, bytes: 0, hasHotelJsonLd: false, location: '' }), GONE);
});

test('a live page is LIVE even when the property is sold out for every night', () => {
  // This is the case that made naive delisting unsafe: Booking.com omits unavailable properties
  // from search, so a fully-booked listing looks identical to a deleted one — until you fetch it.
  assert.strictEqual(classifyProbe({ status: 200, bytes: 1250484, hasHotelJsonLd: true, location: '' }), LIVE);
});

test('a big 200 with no JSON-LD is still LIVE', () => {
  assert.strictEqual(classifyProbe({ status: 200, bytes: 900000, hasHotelJsonLd: false, location: '' }), LIVE);
});

test('a small 200 with no JSON-LD is UNKNOWN, not LIVE — that is a bot-check stub', () => {
  assert.strictEqual(classifyProbe({ status: 200, bytes: 4000, hasHotelJsonLd: false, location: '' }), UNKNOWN);
});

test('429 and 202 are UNKNOWN — throttling must never read as deleted', () => {
  assert.strictEqual(classifyProbe({ status: 429, bytes: 0, hasHotelJsonLd: false, location: '' }), UNKNOWN);
  assert.strictEqual(classifyProbe({ status: 202, bytes: 0, hasHotelJsonLd: false, location: '' }), UNKNOWN);
});

test('5xx is UNKNOWN', () => {
  assert.strictEqual(classifyProbe({ status: 503, bytes: 0, hasHotelJsonLd: false, location: '' }), UNKNOWN);
});

test('a network error (no status) is UNKNOWN', () => {
  assert.strictEqual(classifyProbe({ status: null, bytes: 0, hasHotelJsonLd: false, location: '' }), UNKNOWN);
  assert.strictEqual(classifyProbe(null), UNKNOWN);
  assert.strictEqual(classifyProbe(undefined), UNKNOWN);
});

test('a redirect with a Location is MOVED, not deleted', () => {
  assert.strictEqual(classifyProbe({ status: 301, bytes: 0, hasHotelJsonLd: false, location: '/hotel/in/new-slug.html' }), MOVED);
});

test('a redirect with no Location is UNKNOWN', () => {
  assert.strictEqual(classifyProbe({ status: 302, bytes: 0, hasHotelJsonLd: false, location: '' }), UNKNOWN);
});

// ── delistCandidates ─────────────────────────────────────────────────────────────────────────
test('only properties at or over the miss threshold are candidates', () => {
  const pool = [
    { id: 'a', missedScans: 0 },
    { id: 'b', missedScans: 2 },
    { id: 'c', missedScans: 3 },
    { id: 'd', missedScans: 9 },
  ];
  assert.deepStrictEqual(delistCandidates(pool, 3).map(p => p.id), ['c', 'd']);
});

test('already-delisted properties are not re-checked', () => {
  const pool = [{ id: 'a', missedScans: 5, status: 'delisted' }, { id: 'b', missedScans: 5, status: 'active' }];
  assert.deepStrictEqual(delistCandidates(pool, 3).map(p => p.id), ['b']);
});

test('a missing status counts as active', () => {
  assert.deepStrictEqual(delistCandidates([{ id: 'a', missedScans: 4 }], 3).map(p => p.id), ['a']);
});

test('the default threshold is more than one scan', () => {
  // One absence is meaningless here — the text-search stage alone swings the pool ~4x.
  assert.ok(MISS_THRESHOLD >= 2, 'a single missed scan must never be enough');
});

test('an empty or missing pool yields no candidates', () => {
  assert.deepStrictEqual(delistCandidates([], 3), []);
  assert.deepStrictEqual(delistCandidates(undefined, 3), []);
});

// ── applyVerdict ─────────────────────────────────────────────────────────────────────────────
test('GONE marks delisted and stamps the check', () => {
  const { action, patch } = applyVerdict({ id: 'a', missedScans: 3 }, GONE, NOW, { status: 404 });
  assert.strictEqual(action, 'delisted');
  assert.strictEqual(patch.status, 'delisted');
  assert.strictEqual(patch.delistedAt, NOW);
  assert.strictEqual(patch.delistCheck.status, 404);
});

test('LIVE clears the streak so a sold-out property stops re-triggering every scan', () => {
  const { action, patch } = applyVerdict({ id: 'a', missedScans: 7 }, LIVE, NOW, { status: 200 });
  assert.strictEqual(action, 'kept-live');
  assert.strictEqual(patch.missedScans, 0);
  assert.strictEqual(patch.status, 'active');
  assert.ok(!('delistedAt' in patch));
});

test('MOVED keeps the property and records where it went', () => {
  const { action, patch } = applyVerdict({ id: 'a', missedScans: 4 }, MOVED, NOW, { status: 301, location: '/hotel/in/x.html' });
  assert.strictEqual(action, 'moved');
  assert.strictEqual(patch.status, 'active');
  assert.strictEqual(patch.movedTo, '/hotel/in/x.html');
});

test('UNKNOWN never delists, and decays the streak so repeated throttling cannot accumulate', () => {
  const { action, patch } = applyVerdict({ id: 'a', missedScans: 3 }, UNKNOWN, NOW, { status: 429 });
  assert.strictEqual(action, 'deferred');
  assert.ok(!('status' in patch) || patch.status !== 'delisted');
  assert.strictEqual(patch.missedScans, 2, 'must drop below the threshold, not sit on it');
});

test('repeated UNKNOWN verdicts can never reach a delisting', () => {
  let entry = { id: 'a', missedScans: MISS_THRESHOLD };
  for (let i = 0; i < 25; i++) {
    const { action, patch } = applyVerdict(entry, UNKNOWN, NOW, { status: 429 });
    assert.notStrictEqual(action, 'delisted');
    entry = { ...entry, ...patch };
    // A real scan would re-increment, so simulate the worst case: straight back to the threshold.
    entry.missedScans = Math.max(entry.missedScans, MISS_THRESHOLD);
  }
  assert.notStrictEqual(entry.status, 'delisted');
});

test('the streak floor is zero, never negative', () => {
  const { patch } = applyVerdict({ id: 'a', missedScans: 0 }, UNKNOWN, NOW, { status: 429 });
  assert.strictEqual(patch.missedScans, 0);
});

// ── reconcileTracked ─────────────────────────────────────────────────────────────────────────
const ranked = ids => ids.map(id => ({ id, status: 'active' }));

test('a delisted competitor is dropped and backfilled from the ranked pool', () => {
  const r = reconcileTracked(ranked(['a', 'b', 'c', 'd']), ['a', 'b'], new Set(['b']), 2);
  assert.deepStrictEqual(r.keep, ['a']);
  assert.deepStrictEqual(r.drop, ['b']);
  assert.deepStrictEqual(r.add, ['c'], 'backfilled with the best available');
});

test('the tracked count does not grow past the target', () => {
  const r = reconcileTracked(ranked(['a', 'b', 'c', 'd', 'e']), ['a', 'b'], new Set(), 2);
  assert.deepStrictEqual(r.add, [], 'already at target');
  assert.strictEqual(r.available, 3, 'but reports what it left out');
});

test('raising the target links the next best candidates in rank order', () => {
  const r = reconcileTracked(ranked(['a', 'b', 'c', 'd', 'e']), ['a'], new Set(), 3);
  assert.deepStrictEqual(r.add, ['b', 'c']);
});

test('delisted properties are never re-added as backfill', () => {
  const r = reconcileTracked(ranked(['a', 'b', 'c']), ['a'], new Set(['b']), 3);
  assert.ok(!r.add.includes('b'));
  assert.deepStrictEqual(r.add, ['c']);
});

test('pool entries marked delisted in the pool itself are excluded', () => {
  const pool = [{ id: 'a', status: 'active' }, { id: 'b', status: 'delisted' }, { id: 'c', status: 'active' }];
  const r = reconcileTracked(pool, ['a'], new Set(), 3);
  assert.deepStrictEqual(r.add, ['c']);
});

test('a target of 0 unlinks nothing that is still live', () => {
  // Reconciliation only drops confirmed-delisted entries; it must not prune live ones just
  // because the target shrank, or a --target typo would silently wipe the tracked set.
  const r = reconcileTracked(ranked(['a', 'b']), ['a', 'b'], new Set(), 0);
  assert.deepStrictEqual(r.keep, ['a', 'b']);
  assert.deepStrictEqual(r.add, []);
  assert.deepStrictEqual(r.drop, []);
});

test('a linked competitor absent from the ranked pool is still kept', () => {
  // Ranking filters by distance, so a linked competitor can drop out of `results` without being
  // delisted. Losing it here would silently untrack a property the user chose.
  const r = reconcileTracked(ranked(['x', 'y']), ['a'], new Set(), 1);
  assert.deepStrictEqual(r.keep, ['a']);
  assert.deepStrictEqual(r.add, []);
});

test('an empty pool with nothing delisted is a no-op', () => {
  const r = reconcileTracked([], ['a', 'b'], new Set(), 5);
  assert.deepStrictEqual(r.keep, ['a', 'b']);
  assert.deepStrictEqual(r.add, []);
  assert.deepStrictEqual(r.drop, []);
});

// ── id form: the cache uses hyphens, config uses underscores ──────────────────────────────────
test('canonId converts the cache id form to the config id form', () => {
  assert.strictEqual(canonId('beautiful-studio-apartment'), 'beautiful_studio_apartment');
  assert.strictEqual(canonId('already_underscored'), 'already_underscored');
  assert.strictEqual(canonId(null), '');
});

test('an already-linked competitor is NOT re-added just because the pool spells its id with hyphens', () => {
  // The first real run of this reconciliation reported every linked competitor as a new arrival,
  // because `results[].id` is "antarim-resort" while config holds "antarim_resort". Left unfixed it
  // would have duplicated the entire tracked set.
  const pool = ranked(['antarim-resort', 'pilerne-goa', 'hilton-goa-resort']);
  const r = reconcileTracked(pool, ['antarim_resort', 'pilerne_goa'], new Set(), 3);
  assert.deepStrictEqual(r.keep, ['antarim_resort', 'pilerne_goa']);
  assert.deepStrictEqual(r.add, ['hilton_goa_resort'], 'only the genuinely new one, in config id form');
  assert.strictEqual(r.available, 1);
});

test('delisting matches across id forms', () => {
  const pool = ranked(['antarim-resort', 'pilerne-goa']);
  const r = reconcileTracked(pool, ['antarim_resort', 'pilerne_goa'], new Set(['antarim-resort']), 2);
  assert.deepStrictEqual(r.drop, ['antarim_resort'], 'a hyphenated delisted id must match the underscored link');
  assert.deepStrictEqual(r.keep, ['pilerne_goa']);
});

test('added ids are always emitted in config form', () => {
  const r = reconcileTracked(ranked(['a-b-c']), [], new Set(), 1);
  assert.deepStrictEqual(r.add, ['a_b_c']);
});

// ── purgeableIds: the only irreversible operation, so it gets the most paranoid tests ─────────
test('a delisted listing nobody links is purgeable, in canonical form', () => {
  const pools = [[{ id: 'dead-one', status: 'delisted' }, { id: 'live-one', status: 'active' }]];
  const props = [{ id: '1', type: 'own', competitors: [] }];
  assert.deepStrictEqual([...purgeableIds(pools, props)], ['dead_one']);
});

test('a delisted listing another property still links is NOT purgeable', () => {
  // The guard that matters. The hyphen/underscore mismatch made it never fire, which would have
  // deleted a listing a second property depended on.
  const pools = [[{ id: 'shared-listing', status: 'delisted' }]];
  const props = [
    { id: '1', type: 'own', competitors: [] },
    { id: '2', type: 'own', competitors: ['shared_listing'] },
  ];
  assert.deepStrictEqual([...purgeableIds(pools, props)], []);
});

test('active listings are never purgeable', () => {
  const pools = [[{ id: 'a', status: 'active' }, { id: 'b' }]];
  assert.deepStrictEqual([...purgeableIds(pools, [])], []);
});

test('purgeableIds dedupes a listing delisted across several properties', () => {
  const pools = [[{ id: 'x-y', status: 'delisted' }], [{ id: 'x-y', status: 'delisted' }]];
  assert.deepStrictEqual([...purgeableIds(pools, [])], ['x_y']);
});

test('purgeableIds tolerates empty and malformed input', () => {
  assert.deepStrictEqual([...purgeableIds([], [])], []);
  assert.deepStrictEqual([...purgeableIds(undefined, undefined)], []);
  assert.deepStrictEqual([...purgeableIds([[null, undefined]], [{ id: '1' }])], []);
});
