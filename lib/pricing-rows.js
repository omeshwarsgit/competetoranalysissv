/**
 * lib/pricing-rows.js
 *
 * Single source of truth for the Google Sheets pricing payload: column order,
 * row construction and the change-detection hash.
 *
 * Both sync transports (service-account REST and Apps Script Web App) import this,
 * so the two paths can never drift into different column mappings.
 */
'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT      = path.join(__dirname, '..');
const DASH_FILE = path.join(ROOT, 'data', 'latest.dashboard.json');
const META_FILE = path.join(ROOT, 'data', 'latest.meta.json');
const CFG_FILE  = path.join(ROOT, 'config', 'properties.json');
const DISC_FILE = path.join(ROOT, 'data', 'discovery-cache.json');

// ── column mapping ────────────────────────────────────────────────────────────
// Order here IS the sheet column order. Appending a field is safe; reordering or
// removing one changes the meaning of existing columns, so don't.
const RATES_COLS = [
  'Key', 'Property ID', 'Property Name', 'Role', 'Tracked For', 'Booking Slug',
  'Room Key', 'Room Name', 'Occupancy', 'Bed Type', 'Primary Room',
  'Stay Date', 'Day', 'Night Type',
  'Rate (INR)', 'Available', 'Currency', 'Source', 'Scraped At', 'Last Synced',
];
const SUM_COLS = [
  'Key', 'Property ID', 'Property Name', 'Role', 'Tracked For', 'Booking Slug',
  'City', 'Property Type', 'Room Types', 'Nights Priced', 'Nights Unavailable',
  'Lead-in Rate (INR)', 'Lead-in ADR 30N', 'Min Rate', 'Max Rate', 'Median Rate',
  'Rate Spread x', 'Rate CV', 'Weekday Mean', 'Peak Mean', 'Peak Premium %',
  'Price Index vs Band', 'Rank in Band', 'Band Size', 'Currency', 'Scraped At', 'Last Synced',
];
const LOG_COLS = [
  'Run At', 'Trigger', 'Data Scraped At', 'Data Hash', 'Properties', 'Rate Rows Built',
  'Rates Added', 'Rates Updated', 'Rates Unchanged', 'Summary Added', 'Summary Updated',
  'Duration (s)', 'Status', 'Detail',
];

// ── stats ─────────────────────────────────────────────────────────────────────
const srt  = a => [...a].sort((x, y) => x - y);
const med  = a => { if (!a.length) return null; const s = srt(a), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m-1]+s[m])/2); };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const cvOf = a => { const m = mean(a); if (!m) return null; return Math.sqrt(mean(a.map(v => (v-m)**2)))/m; };
const R0 = v => v == null ? '' : Math.round(v);
const R2 = v => v == null ? '' : Math.round(v*100)/100;
const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

let hol = {}; try { hol = require('./holidays.js'); } catch (_) {}
const lwSet = new Set();
try {
  const y = new Date().getFullYear();
  for (const yr of [y, y+1]) for (const x of (hol.computeLongWeekends?.(yr) || [])) for (const d of (x.dates||[])) lwSet.add(d);
} catch (_) {}
function nightType(d) {
  if (lwSet.has(d)) return 'Long weekend';
  const w = new Date(d + 'T00:00:00').getDay();
  return w === 5 ? 'Friday' : w === 6 ? 'Saturday' : w === 0 ? 'Sunday' : 'Weekday';
}

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

// ── build ─────────────────────────────────────────────────────────────────────
/**
 * @param {string|{properties?:string[], includeOwn?:boolean}} scope
 *   A property id, or { properties, includeOwn }. Omit to cover the whole portfolio.
 *   `properties` limits which own properties (and therefore which selected
 *   competitors) are included; `includeOwn` false emits competitors only.
 */
