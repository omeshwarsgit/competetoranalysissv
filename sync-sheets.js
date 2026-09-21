/**
 * sync-sheets.js
 *
 * Syncs scraped pricing data into Google Sheets, replacing the positional
 * data/latest.csv export.
 *
 * Transports, chosen automatically from config/sheets.json:
 *   appscript        POSTs to an Apps Script Web App bound to the sheet.
 *                    No Google Cloud project, no service-account key, no sharing.
 *   service-account  Google Sheets REST API with a service-account JWT.
 *
 * Modes (config "mode"):
 *   daily-grid   one row per stay date, one column per property (lead-in rate)
 *   detailed     one row per property x room type x stay date — every rate cell
 *   both         writes both tabs: the grid to read, the detail to analyse
 *
 * Integrity: every row carries a deterministic key in column A
 *   daily grid   <stayDate>
 *   detailed     <propertyId>|<roomKey>|<stayDate>
 * Each run updates rows whose values changed and appends only new keys, so
 * re-running is idempotent. Rows the scraper no longer covers are left in place
 * rather than deleted, so sheet history is never destroyed.
 *
 * Usage
 *   node sync-sheets.js --dry-run          show what would be written, write nothing
 *   node sync-sheets.js                    sync once (skips if prices unchanged)
 *   node sync-sheets.js --force            sync even when unchanged
 *   node sync-sheets.js --property=1       limit to one own property + its competitors
 *   node sync-sheets.js --watch            sync whenever the pricing data changes
 *   node sync-sheets.js --reset            clear the target tabs before writing
 *   node sync-sheets.js --health           check the Apps Script deployment
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const P    = require('./lib/pricing-rows');

const SHEETS_CFG = path.join(__dirname, 'config', 'sheets.json');
const STATE_FILE = path.join(__dirname, 'data', 'sheets-sync-state.json');

const arg = n => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const has = n => process.argv.includes(`--${n}`);
const ONLY     = arg('property');
const DRY      = has('dry-run');
const WATCH    = has('watch');
const FORCE    = has('force');
const HEALTH   = has('health');
const RESET    = has('reset');
const INTERVAL = Math.max(60, parseInt(arg('interval') || '0', 10) || 0);

const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };

function loadConfig() {
  const c = readJSON(SHEETS_CFG, {}) || {};
  const cfg = {
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID || c.spreadsheetId || '',
    webAppUrl:     process.env.SHEETS_WEBAPP_URL     || c.webAppUrl     || '',
    sharedSecret:  process.env.SHEETS_SHARED_SECRET  || c.sharedSecret  || '',
    properties: (c.properties && c.properties.length) ? c.properties.map(String) : null,
    includeOwn: c.includeOwn !== false,
    mode:      c.mode      || 'daily-grid',
    ratesTab:  c.ratesTab  || 'Daily Rates',
    detailTab: c.detailTab || 'All Rates',
    // set false to keep the spreadsheet to exactly the rate tabs — no audit tab
    syncLog:   c.syncLog !== false,
    syncIntervalSec: c.syncIntervalSec || 0,
    chunkSize: c.chunkSize || 5000,
  };
  cfg.transport = c.transport || (cfg.webAppUrl ? 'appscript' : cfg.spreadsheetId ? 'service-account' : 'none');
  return cfg;
}

/** Build the tab payloads this mode calls for. */
function buildJobs(cfg, scope) {
  const jobs = [];
  if (cfg.mode === 'daily-grid' || cfg.mode === 'both') {
    const g = P.buildDailyGrid(scope);
    jobs.push({ tab: cfg.ratesTab, headers: g.headers, rows: g.rows, meta: g.meta,
                note: `${g.meta.properties} properties x ${g.meta.dates} dates, lead-in rate per night` });
  }
  if (cfg.mode === 'detailed' || cfg.mode === 'both') {
    const b = P.buildRows(scope);
    jobs.push({ tab: cfg.detailTab, headers: P.RATES_COLS, rows: b.rateRows, meta: b.meta,
                note: 'every property x room type x date rate cell' });
  }
  if (!jobs.length) throw new Error(`Unknown mode "${cfg.mode}" — use daily-grid, detailed or both.`);
  return jobs;
}

