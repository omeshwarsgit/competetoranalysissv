/**
 * lib/inventory.js
 *
 * The rules that decide what belongs in the tracked property inventory.
 *
 * WHY THIS IS NOT "ABSENT FROM THE SCAN ⇒ GONE"
 *   `discover.js` finds competitors with a Booking.com search for a SINGLE night, 7 days out.
 *   Booking.com omits properties with no availability for the probed dates, so a fully-booked
 *   property is absent from that search for exactly the same reason a deleted one is. Right now 19
 *   of 62 tracked competitors are sold out across all 30 nights — a naive rule would delist most
 *   of them and permanently lose their price history. The text-search stage is also intermittent
 *   (0 cards one day, 24 the next for an identical query), which swings the candidate pool ~4x on
 *   its own.
 *
 *   So absence only ever produces a *candidate*. Confirmation is a separate, cheap, decisive
 *   check: fetch the property's own page. Empirically —
 *     live listing, even sold out for all 30 nights → HTTP 200, ~1.3 MB, Hotel JSON-LD present
 *     removed listing                               → HTTP 404, 0 bytes
 *   That distinction is what makes automatic delisting safe.
 *
 * STATES  active → (absent MISS_THRESHOLD scans) → candidate → confirm → delisted
 *         delisted → (seen again) → active (relisted)
 *   Anything indeterminate (429, 202, network error, redirect) stays active. The cost of leaving a
 *   dead listing in for another day is a wasted scrape; the cost of delisting a live competitor is
 *   silent loss of the market picture. They are not symmetric.
 */
'use strict';

/** Consecutive scans a property must be absent from before it is even a delist candidate. */
const MISS_THRESHOLD = 3;

/**
 * Canonical id form.
 *
 * The discovery cache stores ids as the Booking.com slug with hyphens
 * ("beautiful-studio-apartment-near-candolim-beach"), while `config.competitors[]` stores the same
 * listing with underscores ("beautiful_studio_apartment_near_candolim_beach"). Comparing the two
 * forms directly matches nothing — which made the first run of this reconciliation see every
 * already-linked competitor as brand new and every delisted one as untracked. Both sides are
 * canonicalised here before any comparison, exactly as the dashboard's `canonId()` does.
 */
const canonId = id => String(id == null ? '' : id).replace(/-/g, '_');

/** Verdicts from a liveness probe of a property page. */
const LIVE = 'live', GONE = 'gone', MOVED = 'moved', UNKNOWN = 'unknown';

/**
 * Classify an HTTP response from a property page.
 * @param {{status:number, bytes:number, hasHotelJsonLd:boolean, location:string}} r
 */
function classifyProbe(r) {
  if (!r || typeof r.status !== 'number') return UNKNOWN;
  // 404/410 are the only statuses Booking.com returns for a slug that no longer exists.
  if (r.status === 404 || r.status === 410) return GONE;
  // A redirect means the listing was merged or renamed — the property still exists, under a new
  // slug. Deleting it would lose the history; the caller can adopt the new slug instead.
  if (r.status >= 300 && r.status < 400) return r.location ? MOVED : UNKNOWN;
  if (r.status === 200) {
    // Guard against a bot-check stub being read as a live page: those come back tiny and carry no
    // Hotel JSON-LD. A real property page is ~1.3 MB.
    if (r.hasHotelJsonLd || r.bytes > 200000) return LIVE;
    return UNKNOWN;
  }
  // 429 / 202 / 5xx — throttling or a bad moment on their side. Never conclude anything.
  return UNKNOWN;
}

/**
 * Which known properties are candidates for delisting?
 * @param {Array} fullMarket cumulative pool from the discovery cache
 * @param {number} threshold consecutive misses required
 */
function delistCandidates(fullMarket, threshold = MISS_THRESHOLD) {
  return (fullMarket || []).filter(p =>
    (p.status || 'active') === 'active' && (p.missedScans || 0) >= threshold);
}

/**
 * Apply a probe verdict to a pool entry. Returns the fields to merge, and the action taken.
 * Pure — the caller persists.
 * @returns {{action:'delisted'|'kept-live'|'moved'|'deferred', patch:object}}
 */
