'use strict';
/**
 * sync-inventory.js — keep the tracked property inventory current for every location.
 *
 * Runs after a discovery scan and does three things per own property:
 *
 *   1. NEW LISTINGS      — properties the scan found for the first time are already in the
 *                          discovery cache (that IS the inventory). This links the best of them
 *                          into `config.competitors[]` so they actually get priced, up to a target.
 *   2. DELISTED          — properties absent from the last N scans are CONFIRMED by fetching their
 *                          own Booking.com page, then marked `status:'delisted'` and unlinked.
 *   3. CHURN LOG         — every arrival/departure is appended to data/inventory-log.json.
 *
 * WHY CONFIRMATION IS NOT OPTIONAL
 *   `discover.js` searches a single night 7 days out, and Booking.com omits properties with no
 *   availability for the probed dates. A fully-booked property is therefore absent for the same
 *   reason a deleted one is — 19 of 62 tracked competitors are currently sold out for all 30
 *   nights. The property page settles it: a live listing returns HTTP 200 with a ~1.3 MB page even
 *   when sold out; a removed one returns 404 with 0 bytes. See lib/inventory.js.
 *
 * SAFETY
 *   Delisting *deactivates* — the pool entry, its price history and its dashboard record are all
 *   kept, it is just unlinked from the property and excluded from the tracked set. `--purge` is
 *   required to actually delete data, and this is not a git repository, so the default is
 *   deliberately non-destructive. Anything indeterminate (429, 5xx, network error) stays active.
 *
 * Usage:
 *   node sync-inventory.js --dry-run             report what would change, write nothing
 *   node sync-inventory.js                       apply (config backed up first)
 *   node sync-inventory.js --property=3          one property only
 *   node sync-inventory.js --target=15           tracked competitors per property
 *                                                (default: keep each property's current count)
 *   node sync-inventory.js --miss-threshold=3    scans absent before a delist check
 *   node sync-inventory.js --no-confirm          skip page checks (candidates reported, not acted on)
 *   node sync-inventory.js --purge               also delete delisted records (destructive)
 */
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ensureChrome, CDP_URL } = require('./lib/chrome');
const {
  MISS_THRESHOLD, GONE, canonId, classifyProbe, delistCandidates, applyVerdict, reconcileTracked,
  purgeableIds,
} = require('./lib/inventory');
const { readTracked, writeIfUnchanged } = require('./lib/json-store');

const ROOT        = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config', 'properties.json');
const DISC_FILE   = path.join(ROOT, 'data', 'discovery-cache.json');
const DASH_FILE   = path.join(ROOT, 'data', 'latest.dashboard.json');
const LOG_FILE    = path.join(ROOT, 'data', 'inventory-log.json');

const arg = n => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const has = n => process.argv.includes(`--${n}`);

const DRY        = has('dry-run');
const ONLY       = arg('property');
const TARGET     = arg('target') != null ? parseInt(arg('target'), 10) : null;
const THRESHOLD  = arg('miss-threshold') != null ? parseInt(arg('miss-threshold'), 10) : MISS_THRESHOLD;
const NO_CONFIRM = has('no-confirm');
const PURGE      = has('purge');
// Ceiling on page probes per run. A scan whose reach collapses (the text-search stage is
// intermittent) can leave hundreds of in-scope-looking absences at once — property 1 had 449 after
// one area-only scan following a regional sweep. Each is a live listing that will be confirmed and
// reset, so the work is wasted rather than wrong; this stops one bad run from spending an hour on
// it. Candidates are probed longest-absent first, and anything deferred is reported, never silently
// dropped.
const MAX_CHECKS = Math.max(1, parseInt(arg('max-checks') || '150', 10));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readJSON  = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const writeJSON = (p, o) => { const t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, p); };

