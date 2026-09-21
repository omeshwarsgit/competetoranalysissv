'use strict';
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const zlib    = require('zlib');
const { spawn } = require('child_process');
const { saveManual, getAllCached } = require('./lib/geocode');
const { getUpcomingLongWeekends }  = require('./lib/holidays');
const { readProperties }           = require('./lib/csv-properties');
const { clusterProperties, unionPools, rescopeForProperty, haversineKm } = require('./lib/market-pool');

/** Kilometres between two lat/lng pairs, or null when either side is unknown. */
function distanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v == null || !Number.isFinite(Number(v)))) return null;
  return Math.round(haversineKm({ lat: Number(lat1), lng: Number(lng1) },
                                { lat: Number(lat2), lng: Number(lng2) }) * 100) / 100;
}

// Port: --port=NNNN wins over PORT, which wins over the default. The flag exists because every
// other script here takes --flags, and `PORT=3199 node serve.js` is not portable across the
// PowerShell / cmd / bash shells this project is driven from.
const portArg        = process.argv.find(a => a.startsWith('--port='));
const PORT           = parseInt(portArg ? portArg.slice('--port='.length) : (process.env.PORT || '3000'), 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`  Invalid port: "${portArg ? portArg.slice(7) : process.env.PORT}". Use --port=3000 or PORT=3000.`);
  process.exit(1);
}
// Opening a browser is right for a human double-clicking the shortcut, but wrong for a
// scheduled task, a CI/verification run, or a headless box — those would spawn a window
// nobody closes. `--no-open` / NO_OPEN=1 suppresses it.
const NO_OPEN        = process.argv.includes('--no-open') || process.env.NO_OPEN === '1';
const FILE           = path.join(__dirname, 'dashboard', 'index.html');
const DASHBOARD_DATA = path.join(__dirname, 'data', 'latest.dashboard.json');
const META_FILE      = path.join(__dirname, 'data', 'latest.meta.json');
const DISCOVERY_FILE = path.join(__dirname, 'data', 'discovery-cache.json');
const PROP_META_FILE = path.join(__dirname, 'data', 'property-meta.json');
const CONFIG_FILE    = path.join(__dirname, 'config', 'properties.json');
const CSV_FILE       = path.join(__dirname, 'properties.csv');
const HISTORY_DIR    = path.join(__dirname, 'data', 'history');
const INVENTORY_LOG  = path.join(__dirname, 'data', 'inventory-log.json');

// ── Optional API key auth (set API_KEY env var to enable) ────────────────────
const API_KEY = process.env.API_KEY || null;

function parseCookies(cookieHeader) {
  const out = {};
  (cookieHeader || '').split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  });
  return out;
}

function isAuthed(req) {
  if (!API_KEY) return true;
  if (req.headers['x-api-key'] === API_KEY) return true;
  if (parseCookies(req.headers.cookie)['sv-key'] === API_KEY) return true;
  const url = new URL('http://x' + req.url);
  if (url.searchParams.get('key') === API_KEY) return true;
  return false;
}

// ── Request body reader with size limit ───────────────────────────────────────
function readBody(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Request body too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseBody(raw) {
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

// ── In-memory JSON cache (mtime-based) ───────────────────────────────────────
// Capped, because /api/history reads every dated snapshot through here to list them. With 90 days
// of retention that pinned ~90 parsed payloads in memory for the life of the process, none of
// which is ever needed again once the list is built.
const _jsonCache = new Map();          // insertion-ordered: the first key is the oldest
const JSON_CACHE_MAX = 12;
function readJsonCached(file) {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = _jsonCache.get(file);
    if (hit && hit.mtime === mtime) {
      _jsonCache.delete(file); _jsonCache.set(file, hit);   // mark as most recently used
      return hit.data;
    }
    const entry = { data: JSON.parse(fs.readFileSync(file, 'utf8')), mtime };
    _jsonCache.delete(file);
    _jsonCache.set(file, entry);
    while (_jsonCache.size > JSON_CACHE_MAX) _jsonCache.delete(_jsonCache.keys().next().value);
    return entry.data;
  } catch (_) { return null; }
}
function invalidateCache(file) { _jsonCache.delete(file); }

/** Parse a JSON file without touching the shared cache (one-shot reads, e.g. listing history). */
function readJsonUncached(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// Write-then-rename, so a crash or a full disk can never leave a half-written JSON file where a
// valid one used to be. The discovery cache is 2.4 MB and four scripts JSON.parse it whole; a
// truncated write there takes the map, the Discover panel and the next scan down together.
function writeJsonAtomic(file, data, pretty = true) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  fs.renameSync(tmp, file);
  invalidateCache(file);
}

/**
 * Read-modify-write the discovery cache from DISK, not from the read cache.
 *
 * readJsonCached() hands back the very object it has memoised, so the previous code mutated the
 * cache in place and then wrote the whole file back. Two problems: a concurrent discover.js run
 * (which the Discover panel triggers on its own) had its changes silently overwritten, and a
 * failed write left the in-memory copy already mutated, so the server went on serving data that
 * was never persisted.
 */
function updateDiscoveryCache(mutate) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8')); } catch (_) { all = {}; }
  const result = mutate(all);
  writeJsonAtomic(DISCOVERY_FILE, all);
  return result;
}

// ── Shared location market ───────────────────────────────────────────────────
// Properties in the same region share one discovered inventory. Computed on read and memoised
// against the mtimes of the two inputs, so the ~1,000-listing union is built once per data change
// rather than per request — and never written to disk per property (see /api/discover/full-market).
let _poolCache = null;
function sharedMarketFor(propId, allDisc) {
  const cfg  = readJsonCached(CONFIG_FILE);
  const meta = readJsonCached(PROP_META_FILE) || {};
  if (!cfg) return null;

  let stamp = '';
  try {
    stamp = fs.statSync(DISCOVERY_FILE).mtimeMs + ':' + fs.statSync(CONFIG_FILE).mtimeMs;
  } catch (_) { stamp = String(Date.now()); }

  if (!_poolCache || _poolCache.stamp !== stamp) {
    const owns = (cfg.properties || []).filter(p => p.type === 'own');
    const clusters = clusterProperties(owns, meta);
    const ownSlugs = new Set(owns.map(p => String(p.slug || '').toLowerCase()).filter(Boolean));
    const byProp = new Map();
    for (const { key, propIds } of clusters) {
      const pools = propIds.filter(id => allDisc[id]).map(id => allDisc[id].fullMarket || []);
      if (propIds.length < 2) continue;                       // nothing to share
      const shared = unionPools(pools, ownSlugs);
      for (const id of propIds) byProp.set(id, { key, propIds, shared });
    }
    _poolCache = { stamp, byProp };
  }

  const hit = _poolCache.byProp.get(propId);
  if (!hit) return null;
  const prop = (cfg.properties || []).find(p => p.id === propId);
  if (!prop) return null;
  // Distances from THIS property, so the shared inventory still ranks locally.
  const fullMarket = rescopeForProperty(hit.shared, prop, 40);
  return {
    fullMarket,
    meta: {
      key: hit.key, propIds: hit.propIds,
      unique: hit.shared.length,
      shown: fullMarket.length,
      ownScan: (allDisc[propId]?.fullMarket || []).length,
    },
  };
}

// ── Audit trail for config-mutating endpoints ────────────────────────────────
// Twice on 2026-08-11 a property's `competitors[]` was emptied — property 1 (12 → 2), then
// properties 2 and 4 (10 → 0 and 15 → 0, with 25 competitor records and their scraped rates pruned
// alongside). Both matched the signature of POST /api/reset-competitors, and both times the caller
// could not be identified afterwards, because nothing recorded who changed what. Scraped rates are
// only observable going forward, so a wrong reset is permanent data loss.
//
// This does not prevent anything — these endpoints are user intent by design. It makes the next
// occurrence attributable in one look: who called, from where, and the before/after counts.
const AUDIT_LOG = path.join(__dirname, 'data', 'config-audit.json');
function auditConfigChange(req, action, detail) {
  try {
    let before = null;
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      before = Object.fromEntries((cfg.properties || [])
        .filter(p => p.type === 'own').map(p => [p.id, (p.competitors || []).length]));
    } catch (_) {}
    const entry = {
      at: new Date().toISOString(),
      action,
      ...detail,
      from: req.socket?.remoteAddress || null,
      userAgent: (req.headers['user-agent'] || '').slice(0, 160),
      referer: req.headers['referer'] || null,
      trackedBefore: before,
    };
    let log = [];
    try { log = JSON.parse(fs.readFileSync(AUDIT_LOG, 'utf8')); } catch (_) {}
    log.unshift(entry);
    writeJsonAtomic(AUDIT_LOG, log.slice(0, 500));
    console.log(`  [audit] ${action} ${JSON.stringify(detail)} ua="${entry.userAgent.slice(0, 60)}"`);
  } catch (e) { console.error('  [audit] failed to record:', e.message); }
}

