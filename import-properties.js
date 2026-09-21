/**
 * import-properties.js
 *
 * Reads properties.csv and writes config/properties.json.
 * Automatically discovers competitors from Booking.com for each property.
 *
 * CSV columns (current header, legacy names still accepted):
 *   Property ID        — StayVista system ID; one config entry per ID
 *   Property           — display name of YOUR property   (was "Stayvista Property")
 *   Booking.com Link   — Booking.com URL of YOUR property (was "Own Link")
 *   Location           — City / Area for Booking.com search; on a row with NO
 *                        Property ID this column instead holds a competitor NAME
 *   Competitor Link    — Booking.com URL of manual competitor (for competitor rows)
 *
 * A single Property ID may appear on several rows, one per sellable unit
 * ("Amber @ Golden Triangle", "Sierra @ Golden Triangle"). The system tracks one
 * entry per Property ID, so those rows collapse into one entry whose display is
 * the shared base name; every unit name is kept on the entry's `units` array.
 *
 * Options:
 *   --check              Validate CSV only, do not write
 *   --merge              Accepted for back-compat; carrying competitors over is
 *                        now the default (see --reset-competitors)
 *   --reset-competitors  Start with empty competitor lists and rebuild purely
 *                        from discovery (the old default behaviour)
 *   --no-discover        Rebuild config from the CSV without running discovery
 *   --force              Re-run discovery even if the property is already cached
 *   --max-competitors=N  Max competitors to auto-select per property (default: 10)
 */
'use strict';
const fs         = require('fs');
const path       = require('path');
const { spawn }  = require('child_process');
const { readCSVText, parseCSVLine, normaliseId, slugFromUrl, HEADER_ALIASES } =
  require('./lib/csv-properties');

const CSV_FILE    = path.join(__dirname, 'properties.csv');
const CONFIG_FILE = path.join(__dirname, 'config', 'properties.json');
const DISC_FILE   = path.join(__dirname, 'data', 'discovery-cache.json');
const GEO_CACHE_FILE = path.join(__dirname, 'data', 'geo-cache.json');

// Load geo-cache
let geoCache = {};
try { geoCache = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8')); } catch (_) {}

// Load scraped property metadata (fallback for location/coords)
const PROP_META_FILE = path.join(__dirname, 'data', 'property-meta.json');
let propMeta = {};
try { propMeta = JSON.parse(fs.readFileSync(PROP_META_FILE, 'utf8')); } catch (_) {}

// Load discovery-cache and build lookup map for coordinates
let discLookup = new Map();
try {
  if (fs.existsSync(DISC_FILE)) {
    const dc = JSON.parse(fs.readFileSync(DISC_FILE, 'utf8'));
    for (const propId in dc) {
      const entry = dc[propId];
      const items = [...(entry.results || []), ...(entry.fullMarket || [])];
      for (const item of items) {
        if (item.lat && item.lng) {
          discLookup.set(item.id, { lat: item.lat, lng: item.lng });
          if (item.slug) {
            discLookup.set(item.slug, { lat: item.lat, lng: item.lng });
          }
        }
      }
    }
  }
} catch (_) {}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; })
);
const CHECK_ONLY  = !!args.check;
const MERGE       = !!args.merge;
const NO_DISCOVER = !!args['no-discover'];
const FORCE       = !!args.force;
const MAX_COMPS   = parseInt(args['max-competitors'] || '10', 10);
const OFFLINE     = !!args.offline || !!args['cache-only'];
const RESET_COMPS = !!args['reset-competitors'];

// ── CSV parser ────────────────────────────────────────────────────────────────
// Line splitting, Windows-1252 fallback decoding, slug extraction, ID normalisation and the
// header-alias table all live in lib/csv-properties.js — four scripts had grown their own
// copies and they had already begun to disagree (this file's slug regex did not stop at '#').
//
// What stays here is the row-object view and the multi-unit grouping, which is this script's
// own concern: `readProperties()` collapses repeated Property IDs to one row on purpose, but
// the import needs to SEE every unit row to derive a shared base name via pickBaseName().
function parseCSV(text) {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
}

/** First non-empty value among a header's aliases, so the alias list stays in the lib. */
function byAlias(r, aliases) {
  for (const a of aliases) { const v = (r[a] || '').trim(); if (v) return v; }
  return '';
}