/** Booking.com slug for a pool entry — ids are the slug with '-' turned into '_'. */
const slugOf = e => e.slug || (e.url && (e.url.match(/\/hotel\/[a-z]{2}\/([^.?/#]+)/i) || [])[1]) || String(e.id).replace(/_/g, '-');

/**
 * Probe one property page for liveness. Returns the shape lib/inventory.js classifies.
 * `redirect:'manual'` so a 3xx is visible as a move rather than silently followed.
 */
async function probe(slug, headers) {
  const url = `https://www.booking.com/hotel/in/${slug}.en-gb.html?selected_currency=INR`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers, redirect: 'manual' });
      if (r.status === 429 || r.status === 202) {
        try { await r.body?.cancel?.(); } catch (_) {}
        if (attempt < 3) { await sleep(1500 * Math.pow(2, attempt) + Math.random() * 700); continue; }
        return { status: r.status, bytes: 0, hasHotelJsonLd: false, location: '' };
      }
      const html = r.status < 300 ? await r.text() : '';
      return {
        status: r.status,
        bytes: html.length,
        hasHotelJsonLd: /"@type"\s*:\s*"(?:Hotel|LodgingBusiness|Resort|BedAndBreakfast|Apartment)"/.test(html),
        location: r.headers.get('location') || '',
      };
    } catch (e) {
      if (attempt === 3) return { status: null, bytes: 0, hasHotelJsonLd: false, location: '', error: e.message };
      await sleep(900 * (attempt + 1));
    }
  }
  return { status: null, bytes: 0, hasHotelJsonLd: false, location: '' };
}

function backupConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dest = CONFIG_FILE.replace(/\.json$/, `.${stamp}.bak.json`);
  fs.copyFileSync(CONFIG_FILE, dest);
  // Same rotation policy as import-properties.js — keep the newest 5.
  try {
    const dir = path.dirname(CONFIG_FILE), base = path.basename(CONFIG_FILE, '.json');
    fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.') && f.endsWith('.bak.json')).sort().slice(0, -5)
      .forEach(f => fs.unlinkSync(path.join(dir, f)));
  } catch (_) {}
  return dest;
}

/**
 * Build a config entry for a newly-linked competitor, matching import-properties.js's shape.
 * `id` is passed in canonical (underscore) form because that is what config keys on, while the
 * slug keeps the hyphenated form the Booking.com URL needs.
 */
function compEntry(poolEntry, id) {
  const slug = slugOf(poolEntry);
  return {
    id, slug, type: 'comp',
    display: poolEntry.name || poolEntry.id,
    location: poolEntry.city || poolEntry.address || '',
    city: poolEntry.city || poolEntry.address || '',
    country: 'IN',
    propertyType: poolEntry.type || 'property',
    match: (poolEntry.name || poolEntry.id).toLowerCase(),
    competitors: [], deal: 0,
    beds: poolEntry.beds || 1, pax: poolEntry.pax || 2,
    amenities: poolEntry.amenities || [],
    lat: poolEntry.lat ?? null, lng: poolEntry.lng ?? null,
    rating: poolEntry.rating ?? null,
    addedBy: 'sync-inventory', addedAt: new Date().toISOString(),
  };
}