// ── properties.csv — the authoritative property list ─────────────────────────
// config/properties.json accumulates entries: an `import-properties.js --property=<id>`
// run preserves every other entry, so IDs dropped from the CSV linger there (and in
// latest.dashboard.json) indefinitely. The CSV is the source of truth for *which*
// properties exist, so the dashboard selector is driven from this, parsed live.
//
// The parsing itself lives in lib/csv-properties.js — the CSV contract has too many quirks
// (a column that changes meaning by row, legacy headers, Windows-1252, ID normalisation) to
// keep re-implementing per script. Each row also carries its Booking.com slug, which is what
// lets the dashboard tell whether data filed under a reused Property ID still belongs to it.
let _csvCache = null;
function readCsvProperties() {
  const mtime = fs.statSync(CSV_FILE).mtimeMs;
  if (_csvCache && _csvCache.mtime === mtime) return _csvCache.data;

  const { properties } = readProperties(CSV_FILE);
  const slim = properties.map(p => ({ id: p.id, name: p.name, url: p.url, slug: p.slug }));
  const data = { properties: slim, ids: slim.map(p => p.id), count: slim.length };
  _csvCache = { mtime, data };
  return data;
}

// ── properties.csv writing ────────────────────────────────────────────────────
// Three endpoints append competitor rows to the sheet and each had grown its own copy of this,
// with different bugs: one emitted `,,,"name",url` without escaping a `"` inside the name (which
// corrupts the row and every row after it, since the quote state never closes), one split on '\n'
// without stripping '\r' and then rejoined with bare '\n' (mixing line endings on a file Excel
// wrote as CRLF), and all three re-joined an array whose last element was the empty string after
// a trailing newline, adding one blank line per call.
function csvCell(value) {
  const s = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A competitor row: blank Property ID / Property / Booking.com Link, then name + link. */
function csvCompetitorRow(name, url) {
  return `,,,${csvCell(name)},${csvCell((url || '').split('?')[0])}`;
}

/** Read properties.csv as an array of lines, normalised (no CR, no trailing blank). */
function readCsvLines() {
  return fs.readFileSync(CSV_FILE, 'utf8').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
}

/** Write lines back with exactly one trailing newline, via a temp file so a crash can't truncate. */
function writeCsvLines(lines) {
  const tmp = CSV_FILE + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  fs.renameSync(tmp, CSV_FILE);
  _csvCache = null;
}

// ── Response helpers ──────────────────────────────────────────────────────────
function sendJson(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJsonGzip(req, res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const wantsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (wantsGzip && body.length > 2048) {
    zlib.gzip(Buffer.from(body, 'utf8'), (err, buf) => {
      if (err) { sendJson(res, status, body, headers); return; }
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Encoding': 'gzip',
        ...headers,
      });
      res.end(buf);
    });
  } else {
    sendJson(res, status, body, headers);
  }
}

function send401(res) {
  sendJson(res, 401, { error: 'Unauthorized. Set X-API-Key header or sv-key cookie.' });
}

// ── Refresh state + SSE ───────────────────────────────────────────────────────
let refreshing = false;
let refreshStartedAt = null;
const refreshSSEClients = new Set();

function emitRefreshSSE(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of refreshSSEClients) {
    try { client.write(msg); } catch (_) { refreshSSEClients.delete(client); }
  }
}

// ── Discover jobs ─────────────────────────────────────────────────────────────
const discoverJobs = {};

// ── Scan-All state ────────────────────────────────────────────────────────────
let scanAllJob = null; // { pid, current, total, results, log, startedAt }
const scanAllSSEClients = new Set();

function emitScanAllSSE(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of scanAllSSEClients) {
    try { client.write(msg); } catch (_) { scanAllSSEClients.delete(client); }
  }
}

// ── Child-process stdout, split into whole lines ─────────────────────────────
// A 'data' event is a chunk boundary, not a line boundary: a long discovery log line is
// routinely split across two chunks, which produced two truncated SSE events — one that failed
// the /^START|^DONE/ tests and one bogus fragment. Buffer until a newline actually arrives.
function onLines(stream, handler) {
  let buf = '';
  stream.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();                       // trailing partial line stays buffered
    for (const line of lines) if (line.trim()) handler(line);
  });
  stream.on('end', () => { if (buf.trim()) handler(buf); buf = ''; });
}

// ── Last-resort process guards ───────────────────────────────────────────────
// This is a single-process local tool with no supervisor: an exception escaping a child-process
// event handler or a stray promise rejection would take the whole dashboard down mid-session,
// with the user seeing only a dead browser tab. Log and stay up — a degraded panel beats an
// unreachable server.
process.on('uncaughtException',  e => console.error('  [uncaught]', e && e.stack || e));
process.on('unhandledRejection', e => console.error('  [unhandled rejection]', e && e.stack || e));

