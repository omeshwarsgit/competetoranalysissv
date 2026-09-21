'use strict';
/**
 * scheduled-refresh.js — Daily price-scrape runner
 *
 * Only *discovery* was ever scheduled (scheduled-scan.js / setup-daily-scan.bat), so the
 * competitor list stayed fresh while the rates behind it did not: the history directory had
 * accumulated just 8 snapshots, because a snapshot is only written when refresh.js runs. This
 * is the missing half — it scrapes 30 nights for every own property and its competitors, then
 * pushes the result to Google Sheets if that is configured.
 *
 * ON LOGIN
 *   refresh.js drives the user's real Chrome profile over CDP, so the Booking.com session
 *   persists between runs and an unattended run normally just works. When the session HAS
 *   expired, refresh.js waits ~2 minutes for a human and then exits non-zero — this runner
 *   propagates that, so the Task Scheduler entry shows "last result: failure" rather than
 *   quietly recording a day of no data. Check the log if a day is missing.
 *
 * Usage:  node scheduled-refresh.js [--no-sync] [--property=<id>]
 * Setup:  run setup-daily-refresh.bat once to register it as a Windows Task
 */
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const SHEETS_CFG = path.join(__dirname, 'config', 'sheets.json');
const LOG_FILE   = path.join(__dirname, 'data', 'refresh-log.json');
const DASH_FILE  = path.join(__dirname, 'data', 'latest.dashboard.json');

const NO_SYNC  = process.argv.includes('--no-sync');
const PROPERTY = (process.argv.find(a => a.startsWith('--property=')) || '').split('=')[1] || null;

function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }

/** Run a project script, streaming its output into this log. Resolves with the exit code. */
function run(script, args = []) {
  return new Promise(resolve => {
    log(`→ node ${script} ${args.join(' ')}`);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const relay = prefix => d => d.toString().split('\n')
      .map(l => l.trimEnd()).filter(Boolean)
      .forEach(l => log(`  ${prefix}${l}`));
    child.stdout.on('data', relay(''));
    child.stderr.on('data', relay('ERR: '));
    child.on('close', code => { log(`← ${script} exited ${code}`); resolve(code); });
    child.on('error', e => { log(`← ${script} failed to start: ${e.message}`); resolve(-1); });
  });
}

/** Count how many nights actually carry a price, so the log records substance, not just success. */
function summarise() {
  try {
    const d = JSON.parse(fs.readFileSync(DASH_FILE, 'utf8'));
    let own = 0, priced = 0, soldOut = 0;
    for (const e of Object.values(d.portfolio || {})) {
      own++;
      for (const r of Object.values(e.rooms || {})) {
        priced += Object.values(r.observed || {}).filter(v => v != null).length;
      }
      soldOut += (e.soldOutDates || []).length;
    }
    return { today: d.meta?.today || null, scrapedAt: d.meta?.scrapedAt || null,
             ownProperties: own, competitors: Object.keys(d.competitors || {}).length,
             pricedNights: priced, soldOutNights: soldOut };
  } catch (_) { return null; }
}

async function main() {
  log('=== StayVista Daily Price Refresh ===');

  const refreshArgs = PROPERTY ? [`--property=${PROPERTY}`] : [];
  const refreshCode = await run('refresh.js', refreshArgs);

  let syncCode = null;
  if (refreshCode === 0 && !NO_SYNC && fs.existsSync(SHEETS_CFG)) {
    syncCode = await run('sync-sheets.js', ['--trigger=post-refresh']);
  } else if (refreshCode === 0 && !NO_SYNC) {
    log('config/sheets.json absent — skipping the Sheets sync.');
  }

  const summary = summarise();
  if (summary) {
    log(`Data: ${summary.ownProperties} own + ${summary.competitors} competitors · `
      + `${summary.pricedNights} priced nights · ${summary.soldOutNights} sold-out · today=${summary.today}`);
  }

  // Keep the last 30 runs, same convention as scheduled-scan.js's scan-log.json.
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (_) {}
  entries.unshift({
    runAt: new Date().toISOString(),
    property: PROPERTY,
    refreshExit: refreshCode,
    syncExit: syncCode,
    ok: refreshCode === 0,
    summary,
  });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries.slice(0, 30), null, 2));

  if (refreshCode !== 0) {
    log('=== FAILED: price scrape did not complete. Most likely the Booking.com session '
      + 'expired — open Chrome, log in, and re-run. ===');
    process.exit(1);
  }
  if (syncCode !== null && syncCode !== 0) {
    log('=== Prices scraped, but the Sheets sync failed. ===');
    process.exit(2);
  }
  log('=== Refresh complete ===');
}

main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