// ── Display-name helpers ──────────────────────────────────────────────────────
function csvDisplayName(r) {
  return byAlias(r, HEADER_ALIASES.name);
}
// "Amber @ Golden Triangle" -> "Golden Triangle"
function stripUnitPrefix(name) {
  const i = name.lastIndexOf('@');
  return (i >= 0 ? name.slice(i + 1) : name).trim();
}
// "Mudra Manor - 4BR" -> "Mudra Manor"
function stripSizeSuffix(name) {
  return name.replace(/[\s,-]+\d+\s*(?:BR|BHK|BED(?:ROOM)?S?)\b\.?$/i, '').trim();
}
// Collapse several unit names down to the name they share. Rows that are already
// base names (no "@") win outright; otherwise derive the base from each unit row.
function pickBaseName(names) {
  const bare = names.filter(n => !n.includes('@'));
  const pool = (bare.length ? bare : names.map(stripUnitPrefix))
    .map(stripSizeSuffix)
    .filter(Boolean);
  if (!pool.length) return names[0];
  pool.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return pool[0];
}

// ── URL / ID helpers ──────────────────────────────────────────────────────────
const extractSlug = slugFromUrl;   // lib/csv-properties.js — the one slug regex
function toId(slug) { return slug.replace(/-/g, '_'); }
function autoName(slug) {
  return slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
function slugFromCandidate(c) {
  if (c.url) {
    const m = c.url.match(/\/hotel\/[a-z]{2}\/([^.?/#]+)/i);
    if (m) return m[1];
  }
  return c.id.replace(/_/g, '-');
}

// ── Parse & validate CSV ──────────────────────────────────────────────────────
if (!fs.existsSync(CSV_FILE)) {
  console.error('properties.csv not found:', CSV_FILE);
  process.exit(1);
}

// ── Share links: canonicalise the sheet before parsing ────────────────────────
// A booking.com/Share-xxxx link is a redirect stub carrying no hotel slug, so the parse below
// cannot key an entry from it and the row used to hard-fail with "Cannot parse Booking.com
// slug" — every property in the sheet arrived that way once (BUG-001). Recovering the slug is
// just a redirect follow, which resolve-property-coords.js already implements alongside the
// coordinate capture, so delegate to it in --links-only mode (no browser) rather than growing
// a second copy of the same fetch here. --check stays read-only and only reports.
function shareLinkIds() {
  const text = readCSVText(CSV_FILE).text;
  const lines = text.replace(/\r/g, '').split('\n');
  const headers = parseCSVLine(lines[0] || '');
  const pick = names => { for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; } return -1; };
  const idIdx = pick(HEADER_ALIASES.id), urlIdx = pick(HEADER_ALIASES.url);
  if (idIdx < 0 || urlIdx < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const v = parseCSVLine(lines[i]);
    const id = (v[idIdx] || '').trim(), url = (v[urlIdx] || '').trim();
    if (id && url && !slugFromUrl(url)) out.push(normaliseId(id));
  }
  return out;
}

const shareRows = shareLinkIds();
if (shareRows.length && !CHECK_ONLY && !args['no-resolve']) {
  console.log(`\n  ${shareRows.length} row(s) have a link with no hotel slug (${shareRows.join(', ')}).`);
  console.log('  Resolving them to canonical Booking.com URLs first…');
  try {
    require('child_process').execFileSync(
      process.execPath,
      [path.join(__dirname, 'resolve-property-coords.js'), '--links-only', '--write-csv'],
      { stdio: 'inherit' },
    );
  } catch (e) {
    console.log(`\n  ⚠ Link resolution failed (${e.message.split('\n')[0]}).`);
    console.log('    Run: node resolve-property-coords.js --links-only --write-csv');
  }
}

const { text: csvText, encoding: csvEncoding } = readCSVText(CSV_FILE);
if (csvEncoding !== 'utf-8') {
  console.log(`\n  ℹ properties.csv is not valid UTF-8 — decoded as ${csvEncoding}.`);
}

const rows     = parseCSV(csvText);
const errors   = [];
const warnings = [];
const ownProps = [];
const manualCompetitorsMap = new Map();

// ── Pass 1: group own rows by Property ID ─────────────────────────────────────
const ownGroups  = new Map();                       // ownId -> group
const rowOwnerId = new Array(rows.length).fill(null);

for (let i = 0; i < rows.length; i++) {
  const r       = rows[i];
  const lineNum = i + 2;
  const propIdCol = byAlias(r, HEADER_ALIASES.id);
  if (!propIdCol) continue;

  const url = byAlias(r, HEADER_ALIASES.url);
  if (!url) { errors.push(`Row ${lineNum}: Own Link / Booking.com Link is empty`); continue; }
  const slug = extractSlug(url);
  if (!slug) {
    // Reached only when resolution was skipped (--check / --no-resolve) or could not recover
    // the slug. Say what fixes it — a bare "cannot parse" left the user with no next step.
    errors.push(`Row ${lineNum}: no Booking.com hotel slug in "${url}"`
      + '\n           → run: node resolve-property-coords.js --links-only --write-csv');
    continue;
  }

  // A real Property ID column keys the entry; a bare "Sr." row number does not — that is a
  // spreadsheet ordinal, not an identity, so those fall back to the slug.
  const hasCustomId = r['Property ID'] || r['Property ID (according to our System)'];
  const ownId = hasCustomId ? normaliseId(propIdCol) : toId(slug);

  let g = ownGroups.get(ownId);
  if (!g) {
    g = { ownId, slug, url, r, firstLine: lineNum, names: [], lines: [], slugs: new Set() };
    ownGroups.set(ownId, g);
  }
  const nm = csvDisplayName(r);
  if (nm && !g.names.includes(nm)) g.names.push(nm);
  g.lines.push(lineNum);
  g.slugs.add(slug);
  rowOwnerId[i] = ownId;
}

// ── Pass 2: one config entry per Property ID ──────────────────────────────────
for (const g of ownGroups.values()) {
  // Several rows sharing an ID normally means room categories of one listing. If
  // the links differ they are separate properties filed under one ID — a CSV data
  // error we cannot resolve here, so keep the first and say what was skipped.
  if (g.slugs.size > 1) {
    warnings.push(
      `Property ID ${g.ownId} maps to ${g.slugs.size} different Booking.com listings ` +
      `(lines ${g.lines.join(', ')}). Tracking only "${g.slug}" from line ${g.firstLine}; ` +
      `skipped: ${[...g.slugs].filter(s => s !== g.slug).join(', ')}. ` +
      `Give the others their own Property ID to track them.`
    );
  }

  const meta = propMeta[g.ownId] || propMeta[toId(g.slug)] || {};

  // Attempt to resolve coordinates locally first
  let lat = null, lng = null;
  if (geoCache[g.ownId]) {
    lat = geoCache[g.ownId].lat;
    lng = geoCache[g.ownId].lng;
  } else if (meta.lat && meta.lon) {
    lat = meta.lat;
    lng = meta.lon;
  } else if (discLookup.has(g.ownId)) {
    lat = discLookup.get(g.ownId).lat;
    lng = discLookup.get(g.ownId).lng;
  } else if (discLookup.has(g.slug)) {
    lat = discLookup.get(g.slug).lat;
    lng = discLookup.get(g.slug).lng;
  }

  const location = (g.r['Location'] || g.r['City'] || '').trim() || meta.city || (lat ? 'Unknown' : 'TBD');
  const display  = g.names.length > 1 ? pickBaseName(g.names)
                 : (g.names[0] || autoName(g.slug));

  const ownEntry = {
    id:           g.ownId,
    slug:         g.slug,
    type:         'own',
    display,
    location,
    city:         location,
    country:      'IN',
    propertyType: 'villa',
    match:        g.ownId.replace(/_/g, ' '),
    competitors:  [],
    deal:         0,               // Deal % not required
    beds:         1,
    pax:          2,
    amenities:    [],
  };
  // Keep the individual unit names so collapsing the rows loses nothing
  if (g.names.length > 1) ownEntry.units = g.names.slice();
  if (lat) ownEntry.lat = lat;
  if (lng) ownEntry.lng = lng;

  ownProps.push(ownEntry);
}

// ── Pass 3: manual competitor rows attach to the own property above them ──────
const ownById = new Map(ownProps.map(o => [o.id, o]));
let currentOwnId = null;

for (let i = 0; i < rows.length; i++) {
  if (rowOwnerId[i]) { currentOwnId = rowOwnerId[i]; continue; }
  const r       = rows[i];
  const lineNum = i + 2;
  // A row with an ID that reached here failed validation above — not a competitor
  if ((r['Property ID'] || r['Property ID (according to our System)'] || r['Sr.'] || r['Sr'] || '').trim()) continue;

  const compName = (r['Location'] || r['City'] || '').trim();
  const compUrl  = (r['Competitor Link'] || r['Deal % (own)'] || r['Deal %'] || '').trim();
  if (!compName || !compUrl) continue;

  const slug = extractSlug(compUrl);
  if (!slug) {
    warnings.push(`Row ${lineNum}: competitor "${compName}" — cannot parse Booking.com slug, skipped`);
    continue;
  }
  if (!currentOwnId || !ownById.has(currentOwnId)) {
    warnings.push(`Row ${lineNum}: competitor "${compName}" has no own property above it, skipped`);
    continue;
  }
  if (!manualCompetitorsMap.has(currentOwnId)) manualCompetitorsMap.set(currentOwnId, []);
  manualCompetitorsMap.get(currentOwnId).push({ id: toId(slug), slug, name: compName, url: compUrl });
}

// ── Own-portfolio guard ───────────────────────────────────────────────────────
// Every slug/id we own, so a candidate that is really one of our own properties can never be
// linked as a competitor. Properties 5 and 6 share a building, so each turned up in the other's
// market scan and was linked — rate-shopping a property against itself skews price index, rank
// and the suggestions engine. discover.js now tags these, but a cache written before that fix
// still contains them, and carryOverCompetitors would preserve the bad link regardless.
// Declared here so both the carry-over path and the discovery path can see it.
const OWN_SLUGS = new Set(ownProps.map(p => String(p.slug || '').toLowerCase()).filter(Boolean));
const OWN_IDS   = new Set(ownProps.map(p => String(p.id)));

function isOwnPortfolio(candidate, slug) {
  if (candidate && candidate.isOwnPortfolio) return true;
  if (slug && OWN_SLUGS.has(String(slug).toLowerCase())) return true;
  if (candidate && candidate.id != null && OWN_IDS.has(String(candidate.id))) return true;
  return false;
}

// Is this competitor id actually one of our own properties?
function compIdIsOwn(cid) {
  const s = String(cid).toLowerCase();
  if (OWN_IDS.has(String(cid))) return true;
  if (OWN_SLUGS.has(s)) return true;
  if (OWN_SLUGS.has(s.replace(/_/g, '-'))) return true;   // ids are the underscored slug
  return false;
}

if (errors.length) {
  console.error('\n  Errors in properties.csv:\n');
  errors.forEach(e => console.error('  •', e));
  process.exit(1);
}
if (!ownProps.length) {
  console.error('No own properties found in properties.csv');
  process.exit(1);
}

// ── CSV report ────────────────────────────────────────────────────────────────
const ownRowCount   = rowOwnerId.filter(Boolean).length;
const collapsed     = [...ownGroups.values()].filter(g => g.lines.length > 1);
const collapsedRows = collapsed.reduce((s, g) => s + g.lines.length - 1, 0);
const manualCount   = [...manualCompetitorsMap.values()].reduce((s, v) => s + v.length, 0);
const noLocation    = ownProps.filter(p => p.location === 'TBD');

console.log(`\n  properties.csv (${csvEncoding}): ${rows.length} non-blank rows`);
console.log(`    ${ownRowCount} own-property rows → ${ownProps.length} unique Property IDs`);
console.log(`    ${collapsedRows} unit rows collapsed into ${collapsed.length} parent IDs (kept in "units")`);
console.log(`    ${manualCount} manual competitor rows`);

if (warnings.length) {
  console.log(`\n  ⚠ ${warnings.length} warning(s):`);
  warnings.forEach(w => console.log('    •', w));
}
if (noLocation.length) {
  // 'TBD' becomes the Booking.com search term, so discovery for these is unreliable
  console.log(`\n  ⚠ ${noLocation.length} property(ies) have no Location in the CSV and none in property-meta.json.`);
  console.log('    Discovery will fall back to coordinates where available:');
  noLocation.forEach(p => console.log(`      ${p.id}  ${p.display}  — coords: ${p.lat ? 'yes' : 'NO'}`));
}

// ── Scope: the whole CSV, or a single property ─────────────────────────────────
const ONLY_ID = typeof (args.property || args.only) === 'string'
  ? String(args.property || args.only).trim()
  : null;

let targetOwn = ownProps;
if (ONLY_ID) {
  targetOwn = ownProps.filter(o => o.id === ONLY_ID);
  if (!targetOwn.length) {
    console.error(`\n  --property=${ONLY_ID}: no row with that Property ID in properties.csv`);
    console.error(`  First 20 IDs present: ${ownProps.slice(0, 20).map(o => o.id).join(', ')}\n`);
    process.exit(1);
  }
  console.log(`\n  --property=${ONLY_ID}: processing "${targetOwn[0].display}" only.`);
  console.log('  Every other entry in config/properties.json is left untouched.');
}

if (CHECK_ONLY) {
  console.log(`\n  ✓ Validation OK: ${targetOwn.length} own propert${targetOwn.length === 1 ? 'y' : 'ies'}`);
  if (!ONLY_ID && collapsed.length) {
    console.log('\n  Collapsed unit groups:');
    collapsed.forEach(g => {
      const o = ownById.get(g.ownId);
      console.log(`    ${g.ownId}  "${o.display}"`);
      g.names.forEach(n => console.log(`        └─ ${n}`));
    });
  }
  console.log('');
  targetOwn.forEach(o => {
    console.log(`    ${o.id}  ${o.display} — ${o.city}${o.lat ? '' : '  (no coords)'}`);
    (manualCompetitorsMap.get(o.id) || []).forEach(c => console.log(`        └─ competitor: ${c.name}`));
  });
  process.exit(0);
}

// ── Merge with existing config to preserve enriched fields ────────────────────
let existingConfig = { properties: [] };
if (fs.existsSync(CONFIG_FILE)) {
  try { existingConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
}
const existingMap = new Map(existingConfig.properties.map(p => [p.id, p]));

// Fields that are not in the CSV and must be preserved from existing config
const PRESERVE_FIELDS = ['propertyType', 'beds', 'pax', 'amenities', 'lat', 'lng', 'rating'];

function mergeOwnEntry(newEntry) {
  const existing = existingMap.get(newEntry.id);
  if (!existing) return newEntry;
  const merged = { ...newEntry };
  for (const f of PRESERVE_FIELDS) {
    const ev = existing[f];
    if (ev === undefined || ev === null || ev === '') continue;
    if (Array.isArray(ev) && ev.length === 0) continue;
    if (f === 'beds' && ev === 1) continue;
    if (f === 'pax'  && ev === 2) continue;
    merged[f] = ev;
  }
  return merged;
}

// Entries this run is not rewriting must survive verbatim. Under --property that
// is every other property in the file; under a full import it is nothing.
const untouched = ONLY_ID
  ? existingConfig.properties.filter(p => p.id !== targetOwn[0].id)
  : [];

function assemble(rewritten) {
  const byId = new Map(untouched.map(p => [p.id, p]));
  for (const p of rewritten) byId.set(p.id, p);
  return [...byId.values()];
}

// Competitor links live in config, not in the CSV, so a re-import has to carry
// them over or every property silently loses its competitors. Only carry a link
// whose competitor entry also exists, so the output never has a dangling ref.
function carryOverCompetitors(ownEntries) {
  const extra = [];
  const have  = new Set([...untouched.map(p => p.id), ...ownEntries.map(p => p.id)]);
  let links = 0, dropped = 0, ownDropped = 0;
  for (const own of ownEntries) {
    const prev = existingMap.get(own.id);
    if (!prev?.competitors?.length) continue;
    for (const cid of prev.competitors) {
      // A previous run may have linked one of our own properties; don't preserve that
      if (compIdIsOwn(cid)) { ownDropped++; continue; }
      const compEntry = existingMap.get(cid);
      if (!compEntry) { dropped++; continue; }
      if (!have.has(cid)) { have.add(cid); extra.push({ ...compEntry }); }
      if (!own.competitors.includes(cid)) { own.competitors.push(cid); links++; }
    }
  }
  return { extra, links, dropped, ownDropped };
}

// ── Write helpers ─────────────────────────────────────────────────────────────
function writeConfig(properties) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const payload = JSON.stringify({
    version:   '2.0',
    updatedAt: new Date().toISOString(),
    properties,
  }, null, 2);
  // Write-then-rename: an interrupted run can never leave a truncated config
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, CONFIG_FILE);
}

// Keep this many timestamped config backups. Every import wrote one and none were ever
// removed, so config/ accumulated a copy of the whole property set per run — 36 KB each with
// the current portfolio, and it had reached 4 MB against the old 737-property one.
const KEEP_BACKUPS = 5;

function backupConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dest  = `${CONFIG_FILE.replace(/\.json$/, '')}.${stamp}.bak.json`;
  fs.copyFileSync(CONFIG_FILE, dest);
  pruneOldBackups();
  return dest;
}

/** Drop all but the newest KEEP_BACKUPS timestamped backups. */
function pruneOldBackups() {
  try {
    const dir = path.dirname(CONFIG_FILE);
    const base = path.basename(CONFIG_FILE, '.json');
    const old = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.') && f.endsWith('.bak.json'))
      .sort()                       // the stamp is lexicographically ordered
      .slice(0, -KEEP_BACKUPS);
    for (const f of old) fs.unlinkSync(path.join(dir, f));
    if (old.length) console.log(`  ↩ Pruned ${old.length} old config backup(s), keeping the newest ${KEEP_BACKUPS}.`);
  } catch (_) { /* backup hygiene must never fail an import */ }
}

function lookupCoords(id, slug) {
  if (discLookup.has(id))   return discLookup.get(id);
  if (discLookup.has(slug)) return discLookup.get(slug);
  if (geoCache[id])         return geoCache[id];
  return null;
}

// Manual competitors come straight from the CSV and need no scraping, so attach
// them in Phase 1 — otherwise --no-discover would silently drop them.
function attachManualCompetitors(world) {
  let added = 0, linked = 0, skippedOwn = 0;
  for (const own of world.own) {
    const ownEntry = world.propMap.get(own.id);
    for (const c of manualCompetitorsMap.get(own.id) || []) {
      // A CSV competitor row pointing at one of our own listings would rate-shop us against
      // ourselves, so skip it here too rather than trusting the sheet
      if (isOwnPortfolio(c, c.slug)) { skippedOwn++; continue; }
      if (!world.allIds.has(c.id)) {
        world.allIds.add(c.id);
        const entry = {
          id:           c.id,
          slug:         c.slug,
          type:         'comp',
          display:      c.name,
          location:     own.city,
          city:         own.city,
          country:      'IN',
          propertyType: 'property',
          match:        c.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
          competitors:  [],
          deal:         0,
          beds:         1,
          pax:          2,
          amenities:    [],
        };
        const geo = lookupCoords(c.id, c.slug);
        if (geo?.lat) { entry.lat = geo.lat; entry.lng = geo.lng; }
        world.allProps.push(entry);
        world.propMap.set(entry.id, entry);
        added++;
      }
      if (!ownEntry.competitors.includes(c.id)) { ownEntry.competitors.push(c.id); linked++; }
    }
  }
  return { added, linked, skippedOwn };
}

// ── Phase 1: seed config ──────────────────────────────────────────────────────
if (MERGE) console.log('\n  ℹ --merge is now the default; pass --reset-competitors for the old behaviour.');

const mergedOwn = targetOwn.map(mergeOwnEntry);
const carried   = RESET_COMPS
  ? { extra: [], links: 0, dropped: 0 }
  : carryOverCompetitors(mergedOwn);

// Shared working state for Phase 1 and Phase 2
const world = {
  own:      mergedOwn,
  allProps: [...mergedOwn, ...carried.extra],
  allIds:   new Set([...untouched.map(p => p.id), ...mergedOwn.map(p => p.id), ...carried.extra.map(p => p.id)]),
  propMap:  new Map(),
};
[...untouched, ...world.allProps].forEach(p => world.propMap.set(p.id, p));

const manual = attachManualCompetitors(world);

const backupPath = backupConfig();
if (backupPath) console.log(`\n  ↩ Previous config backed up to config/${path.basename(backupPath)}`);

// discover.js reads config/properties.json, so config must be on disk before the
// scan starts. Seed it with the own props *and* their competitors so an
// interrupted scan leaves a usable config rather than one with no competitors.
writeConfig(assemble(world.allProps));
console.log(`  ✓ config/properties.json: ${mergedOwn.length} own propert${mergedOwn.length === 1 ? 'y' : 'ies'} written`
  + (ONLY_ID ? `, ${untouched.length} existing entries preserved` : '')
  + (carried.links ? `, ${carried.links} competitor link(s) carried over` : '')
  + (manual.linked ? `, ${manual.linked} manual competitor link(s) from CSV` : ''));
if (carried.dropped) {
  console.log(`  ⚠ ${carried.dropped} stale competitor link(s) dropped — no matching entry in config`);
}
if (carried.ownDropped) {
  console.log(`  ⚠ ${carried.ownDropped} competitor link(s) dropped — they are our own properties, not competitors`);
}

if (NO_DISCOVER) {
  console.log('\n  --no-discover: skipping competitor discovery.');
  for (const own of mergedOwn) {
    const o = world.propMap.get(own.id);
    console.log(`\n    ${o.display} (${o.city}) — ${o.competitors.length} competitors`);
    o.competitors.forEach(cid => console.log(`        └─ ${world.propMap.get(cid)?.display || cid}`));
    if (!o.competitors.length) console.log('        └─ (none)');
  }
  console.log('\n  Run without --no-discover to auto-discover more competitors.\n');
  process.exit(0);
}

// ── Phase 2: discover competitors ─────────────────────────────────────────────
// Load discovery cache once at startup to avoid repeated disk reads of the large 26MB file
let discData = {};
try {
  if (fs.existsSync(DISC_FILE)) {
    discData = JSON.parse(fs.readFileSync(DISC_FILE, 'utf8'));
  }
} catch (_) {}

// Cached at all, regardless of age — --force is the only way to re-scan
function isCached(propId) {
  return !!discData[propId];
}

// discData is a snapshot taken before any scan runs, so a property that was just
// scanned is still missing from it and pickTopCompetitors would silently return
// nothing. Re-read that one property's entry from disk after a successful scan.
function reloadDiscEntry(propId) {
  try {
    const fresh = JSON.parse(fs.readFileSync(DISC_FILE, 'utf8'));
    if (fresh[propId]) discData[propId] = fresh[propId];
    return !!fresh[propId];
  } catch (_) { return false; }
}

function runDiscover(propId) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['discover.js', `--property=${propId}`, '--force'], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'status')  process.stdout.write(`    ${obj.message}\n`);
          if (obj.type === 'done')    process.stdout.write(`    ✓ ${obj.message}\n`);
          if (obj.type === 'error')   process.stdout.write(`    ✗ ${obj.message}\n`);
        } catch (_) {}
      });
    });
    child.stderr.on('data', chunk => {
      chunk.toString().split('\n').filter(Boolean)
        .forEach(l => process.stderr.write(`    ERR: ${l}\n`));
    });
    child.on('close', code => resolve(code === 0));
  });
}