// ── Local IP ──────────────────────────────────────────────────────────────────
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // CORS headers for dev convenience
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Auth check (skip for dashboard HTML, SSE and report downloads)
  const isPublic = (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/api/refresh/events')
                    || req.url === '/reports' || req.url.startsWith('/reports/')));
  if (!isPublic && !isAuthed(req)) { send401(res); return; }

  const url = req.url.split('?')[0];

  // ── GET /reports  — index of generated report files ───────────────────────
  if (req.method === 'GET' && url === '/reports') {
    const dir = path.join(__dirname, 'reports');
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter(f => /\.(pdf|html)$/i.test(f))
        .map(f => ({ f, ...fs.statSync(path.join(dir, f)) }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch (_) {}
    const rows = files.map(x => {
      const kb = Math.round(x.size / 1024);
      const when = new Date(x.mtimeMs).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      const isPdf = /\.pdf$/i.test(x.f);
      return `<tr><td>${isPdf ? '📄' : '🌐'} <a href="/reports/${encodeURIComponent(x.f)}"${isPdf ? ' download' : ''}>${x.f}</a></td>`
           + `<td class="n">${kb} KB</td><td>${when}</td>`
           + `<td><a class="btn" href="/reports/${encodeURIComponent(x.f)}?download" download>Download</a>`
           + (isPdf ? ` <a class="btn alt" href="/reports/${encodeURIComponent(x.f)}" target="_blank">Open</a>` : '') + `</td></tr>`;
    }).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<meta charset="utf-8"><title>Reports</title>
<style>body{font:14px/1.6 "Segoe UI",Roboto,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#1a1d21}
h1{font-size:20px;margin:0 0 4px}p{color:#6b7280;font-size:13px;margin:0 0 20px}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;background:#f3f5f7;padding:8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#374151}
td{padding:8px;border-bottom:1px solid #eef1f4}td.n{text-align:right}a{color:#1d4ed8}
.btn{display:inline-block;background:#b45309;color:#fff;padding:4px 11px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:600}
.btn.alt{background:#4b5563}.empty{color:#9ca3af;padding:24px 0}
@media(prefers-color-scheme:dark){body{background:#14171a;color:#e5e7eb}th{background:#1f2429;color:#9ca3af}td{border-color:#252a30}a{color:#7aa2f7}}</style>
<h1>Generated reports</h1><p>Click Download to save, or Open to view in the browser.</p>
${rows ? `<table><thead><tr><th>File</th><th class="n">Size</th><th>Generated</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
       : `<div class="empty">No reports yet — run <code>node build-price-report.js --property=1</code></div>`}`);
    return;
  }

  // ── GET /reports/<file>  — download a generated report ────────────────────
  if (req.method === 'GET' && url.startsWith('/reports/')) {
    const name = path.basename(decodeURIComponent(url.slice('/reports/'.length)));
    const file = path.join(__dirname, 'reports', name);
    // basename() above prevents traversal; confirm the resolved path stays inside reports/
    if (!file.startsWith(path.join(__dirname, 'reports') + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Report not found'); return;
    }
    const isPdf = /\.pdf$/i.test(name);
    // ?download forces a save dialog; otherwise PDFs open in the browser viewer
    const forceDownload = new URL('http://x' + req.url).searchParams.has('download');
    // A quote or newline in the filename would terminate the header value early; Node rejects the
    // whole response for the newline and the browser mis-parses the quote.
    const safeName = name.replace(/["\\\r\n]/g, '_');
    res.writeHead(200, {
      'Content-Type': isPdf ? 'application/pdf' : 'text/html; charset=utf-8',
      'Content-Length': fs.statSync(file).size,
      'Content-Disposition': `${forceDownload ? 'attachment' : 'inline'}; filename="${safeName}"`,
      'Cache-Control': 'no-cache',
    });
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.destroy(); } catch (_) {} });   // file vanished mid-send
    stream.pipe(res);
    return;
  }

  // ── GET /api/latest  (alias: /api/data) ───────────────────────────────────
  if (req.method === 'GET' && (url === '/api/latest' || url === '/api/data')) {
    const data = readJsonCached(DASHBOARD_DATA);
    if (!data) { sendJson(res, 404, { error: 'No dashboard data. Run a refresh first.' }); return; }
    sendJsonGzip(req, res, 200, data);
    return;
  }

  // ── GET /api/config — serves properties.json ───────────────────────────────
  if (req.method === 'GET' && url === '/api/config') {
    const cfg = readJsonCached(CONFIG_FILE);
    if (!cfg) { sendJson(res, 404, { error: 'config/properties.json not found. Run import-properties.js.' }); return; }
    sendJson(res, 200, cfg);
    return;
  }

  // ── GET /api/csv-properties — the property list as it stands in properties.csv ─
  // Drives the dashboard's property selector. Re-parsed whenever the CSV changes,
  // so editing the sheet is immediately reflected without an import or restart.
  if (req.method === 'GET' && url === '/api/csv-properties') {
    try {
      sendJson(res, 200, readCsvProperties());
    } catch (e) {
      sendJson(res, 500, { error: `Could not read properties.csv: ${e.message}` });
    }
    return;
  }

  // ── GET /api/properties ────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/properties') {
    const data = readJsonCached(DASHBOARD_DATA);
    if (!data) { sendJson(res, 404, { error: 'No dashboard data.' }); return; }
    const properties = Object.values(data.portfolio || {}).map(p => ({
      id: p.id,
      name: p.name,
      location: p.location,
      city: p.city,
      propertyType: p.propertyType,
      beds: p.beds,
      pax: p.pax,
      roomCount: Object.keys(p.rooms || {}).length,
      competitorCount: (p.competitors || []).length,
    }));
    sendJson(res, 200, { meta: data.meta, properties });
    return;
  }

  // ── GET /api/history ───────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/history') {
    // Only offer snapshots that still hold portfolio data. `prune-to-csv.js` strips every
    // record for properties absent from the sheet, which can leave a dated file containing
    // nothing but its `meta` — 8 such shells exist from the D-004 prune. Listing those put
    // dates in the History picker that can never produce a comparison. The files are left on
    // disk (they are the audit trail of when a scan ran); they are just not offered.
    const runs = fs.existsSync(HISTORY_DIR)
      ? fs.readdirSync(HISTORY_DIR)
          .filter(n => /\.dashboard\.json$/i.test(n))
          .sort()
          .map(name => {
            // Uncached: this walks every retained snapshot, and caching them would evict the
            // config and dashboard payloads that every other endpoint depends on.
            const snap = readJsonUncached(path.join(HISTORY_DIR, name));
            return {
              file: name,
              date: name.replace(/\.dashboard\.json$/i, ''),
              meta: snap?.meta || {},
              properties: Object.keys(snap?.portfolio || {}).length,
            };
          })
          .filter(r => r.properties > 0)
      : [];
    sendJson(res, 200, { runs });
    return;
  }

  // ── GET /api/history/:date ─────────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/history/')) {
    const dateStr = req.url.replace('/api/history/', '').split('?')[0];
    const histFile = path.join(HISTORY_DIR, `${dateStr}.dashboard.json`);
    if (!fs.existsSync(histFile)) { sendJson(res, 404, { error: 'No snapshot for that date' }); return; }
    sendJsonGzip(req, res, 200, readJsonCached(histFile));
    return;
  }

  // ── GET /api/inventory ─────────────────────────────────────────────────────
  // Inventory churn: what sync-inventory.js has added or delisted, plus the live counts per
  // property. `?propId=` narrows the events to one property.
  if (req.method === 'GET' && url === '/api/inventory') {
    const qPropId = new URL('http://x' + req.url).searchParams.get('propId');
    const runs = readJsonCached(INVENTORY_LOG) || [];
    const disc = readJsonCached(DISCOVERY_FILE) || {};
    const cfg  = readJsonCached(CONFIG_FILE);

    const properties = (cfg?.properties || []).filter(p => p.type === 'own')
      .filter(p => !qPropId || p.id === qPropId)
      .map(p => {
        const pool = disc[p.id]?.fullMarket || [];
        const active = pool.filter(x => (x.status || 'active') === 'active');
        return {
          id: p.id, name: p.display || p.id,
          pool: pool.length,
          active: active.length,
          delisted: pool.length - active.length,
          tracked: (p.competitors || []).length,
          // Absent from the latest scan — candidates only, never confirmed departures.
          missing: active.filter(x => (x.missedScans || 0) > 0).length,
          lastScanAt: disc[p.id]?.fetchedAt || null,
        };
      });

    const events = runs.flatMap(r => (r.events || [])
      .filter(e => !qPropId || e.propId === qPropId)
      .map(e => ({ ...e, runAt: r.runAt })));

    sendJson(res, 200, {
      properties,
      lastRunAt: runs[0]?.runAt || null,
      events: events.slice(0, 200),
      totals: {
        added:    events.filter(e => e.event === 'added').length,
        delisted: events.filter(e => e.event === 'delisted').length,
        moved:    events.filter(e => e.event === 'moved').length,
      },
    });
    return;
  }

  // ── GET /api/holidays ──────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/holidays') {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = getUpcomingLongWeekends(today, 8);
    sendJson(res, 200, { today, longWeekends: upcoming });
    return;
  }

  // ── GET /api/refresh/status ────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/refresh/status') {
    sendJson(res, 200, { refreshing, refreshStartedAt, latest: readJsonCached(META_FILE) });
    return;
  }

  // ── GET /api/refresh/events — SSE ─────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/refresh/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    refreshSSEClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    req.on('close', () => { refreshSSEClients.delete(res); clearInterval(hb); });
    return;
  }

  // ── GET /api/meta ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/meta') {
    sendJson(res, 200, readJsonCached(PROP_META_FILE) || {});
    return;
  }

  // ── GET /api/geocode/all ───────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/geocode/all') {
    sendJson(res, 200, getAllCached());
    return;
  }

  // ── GET /api/discover/folders ──────────────────────────────────────────────
  if (req.method === 'GET' && url.startsWith('/api/discover/folders')) {
    const qPropId = new URL('http://x' + req.url).searchParams.get('propId');
    if (!qPropId) {
      sendJson(res, 400, { error: 'propId query parameter required' }); return;
    }
    const foldersFile = path.join(__dirname, 'data', 'discovery-folders.json');
    let allFolders = {};
    if (fs.existsSync(foldersFile)) {
      try { allFolders = JSON.parse(fs.readFileSync(foldersFile, 'utf8')); } catch (_) {}
    }
    const folders = allFolders[qPropId] || [];
    sendJson(res, 200, { folders });
    return;
  }

  // ── POST endpoints ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let rawBody;
    try { rawBody = await readBody(req); }
    catch (e) { sendJson(res, 413, { error: e.message }); return; }
    const payload = parseBody(rawBody);

    // ── /api/fetch-meta ──────────────────────────────────────────────────────
    if (url === '/api/fetch-meta') {
      const { propertyId } = payload;
      const args = propertyId ? ['fetch-meta.js', `--property=${propertyId}`] : ['fetch-meta.js'];
      const child = spawn('node', args, { cwd: __dirname, stdio: 'pipe' });
      let out = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { out += d.toString(); });
      child.on('close', code => {
        invalidateCache(PROP_META_FILE);
        sendJson(res, 200, { ok: code === 0, output: out });
      });
      return;
    }

    // ── /api/scrape-url ──────────────────────────────────────────────────────
    if (url === '/api/scrape-url') {
      const { url: targetUrl } = payload;
      if (!targetUrl) { sendJson(res, 400, { error: 'url required' }); return; }
      const child = spawn('node', ['fetch-meta.js', `--url=${targetUrl}`], { cwd: __dirname, stdio: 'pipe' });
      let out = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { out += d.toString(); });
      child.on('close', code => {
        try { sendJson(res, 200, { ok: code === 0, data: JSON.parse(out.trim()) }); }
        catch (_) { sendJson(res, 200, { ok: false, error: out }); }
      });
      return;
    }

    // ── /api/geocode ─────────────────────────────────────────────────────────
    if (url === '/api/geocode') {
      const { id, query } = payload;
      if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
      // Validate id format (alphanumeric + underscore only)
      if (!/^[a-z0-9_]{1,100}$/.test(id)) { sendJson(res, 400, { error: 'Invalid id' }); return; }
      const all = getAllCached();
      if (all[id]) { sendJson(res, 200, all[id]); return; }
      try {
        const { geocode } = require('./lib/geocode');
        const result = await geocode(id, query || id.replace(/_/g, ' ') + ', India');
        if (result) sendJson(res, 200, result);
        else sendJson(res, 200, { error: 'not_found' });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    // ── /api/geocode/save ────────────────────────────────────────────────────
    if (url === '/api/geocode/save') {
      const { id, lat, lng } = payload;
      if (!id || lat == null || lng == null) { sendJson(res, 400, { error: 'id, lat, lng required' }); return; }
      if (!/^[a-z0-9_]{1,100}$/.test(id)) { sendJson(res, 400, { error: 'Invalid id' }); return; }
      const latN = parseFloat(lat), lngN = parseFloat(lng);
      if (isNaN(latN) || isNaN(lngN)) { sendJson(res, 400, { error: 'lat and lng must be numbers' }); return; }
      saveManual(id, latN, lngN);
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── /api/discover/scan-all ───────────────────────────────────────────────
    if (url === '/api/discover/scan-all') {
      const { force } = payload;
      if (scanAllJob) {
        sendJson(res, 200, { status: 'running', current: scanAllJob.current, total: scanAllJob.total }); return;
      }
      const cfg = readJsonCached(CONFIG_FILE);
      const ownProps = (cfg?.properties || []).filter(p => p.type === 'own');
      if (!ownProps.length) { sendJson(res, 400, { error: 'No own properties in config' }); return; }

      const discArgs = ['discover-all.js'];
      if (force) discArgs.push('--force');

      const child = spawn('node', discArgs, { cwd: __dirname, stdio: 'pipe' });
      scanAllJob = { pid: child.pid, current: 0, total: ownProps.length, results: [], log: [], startedAt: new Date().toISOString() };

      // `scanAllJob` is set to null by /scan-all/stop, but the child keeps writing until the
      // SIGTERM lands — every access below has to tolerate the job having gone away, or a Stop
      // click takes the server down with "Cannot read properties of null".
      onLines(child.stdout, line => {
        if (!scanAllJob) return;
        // discover-all.js outputs plain log lines like "[ISO] STATUS [id] msg"
        const propMatch = line.match(/\[([a-z0-9_]+)\]/i);
        const propId = propMatch ? propMatch[1] : null;

        const entry = { ts: new Date().toISOString(), line: line.replace(/^\[[\dT:.Z-]+\]\s*/, ''), propId };
        // Bounded: a long scan emits thousands of lines and nothing ever trims this.
        scanAllJob.log.push(entry);
        if (scanAllJob.log.length > 1000) scanAllJob.log.splice(0, scanAllJob.log.length - 1000);

        if (/^START/i.test(entry.line)) {
          scanAllJob.current++;
          emitScanAllSSE({ type: 'start', propId, current: scanAllJob.current, total: scanAllJob.total, line: entry.line });
        } else if (/^DONE/i.test(entry.line)) {
          scanAllJob.results.push({ propId, ok: true });
          invalidateCache(DISCOVERY_FILE);
          emitScanAllSSE({ type: 'done_prop', propId, current: scanAllJob.current, total: scanAllJob.total, line: entry.line });
        } else if (/^ERROR|^STDERR/i.test(entry.line)) {
          emitScanAllSSE({ type: 'error_prop', propId, line: entry.line });
        } else {
          emitScanAllSSE({ type: 'status', propId, line: entry.line });
        }
      });

      onLines(child.stderr, line => emitScanAllSSE({ type: 'status', line: line.slice(0, 500) }));

      child.on('error', err => {
        emitScanAllSSE({ type: 'complete', ok: false, error: `Could not start discover-all.js: ${err.message}` });
        scanAllJob = null;
      });

      child.on('close', code => {
        const summary = { ok: code === 0, total: ownProps.length, results: scanAllJob?.results || [] };
        emitScanAllSSE({ type: 'complete', ...summary });
        invalidateCache(DISCOVERY_FILE);
        scanAllJob = null;
      });

      sendJson(res, 200, { status: 'started', total: ownProps.length }); return;
    }

    // ── /api/discover/scan-all/stop ──────────────────────────────────────────
    if (url === '/api/discover/scan-all/stop') {
      if (scanAllJob) {
        try { process.kill(scanAllJob.pid, 'SIGTERM'); } catch (_) {}
        scanAllJob = null;
        emitScanAllSSE({ type: 'complete', ok: false, stopped: true });
      }
      sendJson(res, 200, { ok: true }); return;
    }

    // ── /api/discover/start ──────────────────────────────────────────────────
    if (url === '/api/discover/start') {
      const { propId, force } = payload;
      if (!propId || !/^[a-z0-9_]{1,100}$/.test(propId)) {
        sendJson(res, 400, { error: 'Valid propId required' }); return;
      }
      if (discoverJobs[propId]) {
        sendJson(res, 200, { status: 'running', message: 'Discovery already running' }); return;
      }
      if (!force) {
        const all = readJsonCached(DISCOVERY_FILE);
        if (all?.[propId]) {
          const fetchedAt = all[propId].fetchedAt;
          const ageHours = fetchedAt
            ? Math.round((Date.now() - new Date(fetchedAt).getTime()) / 3600000)
            : null;
          sendJson(res, 200, { status: 'cached', fetchedAt, ageHours, count: all[propId].results?.length });
          return;
        }
      }
      const discArgs = ['discover.js', `--property=${propId}`];
      if (force) discArgs.push('--force');
      const child = spawn('node', discArgs, { cwd: __dirname, stdio: 'pipe' });
      const job = { pid: child.pid, lastMsg: null, log: [] };
      discoverJobs[propId] = job;
      // Hold the job object rather than re-reading discoverJobs[propId] on every chunk: the entry
      // is deleted 5s after 'done', and late stdout/stderr then dereferenced undefined. In the
      // stdout path a try/catch happened to swallow it; on stderr it was an uncaught TypeError
      // that killed the server.
      onLines(child.stdout, line => {
        try {
          const obj = JSON.parse(line);
          job.lastMsg = obj;
          job.log.push(obj);
          if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
          if (obj.type === 'done' || obj.type === 'error') {
            invalidateCache(DISCOVERY_FILE);
            setTimeout(() => { if (discoverJobs[propId] === job) delete discoverJobs[propId]; }, 5000);
          }
        } catch (_) { /* discover.js also prints non-JSON progress lines */ }
      });
      onLines(child.stderr, line => {
        job.log.push({ type: 'error', message: line.slice(0, 500) });
        if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
      });
      child.on('error', err => {
        job.lastMsg = { type: 'error', message: `Could not start discover.js: ${err.message}` };
      });
      child.on('close', () => {
        invalidateCache(DISCOVERY_FILE);
        setTimeout(() => { if (discoverJobs[propId] === job) delete discoverJobs[propId]; }, 5000);
      });
      sendJson(res, 200, { status: 'started' });
      return;
    }

    // ── /api/discover/select ─────────────────────────────────────────────────
    if (url === '/api/discover/select') {
      const { propId, selectedIds } = payload;
      if (!propId || !Array.isArray(selectedIds)) {
        sendJson(res, 400, { error: 'propId and selectedIds[] required' }); return;
      }
      const saved = updateDiscoveryCache(all => {
        if (!all[propId]) return false;
        all[propId].selected = selectedIds;
        return true;
      });
      if (!saved) { sendJson(res, 404, { error: 'No data for this property' }); return; }
      sendJson(res, 200, { ok: true, savedCount: selectedIds.length });
      return;
    }

    if (req.method === 'POST' && url === '/api/discover/folders') {
      const { propId, folders } = payload;
      if (!propId || !Array.isArray(folders)) {
        sendJson(res, 400, { error: 'propId and folders[] array required' }); return;
      }
      const foldersFile = path.join(__dirname, 'data', 'discovery-folders.json');
      let allFolders = {};
      if (fs.existsSync(foldersFile)) {
        try { allFolders = JSON.parse(fs.readFileSync(foldersFile, 'utf8')); } catch (_) {}
      }
      allFolders[propId] = folders;
      fs.mkdirSync(path.dirname(foldersFile), { recursive: true });
      writeJsonAtomic(foldersFile, allFolders);
      sendJson(res, 200, { ok: true });
      return;
    }


    // ── /api/discover/add-manual-url ─────────────────────────────────────────
    if (url === '/api/discover/add-manual-url') {
      const { url: targetUrl, propId } = payload;
      if (!targetUrl || !propId) {
        sendJson(res, 400, { error: 'url and propId are required' }); return;
      }
      const slug = targetUrl.match(/booking\.com\/hotel\/[a-z]{2}\/([^.?/#]+)/i)?.[1];
      if (!slug) {
        sendJson(res, 400, { error: 'Not a valid Booking.com hotel URL' }); return;
      }
      const compId = slug.replace(/-/g, '_');

      // 1. Read config and check if already tracked
      let cfgData;
      try {
        cfgData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to read properties config' }); return;
      }
      const ownProp = cfgData.properties?.find(p => p.id === propId && p.type === 'own');
      if (!ownProp) {
        sendJson(res, 404, { error: `Property "${propId}" not found in config` }); return;
      }

      // 2. Spawn fetch-meta.js to scrape the URL
      const child = spawn('node', ['fetch-meta.js', `--url=${targetUrl}`], { cwd: __dirname, stdio: 'pipe' });
      let out = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { out += d.toString(); });
      child.on('close', async (code) => {
        if (code !== 0) {
          sendJson(res, 500, { error: `Scraping failed: ${out}` }); return;
        }
        let meta;
        try {
          meta = JSON.parse(out.trim());
        } catch (e) {
          sendJson(res, 500, { error: `Invalid metadata returned from scraper: ${out}` }); return;
        }

        const name = meta.name || slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
        const lat = meta.lat;
        const lng = meta.lon || meta.lng;
        const stars = meta.stars;
        const rating = meta.rating || 0;
        const propType = meta.type?.toLowerCase() || 'property';

        if (lat == null || lng == null) {
          sendJson(res, 400, { error: 'Could not extract valid coordinates for this property. Booking.com might be blocking or this page has no geo info.' });
          return;
        }

        // 3. Update CSV_FILE (properties.csv)
        try {
          const lines = readCsvLines();
          const targetSlug = ownProp?.slug || propId.replace(/_/g, '-');
          let insertAfter = -1;
          for (let i = 1; i < lines.length; i++) {
            if (lines[i].includes(targetSlug)) { insertAfter = i; break; }
          }
          if (insertAfter >= 0) {
            let isAlreadyTracked = false;
            for (let i = insertAfter + 1; i < lines.length; i++) {
              const line = lines[i];
              if (line.trim() && !line.startsWith(',')) break; // next own prop
              if (line.includes(slug)) { isAlreadyTracked = true; break; }
            }
            if (!isAlreadyTracked) {
              lines.splice(insertAfter + 1, 0, csvCompetitorRow(name, targetUrl));
              writeCsvLines(lines);
            }
          }
        } catch (csvErr) {
          console.error('Error updating CSV:', csvErr);
        }

        // 4. Update CONFIG_FILE (properties.json)
        try {
          if (!ownProp.competitors) ownProp.competitors = [];
          if (!ownProp.competitors.includes(compId)) {
            ownProp.competitors.push(compId);
          }
          let hasComp = cfgData.properties?.find(p => p.id === compId);
          if (!hasComp) {
            hasComp = {
              id:           compId,
              slug:         slug,
              type:         'comp',
              display:      name,
              location:     ownProp.city || ownProp.location,
              city:         ownProp.city || ownProp.location,
              country:      'IN',
              propertyType: propType,
              match:        name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
              competitors:  [],
              deal:         0,
              beds:         meta.beds || ownProp.beds || 1,
              pax:          meta.pax || ownProp.pax || 2,
              amenities:    meta.amenities || [],
              lat:          lat,
              lng:          lng,
            };
            if (stars) hasComp.stars = stars;
            if (rating) hasComp.rating = rating;
            cfgData.properties.push(hasComp);
          } else {
            if (hasComp.lat == null && lat != null) {
              hasComp.lat = lat;
              hasComp.lng = lng;
            }
            if (hasComp.rating == null && rating != null) {
              hasComp.rating = rating;
            }
          }
          cfgData.updatedAt = new Date().toISOString();
          writeJsonAtomic(CONFIG_FILE, cfgData);
        } catch (cfgErr) {
          console.error('Error updating config file:', cfgErr);
        }

        // 5. Update geo-cache.json
        const GEO_CACHE_FILE = path.join(__dirname, 'data', 'geo-cache.json');
        try {
          let geoCache = {};
          if (fs.existsSync(GEO_CACHE_FILE)) {
            geoCache = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
          }
          geoCache[compId] = { lat, lng };
          geoCache[slug] = { lat, lng };
          writeJsonAtomic(GEO_CACHE_FILE, geoCache);
        } catch (geoErr) {
          console.error('Error updating geo cache:', geoErr);
        }

        // 6. Update discovery-cache.json (DISCOVERY_FILE)
        try {
          updateDiscoveryCache(discData => {
            if (!discData[propId]) {
              discData[propId] = {
                fetchedAt: new Date().toISOString(),
                propName: ownProp.display,
                city: ownProp.city || ownProp.location,
                ownCoords: { lat: ownProp.lat, lng: ownProp.lng },
                maxDistKm: 40,
                ownAvgPrice: null,
                results: [],
                fullMarket: [],
                selected: []
              };
            }
            const newResult = {
              id: slug,
              slug: slug,
              name: name,
              url: targetUrl,
              price: null,
              rating: rating || null,
              type: propType,
              image: null,
              lat: lat,
              lng: lng,
              // Real distance from the own property. This was hardcoded to 0, which put every
              // manually added competitor at the top of a "Distance ↑" sort and inside every
              // radius filter regardless of where it actually is.
              distance: distanceKm(ownProp.lat, ownProp.lng, lat, lng),
              geocoded: true,
              approximate: false,
              beds: null,
              relevanceScore: 100,
              confidence: "high"
            };
            const entry = discData[propId];
            // Write into BOTH lists. `results` is the ranked shortlist; `fullMarket` is what the
            // map and the shared location pool are built from, so an entry missing from it was
            // added to the competitor set but never appeared as a pin.
            for (const listName of ['results', 'fullMarket']) {
              if (!Array.isArray(entry[listName])) entry[listName] = [];
              const idx = entry[listName].findIndex(r => r.id === slug || r.slug === slug);
              if (idx >= 0) entry[listName][idx] = { ...entry[listName][idx], ...newResult };
              else entry[listName].push(newResult);
            }
            if (!Array.isArray(entry.selected)) entry.selected = [];
            if (!entry.selected.includes(slug)) entry.selected.push(slug);
          });
        } catch (discErr) {
          console.error('Error updating discovery cache:', discErr);
        }

        // 7. Update latest.dashboard.json (DASHBOARD_DATA)
        try {
          if (fs.existsSync(DASHBOARD_DATA)) {
            const dbData = JSON.parse(fs.readFileSync(DASHBOARD_DATA, 'utf8'));
            if (dbData.portfolio && dbData.portfolio[propId]) {
              if (!dbData.portfolio[propId].competitors) dbData.portfolio[propId].competitors = [];
              if (!dbData.portfolio[propId].competitors.includes(compId)) {
                dbData.portfolio[propId].competitors.push(compId);
              }
            }
            if (!dbData.competitors) dbData.competitors = {};
            if (!dbData.competitors[compId]) {
              dbData.competitors[compId] = {
                name: name,
                location: ownProp.location,
                city: ownProp.city || ownProp.location,
                propertyType: propType,
                beds: 1,
                pax: 2,
                bookingMatch: name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
                rooms: {},
                lat: lat,
                lng: lng
              };
            }
            writeJsonAtomic(DASHBOARD_DATA, dbData, false);
          }
        } catch (dbErr) {
          console.error('Error updating dashboard JSON:', dbErr);
        }

        sendJson(res, 200, {
          ok: true,
          compId: compId,
          name: name,
          lat: lat,
          lng: lng,
          message: 'Competitor added successfully. Commencing pricing scrape...'
        });
      });
      return;
    }

    // ── /api/discover/commit ─────────────────────────────────────────────────
    if (url === '/api/discover/commit') {
      const { propId, selectedIds } = payload;
      if (!propId || !Array.isArray(selectedIds) || !selectedIds.length) {
        sendJson(res, 400, { error: 'propId and non-empty selectedIds[] required' }); return;
      }
      auditConfigChange(req, 'discover-commit', { propId, adding: selectedIds.length });
      const all = readJsonCached(DISCOVERY_FILE);
      const entry = all?.[propId];
      if (!entry) { sendJson(res, 404, { error: 'No discovery data for this property' }); return; }

      const selectedSet = new Set(selectedIds);
      const toAdd = (entry.results || []).filter(r => selectedSet.has(r.id));
      if (!toAdd.length) {
        sendJson(res, 400, { error: 'None of the selectedIds matched discovery results' }); return;
      }

      // Append to properties.csv
      const lines = readCsvLines();
      let targetSlug = propId.replace(/_/g, '-');
      try {
        const cfgData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const ownProp = cfgData.properties?.find(p => p.id === propId && p.type === 'own');
        if (ownProp?.slug) targetSlug = ownProp.slug;
      } catch (_) {}

      let insertAfter = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].includes(targetSlug)) { insertAfter = i; break; }
      }
      if (insertAfter < 0) {
        sendJson(res, 404, { error: `Property "${propId}" not found in properties.csv` }); return;
      }

      const newRows = [], addedIds = [];
      for (const r of toAdd) {
        const slug = r.url?.match(/\/hotel\/[a-z]{2}\/([^.?/#]+)/i)?.[1];
        if (!slug || lines.some(l => l.includes(slug))) continue;
        newRows.push(csvCompetitorRow(r.name, r.url));
        addedIds.push(slug);
      }

      if (!newRows.length) {
        sendJson(res, 200, { ok: true, added: 0, message: 'All selected already in CSV' }); return;
      }

      // Update discovery selection
      updateDiscoveryCache(disk => {
        if (!disk[propId]) return;
        disk[propId].selected = [...new Set([...(disk[propId].selected || []), ...selectedIds])];
      });

      // Write CSV
      lines.splice(insertAfter + 1, 0, ...newRows);
      writeCsvLines(lines);

      // Re-run import-properties.js --merge -> Update config directly
      try {
        if (fs.existsSync(CONFIG_FILE)) {
          const cfgData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          const ownProp = cfgData.properties?.find(p => p.id === propId && p.type === 'own');
          if (ownProp) {
            if (!ownProp.competitors) ownProp.competitors = [];
            for (const r of toAdd) {
              const slug = r.url?.match(/\/hotel\/[a-z]{2}\/([^.?/#]+)/i)?.[1] || r.id.replace(/_/g, '-');
              if (!slug) continue;
              const compId = slug.replace(/-/g, '_');
              if (!ownProp.competitors.includes(compId)) {
                ownProp.competitors.push(compId);
              }
              const hasComp = cfgData.properties?.find(p => p.id === compId);
              if (!hasComp) {
                const compEntry = {
                  id:           compId,
                  slug:         slug,
                  type:         'comp',
                  display:      r.name,
                  location:     ownProp.city || ownProp.location,
                  city:         ownProp.city || ownProp.location,
                  country:      'IN',
                  propertyType: r.type || 'property',
                  match:        r.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
                  competitors:  [],
                  deal:         0,
                  beds:         r.beds || 1,
                  pax:          2,
                  amenities:    [],
                };
                if (r.lat) compEntry.lat = r.lat;
                if (r.lng) compEntry.lng = r.lng;
                if (r.rating) compEntry.rating = r.rating;
                cfgData.properties.push(compEntry);
              } else {
                if (hasComp.lat == null && r.lat != null) {
                  hasComp.lat = r.lat;
                  hasComp.lng = r.lng;
                }
                if (hasComp.rating == null && r.rating != null) {
                  hasComp.rating = r.rating;
                }
              }
            }
            cfgData.updatedAt = new Date().toISOString();
            writeJsonAtomic(CONFIG_FILE, cfgData);
          }
        }
      } catch (err) {
        console.error('Error writing config:', err);
      }
      sendJson(res, 200, { ok: true, added: newRows.length, addedIds, importLog: 'Successfully committed' });
      return;
    }

    // ── /api/reset-competitors ───────────────────────────────────────────────
    if (url === '/api/reset-competitors') {
      const { propertyId } = payload;
      if (!propertyId || !/^[a-z0-9_]{1,100}$/.test(propertyId)) {
        sendJson(res, 400, { error: 'Valid propertyId required' }); return;
      }
      const cfg = readJsonCached(CONFIG_FILE);
      if (!cfg) { sendJson(res, 500, { error: 'Config not found' }); return; }
      const prop = cfg.properties?.find(p => p.id === propertyId && p.type === 'own');
      if (!prop) { sendJson(res, 404, { error: `Property "${propertyId}" not found` }); return; }

      const removedIds = [...(prop.competitors || [])];
      // Recorded BEFORE the mutation — this is the operation that has twice destroyed scraped rates.
      auditConfigChange(req, 'reset-competitors', { propertyId, removing: removedIds.length, removedIds });
      if (!removedIds.length) {
        sendJson(res, 200, { ok: true, removed: 0, removedIds: [], message: 'No competitors to remove' }); return;
      }

      // 1. Remove competitor rows from CSV (,,, rows between this property and the next numbered row)
      const csvLines = readCsvLines();
      const targetSlug = prop?.slug || propertyId.replace(/_/g, '-');
      let propRowIdx = -1;
      for (let i = 0; i < csvLines.length; i++) {
        if (csvLines[i].toLowerCase().includes(targetSlug.toLowerCase())) { propRowIdx = i; break; }
      }
      if (propRowIdx >= 0) {
        let endIdx = csvLines.length;
        for (let i = propRowIdx + 1; i < csvLines.length; i++) {
          if (/^\d+,/.test(csvLines[i])) { endIdx = i; break; }
        }
        const filtered = [...csvLines.slice(0, propRowIdx + 1), ...csvLines.slice(endIdx)];
        writeCsvLines(filtered);
      }

      // 2. Clear competitor data from latest.dashboard.json
      try {
        if (fs.existsSync(DASHBOARD_DATA)) {
          const dash = JSON.parse(fs.readFileSync(DASHBOARD_DATA, 'utf8'));
          for (const id of removedIds) { delete (dash.competitors || {})[id]; }
          if (dash.portfolio?.[propertyId]) dash.portfolio[propertyId].competitors = [];
          writeJsonAtomic(DASHBOARD_DATA, dash, false);
        }
      } catch (_) {}

      // 3. Update config directly
      try {
        if (fs.existsSync(CONFIG_FILE)) {
          const cfgData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          const ownProp = cfgData.properties?.find(p => p.id === propertyId && p.type === 'own');
          if (ownProp) {
            ownProp.competitors = [];
          }
          // Find all competitor IDs still used by any other own property
          const activeCompIds = new Set();
          cfgData.properties?.forEach(p => {
            if (p.type === 'own') {
              p.competitors?.forEach(id => activeCompIds.add(id));
            }
          });
          // Filter to keep own properties and active competitor properties
          cfgData.properties = cfgData.properties?.filter(p => {
            if (p.type === 'own') return true;
            return activeCompIds.has(p.id);
          }) || [];
          cfgData.updatedAt = new Date().toISOString();
          writeJsonAtomic(CONFIG_FILE, cfgData);
        }
      } catch (err) {
        console.error('Error writing config:', err);
      }
      sendJson(res, 200, { ok: true, removed: removedIds.length, removedIds });
      return;
    }

    // ── /api/add-competitor ──────────────────────────────────────────────────
    if (url === '/api/add-competitor') {
      const { url: compUrl, ownPropertyId, competitorName } = payload;
      if (!compUrl || !ownPropertyId) {
        sendJson(res, 400, { error: 'url and ownPropertyId required' }); return;
      }
      const slugM = compUrl.match(/booking\.com\/hotel\/[a-z]{2}\/([^.?/]+)/i);
      if (!slugM) { sendJson(res, 400, { error: 'Not a valid Booking.com hotel URL' }); return; }
      auditConfigChange(req, 'add-competitor', { ownPropertyId, slug: slugM[1] });
      const slug    = slugM[1];
      const rawName = (competitorName || slug.split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ')).slice(0, 120);
      const safeName = rawName.replace(/[\n\r]/g, ' ');
      const csvLine = csvCompetitorRow(safeName, compUrl);

      const csvLines = readCsvLines();
      let targetSlug = ownPropertyId.replace(/_/g, '-');
      try {
        const cfgData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const ownProp = cfgData.properties?.find(p => p.id === ownPropertyId && p.type === 'own');
        if (ownProp?.slug) targetSlug = ownProp.slug;
      } catch (_) {}

      let insertIdx = -1;
      for (let i = 0; i < csvLines.length; i++) {
        if (csvLines[i].toLowerCase().includes(targetSlug.toLowerCase())) {
          insertIdx = i;
        }
      }
      if (insertIdx >= 0) {
        let lastComp = insertIdx;
        for (let i = insertIdx + 1; i < csvLines.length; i++) {
          if (csvLines[i].startsWith(',,,') || csvLines[i].startsWith(',,,"')) lastComp = i;
          else if (csvLines[i].match(/^\d+,/)) break;
        }
        csvLines.splice(lastComp + 1, 0, csvLine);
      } else {
        csvLines.push(csvLine);
      }
      writeCsvLines(csvLines);

      // Update config directly
      const compId = slug.replace(/-/g, '_');
      try {
        if (fs.existsSync(CONFIG_FILE)) {
          const cfgData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          const ownProp = cfgData.properties?.find(p => p.id === ownPropertyId && p.type === 'own');
          if (ownProp) {
            if (!ownProp.competitors) ownProp.competitors = [];
            if (!ownProp.competitors.includes(compId)) {
              ownProp.competitors.push(compId);
            }
            
            // Try resolving coordinates from local caches
            let lat = null, lng = null, rating = null;
            const GEO_CACHE_FILE = path.join(__dirname, 'data', 'geo-cache.json');

            // Check discovery-cache
            const allDisc = readJsonCached(DISCOVERY_FILE);
            if (allDisc) {
              for (const pid in allDisc) {
                const item = [...(allDisc[pid].results || []), ...(allDisc[pid].fullMarket || [])]
                  .find(h => h.id === compId || h.slug === slug);
                if (item && item.lat && item.lng) {
                  lat = item.lat; lng = item.lng;
                  if (item.rating) rating = item.rating;
                  break;
                }
              }
            }
            
            // Check geo-cache
            if (!lat && fs.existsSync(GEO_CACHE_FILE)) {
              try {
                const gc = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
                if (gc[compId]) { lat = gc[compId].lat; lng = gc[compId].lng; }
              } catch (_) {}
            }

            const saveConfigAndResponse = (finalLat, finalLng, finalRating) => {
              const hasComp = cfgData.properties?.find(p => p.id === compId);
              if (!hasComp) {
                const compEntry = {
                  id:           compId,
                  slug:         slug,
                  type:         'comp',
                  display:      safeName,
                  location:     ownProp.city || ownProp.location,
                  city:         ownProp.city || ownProp.location,
                  country:      'IN',
                  propertyType: 'property',
                  match:        safeName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
                  competitors:  [],
                  deal:         0,
                  beds:         1,
                  pax:          2,
                  amenities:    [],
                };
                if (finalLat) compEntry.lat = finalLat;
                if (finalLng) compEntry.lng = finalLng;
                if (finalRating) compEntry.rating = finalRating;
                cfgData.properties.push(compEntry);
              } else {
                if (hasComp.lat == null && finalLat != null) {
                  hasComp.lat = finalLat;
                  hasComp.lng = finalLng;
                }
                if (hasComp.rating == null && finalRating != null) {
                  hasComp.rating = finalRating;
                }
              }
              cfgData.updatedAt = new Date().toISOString();
              writeJsonAtomic(CONFIG_FILE, cfgData);

              // Update latest.dashboard.json
              try {
                if (fs.existsSync(DASHBOARD_DATA)) {
                  const dash = JSON.parse(fs.readFileSync(DASHBOARD_DATA, 'utf8'));
                  if (dash.portfolio?.[ownPropertyId]) {
                    if (!dash.portfolio[ownPropertyId].competitors) dash.portfolio[ownPropertyId].competitors = [];
                    if (!dash.portfolio[ownPropertyId].competitors.includes(compId)) {
                      dash.portfolio[ownPropertyId].competitors.push(compId);
                    }
                  }
                  if (!dash.competitors) dash.competitors = {};
                  if (!dash.competitors[compId]) {
                    dash.competitors[compId] = {
                      name: safeName,
                      location: ownProp.city || ownProp.location,
                      city: ownProp.city || ownProp.location,
                      propertyType: 'property',
                      beds: 1,
                      pax: 2,
                      bookingMatch: safeName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
                      rooms: {},
                    };
                    if (finalLat) {
                      dash.competitors[compId].lat = finalLat;
                      dash.competitors[compId].lng = finalLng;
                    }
                  } else {
                    if (dash.competitors[compId].lat == null && finalLat != null) {
                      dash.competitors[compId].lat = finalLat;
                      dash.competitors[compId].lng = finalLng;
                    }
                  }
                  writeJsonAtomic(DASHBOARD_DATA, dash, false);
                }
              } catch (_) {}

              sendJson(res, 200, { ok: true, slug, key: compId, output: 'Successfully added' });
            };

            if (lat && lng) {
              saveConfigAndResponse(lat, lng, rating);
            } else {
              // Fetch online via fetch-meta.js
              const child = spawn('node', ['fetch-meta.js', `--url=${compUrl}`], { cwd: __dirname, stdio: 'pipe' });
              let out = '';
              child.stdout.on('data', d => { out += d.toString(); });
              child.stderr.on('data', d => { out += d.toString(); });
              child.on('close', code => {
                let parsedLat = null, parsedLng = null, parsedRating = null;
                try {
                  const data = JSON.parse(out.trim());
                  if (data.lat && data.lon) {
                    parsedLat = data.lat;
                    parsedLng = data.lon;
                    // Save to geo-cache.json
                    try {
                      if (fs.existsSync(GEO_CACHE_FILE)) {
                        const gc = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
                        gc[compId] = { lat: parsedLat, lng: parsedLng, approximate: false, source: 'booking_scraping' };
                        writeJsonAtomic(GEO_CACHE_FILE, gc);
                      }
                    } catch (_) {}
                  }
                  if (data.stars) {
                    parsedRating = data.stars;
                  }
                } catch (_) {}
                saveConfigAndResponse(parsedLat || lat, parsedLng || lng, parsedRating || rating);
              });
            }
          } else {
            sendJson(res, 404, { error: 'Own property not found' });
          }
        } else {
          sendJson(res, 500, { error: 'Config not found' });
        }
      } catch (err) {
        console.error('Error writing config:', err);
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // ── /refresh  (aliases: /api/refresh, /refresh/property, /api/refresh/property) ─
    if (url === '/refresh' || url === '/refresh/property' ||
        url === '/api/refresh' || url === '/api/refresh/property') {
      const isProperty = url.endsWith('/property');
      if (refreshing) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Refresh already in progress', startedAt: refreshStartedAt }));
        return;
      }

      const handleRefresh = (propertyId) => {
        // Validate BEFORE claiming the refresh slot or committing to a status code. The header
        // used to be written as 200 up front, so an unknown property id came back as a 200 whose
        // body happened to contain `error` — indistinguishable from success to any client that
        // checks res.ok.
        if (propertyId) {
          const config = readJsonCached(CONFIG_FILE);
          const validId = config?.properties?.some(p => p.id === propertyId && p.type === 'own');
          if (!validId) { sendJson(res, 404, { error: `Unknown property ID: ${propertyId}` }); return; }
        }

        refreshing = true;
        refreshStartedAt = new Date().toISOString();

        const args = propertyId ? ['refresh.js', `--property=${propertyId}`] : ['refresh.js'];
        const child = spawn('node', args, { cwd: __dirname, stdio: 'pipe' });
        let output = '';
        // Capped: a full refresh prints ~2,400 progress lines and the whole thing was accumulated
        // in memory purely to echo it back in the response body.
        const append = text => { output = (output + text).slice(-200000); };
        onLines(child.stdout, line => { append(line + '\n'); process.stdout.write(line + '\n'); emitRefreshSSE({ line: line.trim() }); });
        onLines(child.stderr, line => { append(line + '\n'); process.stderr.write(line + '\n'); emitRefreshSSE({ line: line.trim(), level: 'error' }); });
        child.on('error', err => {
          refreshing = false; refreshStartedAt = null;
          emitRefreshSSE({ done: true, ok: false });
          if (!res.headersSent) sendJson(res, 500, { error: `Could not start refresh.js: ${err.message}` });
        });
        child.on('close', code => {
          refreshing = false; refreshStartedAt = null;
          invalidateCache(DASHBOARD_DATA);
          invalidateCache(META_FILE);
          emitRefreshSSE({ done: true, ok: code === 0 });
          if (res.headersSent) { try { res.end(); } catch (_) {} return; }
          sendJson(res, code === 0 ? 200 : 500, { ok: code === 0, output });
        });
      };

      if (isProperty) {
        const { propertyId } = payload;
        if (!propertyId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'propertyId required' }));
          return;
        }
        handleRefresh(propertyId);
      } else {
        handleRefresh(null);
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  // ── GET /api/discover/scan-all/status ────────────────────────────────────
  if (req.method === 'GET' && url === '/api/discover/scan-all/status') {
    sendJson(res, 200, scanAllJob
      ? { running: true, current: scanAllJob.current, total: scanAllJob.total, startedAt: scanAllJob.startedAt }
      : { running: false });
    return;
  }

  // ── GET /api/discover/scan-all/events — SSE ───────────────────────────────
  if (req.method === 'GET' && url === '/api/discover/scan-all/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    // Send current state immediately
    if (scanAllJob) {
      res.write(`data: ${JSON.stringify({ type: 'status', current: scanAllJob.current, total: scanAllJob.total, running: true })}\n\n`);
    }
    scanAllSSEClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { scanAllSSEClients.delete(res); clearInterval(hb); });
    return;
  }

  // ── GET /api/discover/status ───────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/discover/status')) {
    const qPropId = new URL('http://x' + req.url).searchParams.get('propId');
    const job = discoverJobs[qPropId];
    let cached = null;
    if (!job) {
      const all = readJsonCached(DISCOVERY_FILE);
      if (all?.[qPropId]) {
        const e = all[qPropId];
        const ageHours = e.fetchedAt
          ? Math.round((Date.now() - new Date(e.fetchedAt).getTime()) / 3600000)
          : null;
        cached = {
          fetchedAt:    e.fetchedAt,
          firstScanAt:  e.firstScanAt || e.fetchedAt,
          scanCount:    e.scanCount   || 1,
          ageHours,
          count:        e.results?.length                          || 0,
          // `allDiscovered` is a retired alias of `fullMarket`, still read for old caches.
          totalCount:   e.fullMarket?.length || e.allDiscovered?.length || e.results?.length || 0,
          // The map now shows the whole location's inventory, so report that too — otherwise the
          // caption reads "56 properties discovered" beside 947 pins on the map.
          locationCount: (() => {
            try { return sharedMarketFor(qPropId, all)?.meta.shown ?? null; } catch (_) { return null; }
          })(),
          newCount:     e.newSince?.length                        || 0,
          city:         e.city,
        };
      }
    }
    sendJson(res, 200, { running: !!job, lastMsg: job?.lastMsg || null, cached });
    return;
  }

  // ── GET /api/discover/results ──────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/discover/results')) {
    const qPropId = new URL('http://x' + req.url).searchParams.get('propId');
    const all = readJsonCached(DISCOVERY_FILE);
    if (!all) { sendJson(res, 404, { error: 'No discovery data' }); return; }
    const entry = all[qPropId];
    if (!entry) { sendJson(res, 404, { error: 'No data for this property' }); return; }
    sendJsonGzip(req, res, 200, entry);
    return;
  }

  // ── GET /api/discover/full-market ──────────────────────────────────────────
  // Returns the whole market for this property's LOCATION, not just what its own scan happened to
  // catch. Properties in the same region (North Goa) share one inventory, so the map shows every
  // currently-listed property around the area rather than a different subset per property —
  // property 1's scan had found 849 candidates while property 4's had 56, for the same market.
  //
  // The union is computed on read and cached, deliberately NOT stored per property. Writing each
  // property its own copy of ~1,000 shared listings would take this cache from 2.3 MB to ~10 MB,
  // and it is JSON.parse'd whole by four scripts plus every endpoint here — which is exactly the
  // duplication BUG-003 was about. Distances are recomputed from THIS property's coordinates, so
  // ranking stays local even though the inventory is shared.
  if (req.method === 'GET' && req.url.startsWith('/api/discover/full-market')) {
    const q = new URL('http://x' + req.url).searchParams;
    const qPropId = q.get('propId');
    const scope   = q.get('scope') || 'location';        // 'location' (default) | 'property'
    const all = readJsonCached(DISCOVERY_FILE);
    if (!all) { sendJson(res, 404, { error: 'No discovery data' }); return; }
    const entry = all[qPropId];
    if (!entry) { sendJson(res, 404, { error: 'No data for this property' }); return; }

    let fullMarket = entry.fullMarket || [], pooled = null;
    if (scope === 'location') {
      const shared = sharedMarketFor(qPropId, all);
      if (shared) { fullMarket = shared.fullMarket; pooled = shared.meta; }
    }
    sendJsonGzip(req, res, 200, {
      fullMarket,
      newSince:   entry.newSince   || [],
      fetchedAt:  entry.fetchedAt,
      city:       entry.city,
      ownCoords:  entry.ownCoords,
      pooled,      // {key, propIds, unique, ownScan} when the location inventory was used
    });
    return;
  }

  // ── Unmatched /api/* — 404 as JSON, never as the dashboard ────────────────
  // Without this, the static fallback below answers a mistyped or retired API path with
  // 644 KB of HTML and a 200. The client then JSON.parse()s a page and reports
  // "Unexpected token <" from whichever panel happened to call it.
  if (url.startsWith('/api/')) {
    sendJson(res, 404, { error: `Unknown API endpoint: ${req.method} ${url}` });
    return;
  }

  // ── Static: dashboard HTML ────────────────────────────────────────────────
  if (req.method === 'GET') {
    fs.readFile(FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('Dashboard not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`  Port ${PORT} is in use — ${NO_OPEN ? 'not opening a browser (--no-open).' : 'opening existing dashboard…'}`);
    if (process.platform === 'win32' && !NO_OPEN) {
      const { exec } = require('child_process');
      exec(`rundll32 url.dll,FileProtocolHandler http://localhost:${PORT}`);
    }
    process.exit(0);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n  ╔═══════════════════════════════════════════════╗');
  console.log('  ║   Competitor Price Analyzer v2.0               ║');
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log(`\n  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}`);
  if (API_KEY) console.log(`  Auth:    API_KEY is set — add X-API-Key header`);
  console.log('\n  Press Ctrl+C to stop.\n');
  if (process.platform === 'win32' && !NO_OPEN) {
    const { exec } = require('child_process');
    exec(`rundll32 url.dll,FileProtocolHandler http://localhost:${PORT}`);
  }
});