(async () => {
  const now  = new Date().toISOString();
  // Tracked reads: this run probes property pages for minutes before writing, which is exactly the
  // window in which a dashboard click can rewrite config underneath us. See lib/json-store.js.
  const cfgT  = readTracked(CONFIG_FILE);
  const discT = readTracked(DISC_FILE);
  const cfg  = cfgT.data;
  const disc = discT.data;
  if (!cfg)  { console.error('config/properties.json not found. Run import-properties.js first.'); process.exit(1); }
  if (!disc) { console.error('data/discovery-cache.json not found. Run discover-all.js first.');   process.exit(1); }

  const owns = (cfg.properties || []).filter(p => p.type === 'own' && (!ONLY || p.id === ONLY));
  if (!owns.length) { console.error(ONLY ? `No own property with id ${ONLY}.` : 'No own properties in config.'); process.exit(1); }

  console.log(`\n  Inventory sync — ${owns.length} propert${owns.length === 1 ? 'y' : 'ies'}`
            + ` · delist after ${THRESHOLD} missed scan(s)${DRY ? ' · DRY RUN' : ''}\n`);

  // ── Collect delist candidates across all properties, so a shared listing is probed once ──
  const candidateSlugs = new Map();   // slug -> [{propId, entry}]
  for (const own of owns) {
    const pool = disc[own.id]?.fullMarket || [];
    for (const c of delistCandidates(pool, THRESHOLD)) {
      const s = slugOf(c);
      if (!candidateSlugs.has(s)) candidateSlugs.set(s, []);
      candidateSlugs.get(s).push({ propId: own.id, entry: c });
    }
  }

  // ── Confirm them ──────────────────────────────────────────────────────────
  // Longest-absent first, capped at MAX_CHECKS. A deferred candidate keeps its counter and is
  // simply re-considered next run.
  const orderedSlugs = [...candidateSlugs.entries()]
    .sort((a, b) => (b[1][0].entry.missedScans || 0) - (a[1][0].entry.missedScans || 0));
  const toCheck  = orderedSlugs.slice(0, MAX_CHECKS);
  const deferredByCap = orderedSlugs.length - toCheck.length;

  const verdicts = new Map();   // slug -> {verdict, probe}
  if (toCheck.length && !NO_CONFIRM) {
    console.log(`  Confirming ${toCheck.length} delist candidate(s) against their property pages…`
      + (deferredByCap ? `  (${deferredByCap} deferred to the next run by --max-checks=${MAX_CHECKS})` : ''));
    await ensureChrome();
    const browser = await chromium.connectOverCDP(CDP_URL);
    const cookies = await browser.contexts()[0].cookies('https://www.booking.com');
    await browser.close();
    if (cookies.length < 3) {
      console.error('  Too few Booking.com cookies — open booking.com in Chrome and retry.');
      process.exit(1);
    }
    const headers = { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9',
                      Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') };

    let i = 0, gone = 0;
    for (const [slug, refs] of toCheck) {
      const p = await probe(slug, headers);
      const verdict = classifyProbe(p);
      verdicts.set(slug, { verdict, probe: p });
      const nm = (refs[0].entry.name || slug).slice(0, 46);
      const mark = verdict === GONE ? '✗ GONE' : verdict === 'live' ? '· live' : verdict === 'moved' ? '→ moved' : '? unknown';
      if (verdict === GONE) gone++;
      // Only the interesting outcomes are printed line-by-line; a run can legitimately confirm
      // 150 live properties and that wall of text hides the ones that matter.
      if (verdict !== 'live' || toCheck.length <= 25) {
        console.log(`    ${String(i + 1).padStart(3)}/${toCheck.length}  ${mark.padEnd(9)} ${nm}`
                  + `  (absent ${refs[0].entry.missedScans}× · HTTP ${p.status ?? 'err'})`);
      } else if ((i + 1) % 25 === 0) {
        console.log(`    ${String(i + 1).padStart(3)}/${toCheck.length}  checked… ${gone} gone so far`);
      }
      i++;
      await sleep(400);
    }
    console.log('');
  } else if (candidateSlugs.size) {
    console.log(`  ${candidateSlugs.size} delist candidate(s) — not confirmed (--no-confirm)\n`);
  }

  // ── Apply, per property ───────────────────────────────────────────────────
  const churn = [];
  let addedTotal = 0, delistedTotal = 0, keptLive = 0, deferred = 0, movedTotal = 0;

  for (const own of owns) {
    const cacheEntry = disc[own.id];
    if (!cacheEntry) { console.log(`  ${own.id}: no discovery data — skipped (run discover.js)`); continue; }

    const pool   = cacheEntry.fullMarket || [];
    // Two indexes: raw (cache id form) for writing back into the pool, canonical (config id form)
    // for everything that touches config.competitors[]. See canonId in lib/inventory.js.
    const byId   = new Map(pool.map(p => [p.id, p]));
    const byCanon = new Map(pool.map(p => [canonId(p.id), p]));
    const linked = (own.competitors || []).slice();

    // 1. Resolve verdicts into the pool.
    const nowDelisted = new Set();
    for (const c of delistCandidates(pool, THRESHOLD)) {
      const v = verdicts.get(slugOf(c));
      if (!v) continue;                                   // --no-confirm: leave alone
      const { action, patch } = applyVerdict(c, v.verdict, now, v.probe);
      Object.assign(byId.get(c.id), patch);
      if (action === 'delisted') {
        nowDelisted.add(c.id);
        churn.push({ at: now, propId: own.id, id: c.id, name: c.name, event: 'delisted',
                     missedScans: c.missedScans, httpStatus: v.probe.status });
      } else if (action === 'kept-live') keptLive++;
      else if (action === 'moved')      { movedTotal++; churn.push({ at: now, propId: own.id, id: c.id, name: c.name, event: 'moved', movedTo: v.probe.location }); }
      else                              deferred++;
    }
    delistedTotal += nowDelisted.size;

    // 2. Reconcile the tracked set. Default target = the count already chosen for this property,
    //    so churn is replaced without silently growing the scrape (see T-015).
    const target = TARGET != null ? TARGET : (own.competitors || []).length;
    const ranked = (cacheEntry.results || []).map(r => ({ ...r, ...(byId.get(r.id) || {}) }));
    const { keep, add, drop, available } = reconcileTracked(ranked, linked, nowDelisted, target);

    // 3. New arrivals worth reporting even when the target leaves no room for them.
    const arrivals = pool.filter(p => (p.status || 'active') === 'active'
      && p.firstSeenAt && p.firstSeenAt === cacheEntry.fetchedAt);

    console.log(`  ${own.id}  ${(own.display || own.id).slice(0, 42)}`);
    console.log(`      pool ${pool.length} (${pool.filter(p => (p.status||'active')==='active').length} active)`
              + ` · tracked ${linked.length} → ${keep.length + add.length} (target ${target})`);
    if (drop.length) console.log(`      − unlinked ${drop.length} delisted: ${drop.map(id => (byCanon.get(canonId(id))?.name || id).slice(0, 30)).join(', ')}`);
    if (add.length)  console.log(`      + linked ${add.length} new: ${add.map(id => (byCanon.get(canonId(id))?.name || id).slice(0, 30)).join(', ')}`);
    if (!drop.length && !add.length) console.log('      no change');
    if (available > add.length) console.log(`      ${available - add.length} further candidate(s) available — raise --target to track them`);
    if (arrivals.length) console.log(`      (${arrivals.length} first seen in the latest scan)`);

    for (const id of add) {
      const pe = byCanon.get(canonId(id));
      churn.push({ at: now, propId: own.id, id, name: pe?.name || id, event: 'added' });
      addedTotal++;
      // Ensure the competitor has its own config entry, or refresh.js has no slug to scrape.
      if (pe && !(cfg.properties || []).some(p => p.id === id)) cfg.properties.push(compEntry(pe, id));
    }

    own.competitors = keep.concat(add);
  }

  // ── Optional purge of delisted records ────────────────────────────────────
  let purged = 0;
  if (PURGE) {
    // Canonical ids throughout — the pool spells them with hyphens, config and the dashboard with
    // underscores. purgeableIds() also enforces that nothing another property still links is
    // deleted. See lib/inventory.js.
    const toPurge = purgeableIds(owns.map(o => disc[o.id]?.fullMarket || []), cfg.properties);
    if (!DRY && toPurge.size) {
      cfg.properties = (cfg.properties || []).filter(p => !toPurge.has(canonId(p.id)));
      for (const own of owns) {
        const e = disc[own.id];
        if (!e) continue;
        e.fullMarket = (e.fullMarket || []).filter(p => !toPurge.has(canonId(p.id)));
        e.results    = (e.results    || []).filter(p => !toPurge.has(canonId(p.id)));
      }
      const dash = readJSON(DASH_FILE, null);
      if (dash?.competitors) {
        for (const key of Object.keys(dash.competitors)) {
          if (toPurge.has(canonId(key))) delete dash.competitors[key];
        }
        writeJSON(DASH_FILE, dash);
      }
    }
    purged = toPurge.size;
    console.log(`\n  --purge: ${purged} delisted record(s)${DRY ? ' would be' : ''} removed from config, cache and dashboard data`);
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  console.log('');
  if (DRY) {
    console.log('  DRY RUN — nothing written.\n');
  } else {
    const bak = backupConfig();
    cfg.updatedAt = now;
    // Aborts rather than clobbering if either file changed while we were probing.
    writeIfUnchanged(cfgT, cfg);
    writeIfUnchanged(discT, disc);
    if (churn.length) {
      const log = readJSON(LOG_FILE, []);
      writeJSON(LOG_FILE, [{ runAt: now, threshold: THRESHOLD, events: churn }, ...log].slice(0, 90));
    }
    if (bak) console.log(`  ↩ config backed up to config/${path.basename(bak)}`);
    console.log('  ✓ config/properties.json, data/discovery-cache.json'
              + (churn.length ? ', data/inventory-log.json' : '') + ' written');
  }

  console.log(`\n  Summary: +${addedTotal} linked · −${delistedTotal} delisted`
            + ` · ${keptLive} false alarm(s) kept (live but unavailable)`
            + (movedTotal ? ` · ${movedTotal} moved` : '')
            + (deferred ? ` · ${deferred} indeterminate (left active)` : '')
            + (PURGE ? ` · ${purged} purged` : ''));
  if (delistedTotal && !PURGE) {
    console.log('  Delisted records are deactivated, not deleted — price history is preserved.');
  }
  if (addedTotal && !DRY) {
    console.log('\n  Next: node refresh.js   to scrape rates for the newly linked competitors.');
  }
  console.log('');
})().catch(e => {
  if (e.code === 'ESTALE') { console.error('\n  ABORTED: ' + e.message + '\n'); process.exit(3); }
  console.error('\n  FAILED:', e.message, '\n');
  process.exit(1);
});
