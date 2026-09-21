'use strict';
/**
 * scheduled-scan.js — Daily competitor discovery runner
 *
 * Reads all own properties from config/properties.json and runs
 * discover.js --force for each one sequentially, so the full-market
 * cache stays fresh and new Booking.com properties are detected daily.
 *
 * Then runs sync-inventory.js, which is what turns a scan into a maintained inventory: newly
 * listed properties get linked so they are actually priced, and properties absent for several
 * consecutive scans are confirmed against their own Booking.com page and deactivated if genuinely
 * delisted. Scanning without that step only ever accumulates — nothing would ever leave.
 *
 * Usage:  node scheduled-scan.js [--no-inventory]
 * Setup:  run setup-daily-scan.bat once to register as a Windows Task
 */
const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');

const CONFIG_FILE  = path.join(__dirname, 'config', 'properties.json');
const LOG_FILE     = path.join(__dirname, 'data', 'scan-log.json');

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function runDiscover(propId) {
  return new Promise((resolve) => {
    log(`Starting discovery for: ${propId}`);
    const child = spawn(process.execPath, ['discover.js', `--property=${propId}`, '--force'], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lastStatus = '';
    child.stdout.on('data', d => {
      d.toString().split('\n').filter(Boolean).forEach(line => {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'status' || obj.type === 'done' || obj.type === 'error') {
            log(`  [${propId}] ${obj.message || JSON.stringify(obj)}`);
            lastStatus = obj.type;
          }
        } catch (_) {}
      });
    });
    child.stderr.on('data', d => { log(`  [${propId}] ERR: ${d.toString().trim()}`); });
    child.on('close', code => resolve({ propId, ok: code === 0, lastStatus }));
  });
}

async function main() {
  log('=== StayVista Daily Competitor Scan ===');

  if (!fs.existsSync(CONFIG_FILE)) {
    log('ERROR: config/properties.json not found. Run import-properties.js first.');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const ownProps = (config.properties || []).filter(p => p.type === 'own');

  if (!ownProps.length) {
    log('No own properties found in config. Nothing to scan.');
    process.exit(0);
  }

  log(`Found ${ownProps.length} own properties to scan.`);
  const results = [];

  for (const p of ownProps) {
    const result = await runDiscover(p.id);
    results.push({ ...result, scanTime: new Date().toISOString() });
    // Brief pause between properties
    if (ownProps.indexOf(p) < ownProps.length - 1) {
      log('Waiting 5s before next property…');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Append to scan log
  let log_data = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log_data = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (_) {}
  }
  log_data.unshift({ runAt: new Date().toISOString(), results });
  if (log_data.length > 30) log_data = log_data.slice(0, 30); // keep last 30 runs
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log_data, null, 2));

  const ok = results.filter(r => r.ok).length;
  log(`=== Scan complete: ${ok}/${results.length} properties succeeded ===`);

  // Reconcile the inventory against what the scan just found. Skipped when every scan failed —
  // a run where nothing was found would otherwise treat the whole market as absent, and although
  // sync-inventory confirms before delisting anything, spending hundreds of page fetches to
  // rediscover that is pointless.
  if (process.argv.includes('--no-inventory')) {
    log('Inventory sync skipped (--no-inventory).');
    return;
  }
  if (!ok) {
    log('No property scanned successfully — skipping the inventory sync.');
    return;
  }
  log('--- Inventory sync ---');
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, ['sync-inventory.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = pre => d => d.toString().split('\n').map(l => l.trimEnd()).filter(Boolean).forEach(l => log(`  ${pre}${l}`));
    child.stdout.on('data', relay(''));
    child.stderr.on('data', relay('ERR: '));
    child.on('close', c => resolve(c));
    child.on('error', e => { log(`sync-inventory failed to start: ${e.message}`); resolve(-1); });
  });
  log(`=== Inventory sync exited ${code} ===`);
  if (code !== 0) process.exitCode = 1;
}

main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
