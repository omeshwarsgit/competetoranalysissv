/**
 * lib/market-pool.js — share one discovered market across the properties that sit in it.
 *
 * WHY
 *   Every own property kept its own private candidate pool, so six properties 8 km apart in North
 *   Goa each rediscovered largely the same market, and each ended up with a *different* view of it
 *   depending on whether its own scan happened to catch the text-search stage. Property 1 held 849
 *   candidates while property 4 held 56 — same market, same week.
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
 *   Properties in the same location share the **inventory**: the union of everything any of them
 *   discovered. They do *not* share a ranking. Distance is recomputed from each property's own
 *   coordinates, because a Candolim villa and an Arpora apartment are 8 km apart and a competitor
 *   next door to one is not a competitor to the other. Sharing the pool removes duplicate
 *   discovery; sharing a ranking would quietly destroy the comparison.
 *
 *   Note also what pooling cannot do: it does not make one scan sufficient. A coordinate search
 *   centred on Candolim will not enumerate Anjuna's neighbours, so each property still contributes
 *   its own local coverage — the union is strictly better than any single scan. What is removed is
 *   the *inconsistency*, not the scanning.
 *
 * POOL KEY
 *   `district` then `state`, taken from the reverse-geocoded metadata (North Goa / Goa) rather than
 *   Booking.com's `city`, which returns sub-localities — Marra, Vagator, Sinquerim, Arpora — and
 *   would split one market into four. Falls back to proximity clustering when no region is known,
 *   so this still works before metadata exists.
 */
'use strict';

/** Great-circle distance in km. */
function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Region key for a property, or null when nothing usable is known. */
function regionKeyOf(prop, meta) {
  const m = (meta && meta[prop.id]) || {};
  const district = m.district || prop.district;
  const state    = m.state    || prop.state;
  if (district && state) return `${district}, ${state}`.toLowerCase();
  if (state)    return String(state).toLowerCase();
  if (district) return String(district).toLowerCase();
  return null;
}

/**
 * Group own properties into market clusters.
 *
 * Region-keyed where possible; anything without a region is clustered by proximity so it still
 * shares with whatever it is genuinely near.
 *
 * @returns {Array<{key:string, propIds:string[]}>}
 */
function clusterProperties(owns, meta, radiusKm = 25) {
  const byRegion = new Map();
  const orphans = [];

  for (const p of owns) {
    const key = regionKeyOf(p, meta);
    if (key) {
      if (!byRegion.has(key)) byRegion.set(key, []);
      byRegion.get(key).push(p);
    } else if (p.lat != null && p.lng != null) {
      orphans.push(p);
    } else {
      // No region and no coordinates: it can only be its own market.
      byRegion.set(`solo:${p.id}`, [p]);
    }
  }

  // Proximity pass for the region-less ones: attach to an existing cluster whose members are
  // within radiusKm, else start a new one.
  for (const p of orphans) {
    let placed = false;
    for (const [key, members] of byRegion) {
      const near = members.some(m => m.lat != null && m.lng != null &&
        haversineKm({lat:p.lat,lng:p.lng}, {lat:m.lat,lng:m.lng}) <= radiusKm);
      if (near) { members.push(p); placed = true; break; }
    }
    if (!placed) byRegion.set(`near:${p.id}`, [p]);
  }

  return [...byRegion.entries()].map(([key, members]) => ({ key, propIds: members.map(p => p.id) }));
}

/**
 * Union the pools of a cluster's properties into one shared inventory.
 *
 * Candidates are keyed by id. Where several properties hold the same listing, the merged record
 * keeps the best-quality fields and the *earliest* firstSeenAt / latest lastSeenAt, so lifecycle
 * history is not reset by pooling. Per-property fields (`distance`, `relevanceScore`, ranking) are
 * dropped here — they are recomputed per property by `rescopeForProperty`.
 *
 * An own property is never a candidate in its own or a sibling's market.
 */
function unionPools(pools, ownSlugs = new Set()) {
  const merged = new Map();
  for (const pool of pools) {
    for (const c of pool || []) {
      if (!c || !c.id) continue;
      if (ownSlugs.has(String(c.slug || c.id).replace(/_/g, '-'))) continue;   // skip our own listings
      const prev = merged.get(c.id);
      if (!prev) { merged.set(c.id, { ...c }); continue; }
      merged.set(c.id, {
        ...prev,
        ...c,
        // Prefer exact coordinates over approximate ones, as discover.js does.
        lat: (c.lat && !c.approximate) ? c.lat : (prev.lat || c.lat),
        lng: (c.lng && !c.approximate) ? c.lng : (prev.lng || c.lng),
        approximate: (c.lat && !c.approximate) ? false : prev.approximate,
        price:   c.price   || prev.price,
        rating:  c.rating  || prev.rating,
        reviews: Math.max(c.reviews || 0, prev.reviews || 0) || null,
        name:    prev.name || c.name,
        // Lifecycle: widest possible history, and a listing seen by ANY member is present.
        firstSeenAt: [prev.firstSeenAt, c.firstSeenAt].filter(Boolean).sort()[0] || null,
        lastSeenAt:  [prev.lastSeenAt,  c.lastSeenAt ].filter(Boolean).sort().pop() || null,
        // Absence only counts where every member missed it; the lowest streak wins.
        missedScans: Math.min(prev.missedScans ?? 0, c.missedScans ?? 0),
        // Delisted only if no member still considers it active.
        status: (prev.status === 'active' || c.status === 'active' || (!prev.status && !c.status))
          ? 'active' : 'delisted',
      });
    }
  }
  return [...merged.values()];
}

/**
 * Re-express a shared pool from one property's point of view: its own distances, nothing else
 * changed. `maxDistKm` drops candidates that are simply too far to be substitutes for it.
 */
function rescopeForProperty(sharedPool, prop, maxDistKm = 40) {
  if (prop.lat == null || prop.lng == null) return sharedPool.map(c => ({ ...c }));
  const origin = { lat: prop.lat, lng: prop.lng };
  const out = [];
  for (const c of sharedPool) {
    if (c.lat == null || c.lng == null) { out.push({ ...c, distance: null }); continue; }
    const d = haversineKm(origin, { lat: c.lat, lng: c.lng });
    if (d > maxDistKm) continue;
    out.push({ ...c, distance: +d.toFixed(2) });
  }
  return out;
}

module.exports = { haversineKm, regionKeyOf, clusterProperties, unionPools, rescopeForProperty };