function buildRows(scope) {
  const opt = typeof scope === 'string' ? { properties: [scope] }
            : (scope && typeof scope === 'object') ? scope : {};
  const includeOwn = opt.includeOwn !== false;

  const dash = readJSON(DASH_FILE, null);
  if (!dash) throw new Error('data/latest.dashboard.json not found — run refresh.js first.');
  const meta = readJSON(META_FILE, {}) || {};
  const cfg  = readJSON(CFG_FILE, { properties: [] });
  const disc = readJSON(DISC_FILE, {}) || {};
  const scrapedAt = dash.meta?.scrapedAt || meta.scrapedAt || '';
  const source    = dash.meta?.source || meta.source || 'booking.com';
  const syncedAt  = new Date().toISOString();

  const cfgById = new Map(cfg.properties.map(p => [p.id, p]));
  const ownIds  = (opt.properties && opt.properties.length)
    ? opt.properties.map(String)
    : Object.keys(dash.portfolio || {});
  for (const id of ownIds) {
    if (!dash.portfolio?.[id]) throw new Error(`Property "${id}" is not in data/latest.dashboard.json.`);
  }

  // a competitor can be tracked by several own properties
  const trackedFor = new Map();
  for (const oid of ownIds) {
    for (const cid of (cfgById.get(oid)?.competitors || [])) {
      if (!trackedFor.has(cid)) trackedFor.set(cid, []);
      trackedFor.get(cid).push(oid);
    }
  }

  // normalised lead-in snapshot rate per competitor, from the discovery scan
  const snapshot = new Map();
  for (const oid of ownIds) {
    for (const r of (disc[oid]?.results || [])) {
      const id = r.id.replace(/-/g, '_');
      if (r.price != null && r.price > 0 && !snapshot.has(id)) snapshot.set(id, Math.round(r.price));
    }
  }

  const targets = [];
  if (includeOwn) {
    for (const oid of ownIds) {
      const p = (dash.portfolio || {})[oid];
      if (p) targets.push({ id: oid, rec: p, role: 'Own', trackedFor: '' });
    }
  }
  const seenComp = new Set();
  for (const [cid, owners] of trackedFor) {
    const c = (dash.competitors || {})[cid];
    if (!c || seenComp.has(cid)) continue;
    seenComp.add(cid);
    targets.push({ id: cid, rec: c, role: 'Competitor', trackedFor: owners.join(', ') });
  }

  const rateRows = [], sumRows = [];

  for (const t of targets) {
    const cf = cfgById.get(t.id) || {};
    const rooms = Object.entries(t.rec.rooms || {});
    const leadByDate = {}, wd = [], pk = [];
    let nightsPriced = 0, nightsUnavail = 0;

    // union of dates, so unavailable nights are recorded rather than silently absent
    const dates = [...new Set(rooms.flatMap(([, r]) => Object.keys(r.observed || {})))].sort();

    for (const [rk, r] of rooms) {
      for (const d of dates) {
        const v = r.observed?.[d];
        const avail = v != null && v > 0;
        rateRows.push([
          `${t.id}|${rk}|${d}`,
          t.id, t.rec.name || cf.display || t.id, t.role, t.trackedFor, cf.slug || '',
          rk, r.name || rk, r.pax ?? '', r.bed ?? '', r.primary ? 'Yes' : 'No',
          d, DOW[new Date(d + 'T00:00:00').getDay()], nightType(d),
          avail ? Math.round(v) : '', avail ? 'Yes' : 'No', 'INR', source, scrapedAt, syncedAt,
        ]);
      }
    }
    for (const d of dates) {
      const v = rooms.map(([, r]) => r.observed?.[d]).filter(x => x != null && x > 0);
      if (v.length) { leadByDate[d] = Math.min(...v); (nightType(d) === 'Weekday' ? wd : pk).push(Math.min(...v)); nightsPriced++; }
      else nightsUnavail++;
    }

    const lead = Object.values(leadByDate);
    const wdM = mean(wd), pkM = mean(pk);
    sumRows.push({
      key: t.id,
      values: [
        t.id, t.id, t.rec.name || cf.display || t.id, t.role, t.trackedFor, cf.slug || '',
        t.rec.city || cf.city || '', cf.propertyType || t.rec.propertyType || '',
        rooms.length, nightsPriced, nightsUnavail,
        snapshot.get(t.id) ?? '', R0(mean(lead)),
        lead.length ? Math.min(...lead) : '', lead.length ? Math.max(...lead) : '', med(lead) ?? '',
        lead.length ? R2(Math.max(...lead)/Math.min(...lead)) : '', R2(cvOf(lead)),
        R0(wdM), R0(pkM), (wdM && pkM) ? Math.round((pkM/wdM - 1)*100) : '',
        '', '', '',                       // index / rank / band size — filled below
        'INR', scrapedAt, syncedAt,
      ],
      _lead: mean(lead),
    });
  }

  // price index / rank against a ±40% band of comparable lead-in rates
  const priced = sumRows.filter(r => r._lead != null);
  for (const r of priced) {
    const band = priced.filter(o => o._lead >= r._lead*0.6 && o._lead <= r._lead*1.4).map(o => o._lead);
    const bm = med(band);
    r.values[21] = bm ? Math.round(r._lead / bm * 100) : '';
    r.values[22] = srt(band).filter(v => v < r._lead).length + 1;
    r.values[23] = band.length;
  }

  return {
    rateRows,
    sumRows: sumRows.map(r => [r.key, ...r.values.slice(1)]),
    meta: { scrapedAt, source, syncedAt, properties: targets.length },
  };
}