function pickTopCompetitors(propId) {
  try {
    const entry = discData[propId];
    if (!entry?.results?.length) return [];
    // Drop our own properties before the high/medium split, so they can't consume a slot
    const ranked = entry.results.filter(r => !isOwnPortfolio(r, slugFromCandidate(r)));
    const high   = ranked.filter(r => r.confidence === 'high');
    const medium = ranked.filter(r => r.confidence === 'medium');
    const picked = [...high];
    for (const m of medium) {
      if (picked.length >= MAX_COMPS) break;
      picked.push(m);
    }
    return picked.slice(0, MAX_COMPS);
  } catch (_) { return []; }
}

async function main() {
  const { allProps, allIds, propMap } = world;

  for (const own of mergedOwn) {
    console.log(`\n  ─── ${own.display} (${own.city}) ───`);

    const ownEntry = propMap.get(own.id);

    // Manual competitors from the CSV were already attached in Phase 1
    const manualComps = manualCompetitorsMap.get(own.id) || [];

    // 2. Discover auto-competitors
    let top = [];
    if (OFFLINE) {
      console.log('    Offline mode: using cached discovery results only.');
      top = pickTopCompetitors(own.id);
    } else if (!FORCE && isCached(own.id)) {
      console.log('    Already present in discovery-cache.json — using those results.');
      console.log('    Pass --force to re-scan Booking.com.');
      top = pickTopCompetitors(own.id);
    } else {
      console.log('    Running Booking.com market scan…');
      const ok = await runDiscover(own.id);
      if (!ok) {
        console.warn(`    ⚠ Discovery failed for "${own.id}" — using cache if available.`);
      }
      // Pick up what the scan just wrote, otherwise the results are ignored
      if (!reloadDiscEntry(own.id)) {
        console.warn(`    ⚠ No discovery results found in cache for "${own.id}" after the scan.`);
      }
      top = pickTopCompetitors(own.id);
    }

    let addedCount = 0;
    for (const c of top) {
      const slug   = slugFromCandidate(c);
      const compId = toId(c.id);

      if (!allIds.has(compId)) {
        allIds.add(compId);
        const entry = {
          id:           compId,
          slug,
          type:         'comp',
          display:      c.name,
          location:     own.city,
          city:         own.city,
          country:      'IN',
          propertyType: c.type || 'property',
          match:        c.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
          competitors:  [],
          deal:         0,
          beds:         c.beds || 1,
          pax:          2,
          amenities:    [],
        };
        
        let lat = c.lat || null;
        let lng = c.lng || null;
        let rating = c.rating || null;
        
        if (!lat) {
          if (discLookup.has(compId)) {
            lat = discLookup.get(compId).lat;
            lng = discLookup.get(compId).lng;
          } else if (discLookup.has(slug)) {
            lat = discLookup.get(slug).lat;
            lng = discLookup.get(slug).lng;
          } else if (geoCache[compId]) {
            lat = geoCache[compId].lat;
            lng = geoCache[compId].lng;
          }
        }
        
        const existingComp = existingMap.get(compId);
        if (existingComp) {
          if (!lat && existingComp.lat) {
            lat = existingComp.lat;
            lng = existingComp.lng;
          }
          if (!rating && existingComp.rating) {
            rating = existingComp.rating;
          }
          if (existingComp.propertyType) entry.propertyType = existingComp.propertyType;
          if (existingComp.beds) entry.beds = existingComp.beds;
          if (existingComp.pax) entry.pax = existingComp.pax;
          if (existingComp.amenities?.length) entry.amenities = existingComp.amenities;
        }

        if (lat) entry.lat = lat;
        if (lng) entry.lng = lng;
        if (rating) entry.rating = rating;
        allProps.push(entry);
        propMap.set(entry.id, entry);
      } else {
        const existing = propMap.get(compId);
        if (existing && existing.lat == null) {
          let lat = c.lat || null;
          let lng = c.lng || null;
          if (!lat) {
            if (discLookup.has(compId)) {
              lat = discLookup.get(compId).lat;
              lng = discLookup.get(compId).lng;
            } else if (discLookup.has(slug)) {
              lat = discLookup.get(slug).lat;
              lng = discLookup.get(slug).lng;
            } else if (geoCache[compId]) {
              lat = geoCache[compId].lat;
              lng = geoCache[compId].lng;
            }
          }
          if (!lat) {
            const existingComp = existingMap.get(compId);
            if (existingComp && existingComp.lat) {
              lat = existingComp.lat;
              lng = existingComp.lng;
            }
          }
          if (lat) {
            existing.lat = lat;
            existing.lng = lng;
          }
        }
      }

      if (!ownEntry.competitors.includes(compId)) {
        ownEntry.competitors.push(compId);
        addedCount++;
      }
    }

    const manualCount = manualComps.length;
    console.log(`    ✓ Done: ${manualCount} manual competitors, ${addedCount} auto-discovered competitors assigned`);
  }

  const finalProps = assemble(allProps);
  writeConfig(finalProps);

  const ownCount  = finalProps.filter(p => p.type === 'own').length;
  const compCount = finalProps.filter(p => p.type === 'comp').length;
  console.log(`\n  ✓ config/properties.json: ${ownCount} own properties, ${compCount} total competitor entries`);

  // Referential integrity: every competitor link must resolve to an entry
  const finalIds = new Set(finalProps.map(p => p.id));
  const dangling = [];
  finalProps.filter(p => p.type === 'own')
    .forEach(p => (p.competitors || []).forEach(c => { if (!finalIds.has(c)) dangling.push(`${p.id}->${c}`); }));
  console.log(`  ${dangling.length ? '⚠' : '✓'} competitor references: ${dangling.length} dangling`
    + (dangling.length ? ` (${dangling.slice(0, 5).join(', ')})` : ''));

  console.log('\n  Summary:');
  for (const own of mergedOwn) {
    const o = propMap.get(own.id);
    console.log(`\n    ${o.display} (${o.city}) — ${o.competitors.length} competitors`);
    o.competitors.forEach(cid => {
      const cp = propMap.get(cid);
      console.log(`        └─ ${cp?.display || cid}`);
    });
    if (!o.competitors.length) console.log('        └─ (none found)');
  }
  console.log(`\n  Next: node refresh.js${ONLY_ID ? ` --property=${ONLY_ID}` : ''}   to scrape fresh prices.\n`);
}

main().catch(e => { console.error('\n  Error:', e.message); process.exit(1); });
