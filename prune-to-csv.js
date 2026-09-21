/**
 * prune-to-csv.js
 *
 * Makes properties.csv the single source of truth for DATA, not just for display.
 * Removes every property, record and reference not present in the sheet from:
 *
 *   config/properties.json         own entries + all competitor entries they referenced
 *   data/latest.dashboard.json     portfolio + competitors
 *   data/discovery-cache.json      per-property market scans
 *   data/history/*.dashboard.json  every dated snapshot
 *   data/property-meta.json        scraped metadata keyed by property id
 *   data/geo-cache.json            coordinates keyed by property id / slug
 *   data/discovery-folders.json    Discover-tab folders keyed by own property id
 *
 * IDENTITY RULE
 *   Property IDs are reused across sheet revisions, so an id match alone is not enough —
 *   old id 1 was "Backspace Anjuna Beach" while the current sheet's row 1 is a different
 *   villa. A record is kept only when its Booking.com slug matches the slug in the sheet.
 *   A sheet row whose link yields no slug (e.g. a booking.com/Share-xxxx short link) can
 *   never confirm identity, so nothing is carried over for it — it is rebuilt as a stub.
 *
 * Usage:
 *   node prune-to-csv.js --dry-run     report what would change, write nothing
 *   node prune-to-csv.js               apply (writes a timestamped backup first)
 *   node prune-to-csv.js --no-backup   apply without backing up (not recommended)
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { readProperties } = require('./lib/csv-properties');

const DRY       = process.argv.includes('--dry-run');
const NO_BACKUP = process.argv.includes('--no-backup');

const ROOT        = __dirname;
const CSV_FILE    = path.join(ROOT, 'properties.csv');
const CONFIG_FILE = path.join(ROOT, 'config', 'properties.json');
const DASH_FILE   = path.join(ROOT, 'data', 'latest.dashboard.json');
const DISC_FILE   = path.join(ROOT, 'data', 'discovery-cache.json');
const META_FILE   = path.join(ROOT, 'data', 'property-meta.json');
const GEO_FILE    = path.join(ROOT, 'data', 'geo-cache.json');
const FOLDER_FILE = path.join(ROOT, 'data', 'discovery-folders.json');
const HISTORY_DIR = path.join(ROOT, 'data', 'history');

// The CSV contract lives in lib/csv-properties.js — see the header there. Own rows come back
// deduped and in sheet order, each carrying the Booking.com slug the identity rule needs.
const readSheet = () => readProperties(CSV_FILE).properties;

const readJSON  = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const writeJSON = (p, o, pretty) => {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(o, null, 2) : JSON.stringify(o));
  fs.renameSync(tmp, p);
};
const exists = p => { try { return fs.existsSync(p); } catch (_) { return false; } };

// ── main ──────────────────────────────────────────────────────────────────────
const sheet    = readSheet();
const sheetIds = new Set(sheet.map(r => r.id));

// The ORIGINAL config, read once before anything is rewritten. Every id-keyed cache is
// filtered against this, so identity is judged consistently everywhere.
const origConfig = readJSON(CONFIG_FILE, { properties: [] });
const origOwn    = new Map((origConfig.properties || [])
  .filter(p => p.type === 'own').map(p => [String(p.id), p]));

// An id survives only if the sheet row and the stored entry are demonstrably the SAME
// Booking.com listing. Matching ids prove nothing — ids get reused between sheet
// revisions — so a row whose link yields no slug can never confirm identity and keeps
// nothing. This is what stops old Backspace/Boulevard records surfacing under new names.
const confirmedIds = new Set(
  sheet.filter(r => r.slug && origOwn.get(r.id)?.slug === r.slug).map(r => r.id)
);

console.log(`\n  properties.csv: ${sheet.length} propert${sheet.length === 1 ? 'y' : 'ies'}`);
sheet.forEach(r => console.log(`    ${r.id.padEnd(6)} ${r.name}${r.slug ? '  [' + r.slug + ']' : '  (no hotel slug in link — identity unverifiable)'}`));

// Backup ---------------------------------------------------------------------
let backupDir = null;
if (!DRY && !NO_BACKUP) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  backupDir = path.join(ROOT, `_backup-${stamp}`);
  fs.mkdirSync(path.join(backupDir, 'data', 'history'), { recursive: true });
  fs.mkdirSync(path.join(backupDir, 'config'), { recursive: true });
  const copy = (src, rel) => { if (exists(src)) fs.copyFileSync(src, path.join(backupDir, rel)); };
  copy(CSV_FILE,    'properties.csv');
  copy(CONFIG_FILE, path.join('config', 'properties.json'));
  copy(DASH_FILE,   path.join('data', 'latest.dashboard.json'));
  copy(DISC_FILE,   path.join('data', 'discovery-cache.json'));
  copy(META_FILE,   path.join('data', 'property-meta.json'));
  copy(GEO_FILE,    path.join('data', 'geo-cache.json'));
  copy(FOLDER_FILE, path.join('data', 'discovery-folders.json'));
  if (exists(HISTORY_DIR)) {
    for (const f of fs.readdirSync(HISTORY_DIR)) {
      fs.copyFileSync(path.join(HISTORY_DIR, f), path.join(backupDir, 'data', 'history', f));
    }
  }
  console.log(`\n  ↩ Backup written to ${path.basename(backupDir)}/`);
}

const report = [];
const note = (file, before, after, detail) =>
  report.push({ file, before, after, removed: before - after, detail: detail || '' });

// 1. config/properties.json --------------------------------------------------
// Rebuild from the sheet. An own entry keeps its enriched fields only when its slug
// still matches; otherwise it is a fresh stub. Competitor entries survive only if some
// surviving own property still references them.
if (exists(CONFIG_FILE)) {
  const cfg     = origConfig;
  const beforeOwn  = (cfg.properties || []).filter(p => p.type === 'own').length;
  const beforeComp = (cfg.properties || []).filter(p => p.type === 'comp').length;

  const keptOwn = [];
  for (const row of sheet) {
    const prev = origOwn.get(row.id);
    if (confirmedIds.has(row.id)) {
      keptOwn.push({ ...prev, display: row.name || prev.display });
    } else {
      const stub = {
        id: row.id, type: 'own',
        display: row.name || row.id,
        location: '', city: '', country: 'IN',
        propertyType: 'villa',
        match: row.id.replace(/_/g, ' '),
        competitors: [], deal: 0, beds: 1, pax: 2, amenities: [],
      };
      if (row.slug) stub.slug = row.slug;
      if (row.url)  stub.sourceUrl = row.url;
      keptOwn.push(stub);
    }
  }

  const referenced = new Set(keptOwn.flatMap(o => o.competitors || []));
  const keptComp = (cfg.properties || []).filter(p => p.type === 'comp' && referenced.has(String(p.id)));
  // A surviving own property must not point at a competitor that was dropped
  const keptCompIds = new Set(keptComp.map(p => String(p.id)));
  keptOwn.forEach(o => { o.competitors = (o.competitors || []).filter(c => keptCompIds.has(String(c))); });

  const out = { version: cfg.version || '2.0', updatedAt: new Date().toISOString(),
                properties: [...keptOwn, ...keptComp] };
  if (!DRY) writeJSON(CONFIG_FILE, out, true);
  note('config/properties.json', beforeOwn,  keptOwn.length,  'own properties');
  note('config/properties.json', beforeComp, keptComp.length, 'competitor entries');
}

// 2. data/latest.dashboard.json ----------------------------------------------
if (exists(DASH_FILE)) {
  const dash = readJSON(DASH_FILE, null);
  if (dash) {
    const beforeP = Object.keys(dash.portfolio   || {}).length;
    const beforeC = Object.keys(dash.competitors || {}).length;

    const portfolio = {};
    for (const row of sheet) {
      const prev = (dash.portfolio || {})[row.id];
      // keep scraped rooms only if this id still refers to the same listing
      if (prev && confirmedIds.has(row.id)) portfolio[row.id] = { ...prev, name: row.name || prev.name };
      else portfolio[row.id] = { id: row.id, name: row.name || row.id, location: '', city: '',
                                 propertyType: 'villa', beds: 1, pax: 2, competitors: [], rooms: {} };
    }
    const keepComp = new Set(Object.values(portfolio).flatMap(p => p.competitors || []).map(String));
    const competitors = {};
    for (const [id, c] of Object.entries(dash.competitors || {})) if (keepComp.has(String(id))) competitors[id] = c;

    if (!DRY) writeJSON(DASH_FILE, { meta: dash.meta || {}, portfolio, competitors }, false);
    note('data/latest.dashboard.json', beforeP, Object.keys(portfolio).length,   'portfolio entries');
    note('data/latest.dashboard.json', beforeC, Object.keys(competitors).length, 'competitor entries');
  }
}

// 3. data/discovery-cache.json ----------------------------------------------
if (exists(DISC_FILE)) {
  const disc = readJSON(DISC_FILE, {});
  const before = Object.keys(disc).length;
  const kept = {};
  for (const [pid, entry] of Object.entries(disc)) if (confirmedIds.has(String(pid))) kept[pid] = entry;
  if (!DRY) writeJSON(DISC_FILE, kept, true);
  note('data/discovery-cache.json', before, Object.keys(kept).length, 'property scans');
}

// 4. data/history/*.dashboard.json ------------------------------------------
if (exists(HISTORY_DIR)) {
  let files = 0, removedP = 0, keptP = 0;
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    if (!/\.dashboard\.json$/i.test(f)) continue;
    const p = path.join(HISTORY_DIR, f);
    const snap = readJSON(p, null);
    if (!snap) continue;
    files++;
    const portfolio = {}, competitors = {};
    for (const [id, rec] of Object.entries(snap.portfolio || {})) {
      if (confirmedIds.has(String(id))) { portfolio[id] = rec; keptP++; } else removedP++;
    }
    const keep = new Set(Object.values(portfolio).flatMap(r => r.competitors || []).map(String));
    for (const [id, rec] of Object.entries(snap.competitors || {})) if (keep.has(String(id))) competitors[id] = rec;
    if (!DRY) writeJSON(p, { meta: snap.meta || {}, portfolio, competitors }, false);
  }
  note('data/history/*.dashboard.json', removedP + keptP, keptP, `portfolio entries across ${files} snapshot(s)`);
}

// 5. data/property-meta.json ------------------------------------------------
if (exists(META_FILE)) {
  const m = readJSON(META_FILE, {});
  const before = Object.keys(m).length;
  const kept = {};
  for (const [id, v] of Object.entries(m)) if (confirmedIds.has(String(id))) kept[id] = v;
  if (!DRY) writeJSON(META_FILE, kept, true);
  note('data/property-meta.json', before, Object.keys(kept).length, 'metadata records');
}

// 6. data/geo-cache.json ----------------------------------------------------
// Keyed by property id AND by slug, so keep both forms for surviving properties.
if (exists(GEO_FILE)) {
  const g = readJSON(GEO_FILE, {});
  const before = Object.keys(g).length;
  const allow = new Set();
  for (const row of sheet) {
    if (!confirmedIds.has(row.id)) continue;
    allow.add(row.id);
    if (row.slug) { allow.add(row.slug); allow.add(row.slug.replace(/-/g, '_')); }
  }
  const kept = {};
  for (const [k, v] of Object.entries(g)) if (allow.has(k)) kept[k] = v;
  if (!DRY) writeJSON(GEO_FILE, kept, true);
  note('data/geo-cache.json', before, Object.keys(kept).length, 'cached coordinates');
}

// 7. data/discovery-folders.json --------------------------------------------
if (exists(FOLDER_FILE)) {
  const f = readJSON(FOLDER_FILE, {});
  const before = Object.keys(f).length;
  const kept = {};
  for (const [pid, v] of Object.entries(f)) if (confirmedIds.has(String(pid))) kept[pid] = v;
  if (!DRY) writeJSON(FOLDER_FILE, kept, true);
  note('data/discovery-folders.json', before, Object.keys(kept).length, 'folder sets');
}

// ── report ────────────────────────────────────────────────────────────────────
console.log(`\n  ${DRY ? 'DRY RUN — nothing written' : 'Applied'}\n`);
const w = Math.max(...report.map(r => r.file.length));
console.log(`  ${'file'.padEnd(w)}  ${'kept'.padStart(6)}  ${'removed'.padStart(8)}   detail`);
console.log(`  ${'-'.repeat(w)}  ------  --------   ------`);
for (const r of report) {
  console.log(`  ${r.file.padEnd(w)}  ${String(r.after).padStart(6)}  ${String(r.removed).padStart(8)}   ${r.detail}`);
}
const totalRemoved = report.reduce((n, r) => n + r.removed, 0);
console.log(`\n  ${totalRemoved} record(s) ${DRY ? 'would be' : ''} removed.`);
if (backupDir) console.log(`  Backup: ${path.basename(backupDir)}/`);
if (DRY) console.log('\n  Re-run without --dry-run to apply.\n');
else {
  const noSlug = sheet.filter(r => !r.slug);
  if (noSlug.length) {
    console.log(`\n  ⚠ ${noSlug.length} sheet row(s) have no Booking.com hotel slug, so they hold no`);
    console.log('    data and cannot be scraped. Replace the share links with full');
    console.log('    https://www.booking.com/hotel/in/<slug>.html URLs, then run:');
    console.log('      node import-properties.js && node refresh.js\n');
  }
}
