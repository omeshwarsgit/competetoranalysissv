'use strict';
/**
 * pool-market.js — give every property in a location the same discovered market.
 *
 * Properties in the same region (North Goa, from the reverse-geocoded metadata) share the union of
 * everything any of them has discovered. Each then sees that shared inventory ranked by its OWN
 * distances, because a competitor next door to the Candolim villa is 8 km from the Arpora
 * apartment and is not the same competitor to it. See lib/market-pool.js for the reasoning.
 *
 * This does not replace scanning. A coordinate search centred on Candolim will not enumerate
 * Anjuna's neighbours, so each property still contributes its own local coverage — what pooling
 * removes is the inconsistency between them (property 1 held 849 candidates while property 4 held
 * 56, for the same market in the same week), not the scans.
 *
 * Own properties are never candidates in each other's markets.
 *
 * Usage:
 *   node pool-market.js --dry-run      report what each property would gain, write nothing
 *   node pool-market.js                apply
 *   node pool-market.js --max-dist=40  drop shared candidates farther than this from a property
 */
const fs   = require('fs');
const path = require('path');
const { clusterProperties, unionPools, rescopeForProperty } = require('./lib/market-pool');
const { readTracked, writeIfUnchanged } = require('./lib/json-store');

const ROOT        = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config', 'properties.json');
const DISC_FILE   = path.join(ROOT, 'data', 'discovery-cache.json');
const META_FILE   = path.join(ROOT, 'data', 'property-meta.json');

const arg = n => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const DRY      = process.argv.includes('--dry-run');
const MAX_DIST = parseFloat(arg('max-dist') || '40');

const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };

const cfg  = readJSON(CONFIG_FILE, null);
const meta = readJSON(META_FILE, {});
const discT = readTracked(DISC_FILE);
const disc  = discT.data;
if (!cfg)  { console.error('config/properties.json not found.'); process.exit(1); }
if (!disc) { console.error('data/discovery-cache.json not found — run discover-all.js first.'); process.exit(1); }

const owns = (cfg.properties || []).filter(p => p.type === 'own');
if (!owns.length) { console.error('No own properties in config.'); process.exit(1); }

// Our own listings must never appear as competitors in a sibling's market.
const ownSlugs = new Set(owns.map(p => String(p.slug || '').toLowerCase()).filter(Boolean));

const clusters = clusterProperties(owns, meta);
console.log(`\n  ${owns.length} propert${owns.length === 1 ? 'y' : 'ies'} in ${clusters.length} market cluster(s)`
          + `${DRY ? ' · DRY RUN' : ''}\n`);

let grew = 0;
for (const { key, propIds } of clusters) {
  const members = propIds.filter(id => disc[id]);
  console.log(`  ── ${key} — ${propIds.length} propert${propIds.length === 1 ? 'y' : 'ies'} `
            + `(${members.length} with scan data) ──`);
  if (propIds.length < 2) {
    console.log('     single property in this market — nothing to pool\n');
    continue;
  }

  const shared = unionPools(members.map(id => disc[id].fullMarket || []), ownSlugs);
  const beforeTotal = members.reduce((a, id) => a + (disc[id].fullMarket || []).length, 0);
  console.log(`     shared inventory: ${shared.length} unique listings `
            + `(from ${beforeTotal} across the cluster, so ${beforeTotal - shared.length} were duplicates)`);

  for (const id of propIds) {
    const entry = disc[id];
    if (!entry) { console.log(`     ${id}: no scan data — skipped (run discover.js --property=${id})`); continue; }
    const before = (entry.fullMarket || []).length;
    const rescoped = rescopeForProperty(shared, cfg.properties.find(p => p.id === id), MAX_DIST);
    const added = rescoped.length - before;
    console.log(`     ${String(id).padEnd(4)} ${before} → ${rescoped.length} candidates`
              + `${added > 0 ? `  (+${added} inherited from siblings)` : added < 0 ? `  (${added} beyond ${MAX_DIST}km)` : '  (no change)'}`);
    if (added > 0) grew++;
    if (!DRY) {
      entry.fullMarket = rescoped;
      // `results` is the ranked view. Re-ranking needs discover.js's scoring model, so rather than
      // half-rank here, mark the entry as needing a re-rank and keep the existing ranked list
      // filtered to listings that still exist in the shared pool.
      const keep = new Set(rescoped.map(c => c.id));
      entry.results = (entry.results || []).filter(r => keep.has(r.id))
        .map(r => { const m = rescoped.find(c => c.id === r.id); return m ? { ...r, distance: m.distance } : r; });
      entry.pooledFrom = key;
      entry.pooledAt = new Date().toISOString();
    }
  }
  console.log('');
}

if (DRY) {
  console.log('  DRY RUN — nothing written.\n');
} else {
  writeIfUnchanged(discT, disc);
  console.log(`  ✓ data/discovery-cache.json written — ${grew} propert${grew === 1 ? 'y' : 'ies'} gained candidates\n`);
  console.log('  Note: `results` (the ranked list) was filtered to the shared pool and distances updated,');
  console.log('  but relevance is only fully re-scored by discover.js. Run a scan, or');
  console.log('  `node sync-inventory.js`, to re-rank and link newly-shared candidates.\n');
}