function applyVerdict(entry, verdict, now, probe) {
  const check = { at: now, status: probe && probe.status != null ? probe.status : null, verdict };
  switch (verdict) {
    case GONE:
      return { action: 'delisted', patch: { status: 'delisted', delistedAt: now, delistCheck: check } };
    case LIVE:
      // A false alarm: the property is live and was merely unavailable for the probed dates.
      // Reset the streak so it does not re-trigger every single scan.
      return { action: 'kept-live', patch: { missedScans: 0, status: 'active', delistCheck: check } };
    case MOVED:
      return { action: 'moved', patch: { missedScans: 0, status: 'active', movedTo: probe.location, delistCheck: check } };
    default:
      // Indeterminate. Hold the streak where it is rather than letting repeated throttling
      // accumulate into a delisting.
      return { action: 'deferred', patch: { missedScans: Math.max(0, (entry.missedScans || 0) - 1), delistCheck: check } };
  }
}

/**
 * Pick which candidates should be linked as tracked competitors.
 *
 * The tracked set is deliberately smaller than the discovered market: every linked competitor
 * costs 30 nights of scraping per refresh, and `refresh.js` only scrapes what is linked. So the
 * inventory (the cache) holds everything, while this fills the tracked set up to `target` using
 * the existing relevance ranking — replacing anything delisted, and reporting what it left out so
 * the target can be raised deliberately rather than by drift.
 *
 * @param {Array}  ranked   `results` from the cache, best-first
 * @param {Array}  linked   current config.competitors[] ids
 * @param {Set}    delisted ids confirmed delisted
 * @param {number} target   desired tracked count
 * @returns {{keep:string[], add:string[], drop:string[], available:number}}
 */
function reconcileTracked(ranked, linked, delisted, target) {
  // Everything is compared in canonical form — see canonId above.
  const rankOf = new Map(ranked.map((r, i) => [canonId(r.id), i]));
  const dead = new Set([...delisted].map(canonId));
  const isDead = id => dead.has(canonId(id));

  const keep = linked.filter(id => !isDead(id));
  const drop = linked.filter(isDead);
  const kept = new Set(keep.map(canonId));

  // Candidates: ranked, still active, not already linked. Best relevance first.
  const pool = ranked
    .filter(r => (r.status || 'active') === 'active' && !isDead(r.id) && !kept.has(canonId(r.id)))
    .sort((a, b) => (rankOf.get(canonId(a.id)) ?? 1e9) - (rankOf.get(canonId(b.id)) ?? 1e9));

  const room = Math.max(0, target - keep.length);
  // Emit canonical ids: these go straight into config.competitors[], which uses that form.
  const add = pool.slice(0, room).map(r => canonId(r.id));
  return { keep, add, drop, available: pool.length };
}

/**
 * Which delisted listings may be hard-deleted (`--purge`)?
 *
 * Only ones that no own property still links. A listing can be delisted for one property while
 * another still tracks it — they are separate markets sharing a candidate — and deleting it would
 * break that other property's reference.
 *
 * Both sides are canonicalised, which is not cosmetic: the first version compared hyphenated pool
 * ids against underscored config ids, so the "still linked" guard never matched (it would have
 * purged listings other properties depended on) while the config row it was trying to delete
 * survived. Getting this wrong is unrecoverable — there is no git history here.
 *
 * @param {Array<Array>} pools           per-property `fullMarket` arrays
 * @param {Array}        allProperties   every config entry, own and competitor
 * @returns {Set<string>} canonical ids safe to delete
 */
function purgeableIds(pools, allProperties) {
  const dead = new Set();
  for (const pool of pools || []) {
    for (const p of pool || []) if (p && p.status === 'delisted') dead.add(canonId(p.id));
  }
  const stillLinked = new Set(
    (allProperties || []).flatMap(p => (p.competitors || []).map(canonId)));
  return new Set([...dead].filter(id => !stillLinked.has(id)));
}

module.exports = {
  MISS_THRESHOLD, LIVE, GONE, MOVED, UNKNOWN,
  canonId, classifyProbe, delistCandidates, applyVerdict, reconcileTracked, purgeableIds,
};