// ── one sync pass ─────────────────────────────────────────────────────────────
async function syncOnce(trigger) {
  const t0 = Date.now();
  const cfg = loadConfig();
  const scope = { properties: ONLY ? [ONLY] : cfg.properties, includeOwn: cfg.includeOwn };
  const jobs = buildJobs(cfg, scope);
  const hash = P.hashRows(jobs.flatMap(j => j.rows));
  const state = readJSON(STATE_FILE, {}) || {};

  if (!FORCE && !DRY && state.lastHash === hash) {
    console.log(`  Pricing data unchanged (hash ${hash}) — nothing to sync.`);
    return { skipped: true, hash };
  }

  const scrapedAt = jobs[0].meta.scrapedAt;
  console.log(`\n  Sync (${trigger}) via ${cfg.transport} · mode ${cfg.mode} · hash ${hash}`);
  console.log(`  Data scraped at ${scrapedAt || 'unknown'}`);
  console.log(`  Scope: ${scope.properties ? 'own ' + scope.properties.join(', ') : 'whole portfolio'}`
    + `${cfg.includeOwn ? ' + selected competitors' : ' — selected competitors only (own excluded)'}`);
  jobs.forEach(j => console.log(`    ${j.tab}: ${j.rows.length} rows x ${j.headers.length} cols — ${j.note}`));
  if (RESET) console.log('  --reset: clearing those tabs before writing');

  if (DRY) {
    console.log('\n  --dry-run: no writes.');
    for (const j of jobs) {
      console.log(`\n    ${j.tab} columns: ${j.headers.join(' | ')}`);
      j.rows.slice(0, 3).forEach(r => console.log('      ' + r.slice(0, 8).join(' | ')));
    }
    return { dry: true, hash, rows: jobs.reduce((n, j) => n + j.rows.length, 0) };
  }

  if (cfg.transport === 'none') {
    throw new Error('Not configured. Set webAppUrl (Apps Script) or spreadsheetId (service account) in config/sheets.json — see SHEETS-SETUP.md.');
  }

  const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
  const T = cfg.transport === 'appscript'
    ? require('./lib/sheets-appscript')
    : require('./lib/sheets-service-account');

  const totals = { added: 0, updated: 0, unchanged: 0 };
  let status = 'OK', detail = '';
  try {
    for (const j of jobs) {
      const cols  = { RATES_COLS: j.headers, SUM_COLS: P.SUM_COLS, LOG_COLS: P.LOG_COLS };
      const built = { rateRows: j.rows, sumRows: [], meta: j.meta };
      const r = await T.sync(cfg, built, cols, null,
        { chunkSize: cfg.chunkSize, reset: RESET, ratesTab: j.tab, resetTabs: [j.tab] });
      totals.added += r.rates.added; totals.updated += r.rates.updated; totals.unchanged += r.rates.unchanged;
    }
  } catch (e) { status = 'FAILED'; detail = e.message; throw e; }
  finally {
    const logRow = [
      new Date().toISOString(), trigger, scrapedAt, hash, jobs[0].meta.properties,
      jobs.reduce((n, j) => n + j.rows.length, 0), totals.added, totals.updated, totals.unchanged,
      0, 0, secs(), status, detail.slice(0, 300),
    ];
    if (cfg.syncLog) {
      try {
        if (cfg.transport === 'appscript') {
          await T.sync(cfg, { rateRows: [], sumRows: [], meta: {} },
            { RATES_COLS: jobs[0].headers, SUM_COLS: P.SUM_COLS, LOG_COLS: P.LOG_COLS },
            logRow, { chunkSize: cfg.chunkSize, ratesTab: jobs[0].tab });
        } else {
          await T.appendLog(cfg, P.LOG_COLS, logRow);
        }
      } catch (e) { console.warn('  ⚠ could not write Sync Log:', e.message); }
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    lastHash: hash, lastSyncAt: new Date().toISOString(), lastScrapedAt: scrapedAt,
    transport: cfg.transport, mode: cfg.mode,
    tabs: jobs.map(j => ({ tab: j.tab, rows: j.rows.length })),
  }, null, 2));

  console.log(`  ✓ Synced in ${secs()}s`);
  return { hash, ...totals };
}

// ── watch ─────────────────────────────────────────────────────────────────────
async function watch() {
  const cfg = loadConfig();
  const every = INTERVAL || cfg.syncIntervalSec || 0;
  console.log(`\n  Watching data/latest.dashboard.json for pricing changes (transport: ${cfg.transport}, mode: ${cfg.mode})…`);
  if (every) console.log(`  Also forcing a sync every ${every}s`);
  console.log('  Ctrl+C to stop.\n');

  let busy = false;
  const run = async trigger => {
    if (busy) return;
    busy = true;
    try { await syncOnce(trigger); }
    catch (e) { console.error('  ✗ sync failed:', e.message); }
    finally { busy = false; }
  };

  await run('startup');

  let timer = null;
  fs.watch(path.dirname(P.DASH_FILE), (ev, f) => {
    if (f !== path.basename(P.DASH_FILE)) return;
    clearTimeout(timer);
    timer = setTimeout(() => run('data-change'), 2500);   // debounce the write
  });
  if (every) setInterval(() => run('interval'), every * 1000);
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (HEALTH) {
    const cfg = loadConfig();
    if (cfg.transport !== 'appscript') throw new Error('--health only applies to the Apps Script transport.');
    const h = await require('./lib/sheets-appscript').health(cfg);
    console.log('\n  Web App health:', JSON.stringify(h, null, 2), '\n');
    return;
  }
  if (WATCH) return watch();
  const r = await syncOnce(arg('trigger') || 'manual');
  if (r.skipped) process.exit(0);
})().catch(e => { console.error('\n  FAILED:', e.message, '\n'); process.exit(1); });