/**
 * Daily rate-shop grid: one row per stay date, one column per property.
 *
 * The rate shown is each property's lead-in for that night — the cheapest room it
 * actually has available. Blank means nothing was bookable.
 *
 * Column A is the stay date, which doubles as the upsert key, so re-syncing updates
 * a day in place instead of appending. The trailing Last Synced column is excluded
 * from change comparison, so a re-scrape with identical rates writes nothing.
 *
 * Columns are ordered by property id (stable across runs) but labelled with the
 * display name, so a rename can't silently reshuffle the grid.
 */
function buildDailyGrid(scope) {
  const opt = typeof scope === 'string' ? { properties: [scope] }
            : (scope && typeof scope === 'object') ? scope : {};
  const includeOwn = opt.includeOwn !== false;

  const dash = readJSON(DASH_FILE, null);
  if (!dash) throw new Error('data/latest.dashboard.json not found — run refresh.js first.');
  const meta = readJSON(META_FILE, {}) || {};
  const cfg  = readJSON(CFG_FILE, { properties: [] });
  const scrapedAt = dash.meta?.scrapedAt || meta.scrapedAt || '';
  const syncedAt  = new Date().toISOString();

  const cfgById = new Map(cfg.properties.map(p => [p.id, p]));
  const ownIds = (opt.properties && opt.properties.length)
    ? opt.properties.map(String)
    : Object.keys(dash.portfolio || {});
  for (const id of ownIds) {
    if (!dash.portfolio?.[id]) throw new Error(`Property "${id}" is not in data/latest.dashboard.json.`);
  }

  const cols = [];
  if (includeOwn) {
    for (const oid of ownIds) {
      const p = dash.portfolio[oid];
      if (p) cols.push({ id: oid, name: p.name || cfgById.get(oid)?.display || oid, rec: p, own: true });
    }
  }
  const seen = new Set(cols.map(c => c.id));
  for (const oid of ownIds) {
    for (const cid of (cfgById.get(oid)?.competitors || [])) {
      if (seen.has(cid)) continue;
      const c = dash.competitors?.[cid];
      if (!c) continue;
      seen.add(cid);
      cols.push({ id: cid, name: c.name || cfgById.get(cid)?.display || cid, rec: c, own: false });
    }
  }
  if (!cols.length) throw new Error('No properties in scope — check "properties"/"includeOwn" in config/sheets.json.');

  cols.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // disambiguate duplicate display names so two columns can never be confused
  const nameCount = {};
  cols.forEach(c => { nameCount[c.name] = (nameCount[c.name] || 0) + 1; });
  const usedTwice = new Set(Object.keys(nameCount).filter(n => nameCount[n] > 1));
  cols.forEach(c => { c.label = usedTwice.has(c.name) ? `${c.name} (${c.id})` : c.name; });

  // lead-in per property per night
  const leadIn = new Map();
  const dateSet = new Set();
  for (const c of cols) {
    const rooms = Object.values(c.rec.rooms || {});
    const per = {};
    for (const r of rooms) {
      for (const [d, v] of Object.entries(r.observed || {})) {
        if (v == null || v <= 0) continue;
        dateSet.add(d);
        if (per[d] == null || v < per[d]) per[d] = v;
      }
    }
    leadIn.set(c.id, per);
  }
  const dates = [...dateSet].sort();

  const headers = ['Date', 'Day', 'Night Type', ...cols.map(c => c.label), 'Last Synced'];
  const rows = dates.map(d => [
    d, DOW[new Date(d + 'T00:00:00').getDay()], nightType(d),
    ...cols.map(c => { const v = leadIn.get(c.id)[d]; return v == null ? '' : Math.round(v); }),
    syncedAt,
  ]);

  return {
    headers, rows,
    meta: { scrapedAt, syncedAt, properties: cols.length, dates: dates.length,
            columns: cols.map(c => ({ id: c.id, label: c.label, own: c.own })) },
  };
}

/** Hash excludes the trailing Last Synced column so identical prices hash identically. */
function hashRows(rows) {
  const h = crypto.createHash('sha256');
  for (const r of rows) h.update(r.slice(0, -1).join('') + '');
  return h.digest('hex').slice(0, 16);
}

module.exports = { buildRows, buildDailyGrid, hashRows, RATES_COLS, SUM_COLS, LOG_COLS, DASH_FILE };
