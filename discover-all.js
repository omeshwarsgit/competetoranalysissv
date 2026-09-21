'use strict';
/**
 * discover-all.js — Run discover.js for every own property sequentially.
 *
 * Usage:
 *   node discover-all.js            # skips properties that already have cache
 *   node discover-all.js --force    # re-scan every property (what you want for a refresh)
 *   node discover-all.js --only=ID1,ID2  # run specific property IDs only
 *   node discover-all.js --timeout=20    # per-property minutes before the child is killed
 *
 * ON THE TIMEOUT
 *   `discover.js` writes the discovery cache once, at the very end of a scan. Killing it partway
 *   therefore throws away the whole scan, not just the remainder. The cap used to be a flat 5
 *   minutes, which was under half of what a real scan needs: property 1's scan of 847 properties
 *   took ~10 minutes because the text-search stage fired and paginated deeply. So the default is
 *   now 20 minutes, and a timeout is reported as a failure rather than passing quietly.
 *
 * Progress is logged to discover-all.log in real time.
 */

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');

const CONFIG_FILE = path.join(__dirname, 'config', 'properties.json');
const DISC_FILE   = path.join(__dirname, 'data', 'discovery-cache.json');
const LOG_FILE    = path.join(__dirname, 'discover-all.log');

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);
const force  = args.force !== undefined;
const onlyIds = args.only ? args.only.split(',').map(s => s.trim()) : null;
const TIMEOUT_MIN = Math.max(1, parseFloat(args.timeout || '20'));

// Load config
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const ownProps = config.properties.filter(p => p.type === 'own');

// Load existing cache
let disc = {};
if (fs.existsSync(DISC_FILE)) {
  try { disc = JSON.parse(fs.readFileSync(DISC_FILE, 'utf8')); } catch (_) {}
}

// Determine which to run
let toRun = ownProps;
if (onlyIds) toRun = toRun.filter(p => onlyIds.includes(p.id));
if (!force)  toRun = toRun.filter(p => !disc[p.id]);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function runOne(prop) {
  return new Promise((resolve) => {
    log(`START  [${prop.id}] ${prop.display}`);
    const child = spawn(process.execPath, ['discover.js', `--property=${prop.id}`], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Kill a genuinely hung child. discover.js only writes its cache at the end of a scan, so this
    // discards the entire scan — hence a generous default (see the header) rather than 5 minutes.
    let timedOut = false;
    const runTimeout = setTimeout(() => {
      timedOut = true;
      log(`TIMEOUT [${prop.id}] Process exceeded ${TIMEOUT_MIN} minutes. Killing — this scan's results are lost.`);
      log(`        If real scans legitimately take longer, re-run with --timeout=${Math.ceil(TIMEOUT_MIN * 2)}`);
      child.kill('SIGKILL');
    }, TIMEOUT_MIN * 60 * 1000);

    let lastStatus = '';
    child.stdout.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const obj = JSON.parse(s);
          if (obj.type === 'done') {
            log(`DONE   [${prop.id}] ${obj.message}`);
          } else if (obj.type === 'error') {
            log(`ERROR  [${prop.id}] ${obj.message}`);
          } else if (obj.type === 'status' && obj.message !== lastStatus) {
            lastStatus = obj.message;
            log(`STATUS [${prop.id}] ${obj.message}`);
          }
        } catch (_) {
          if (s) log(`OUT    [${prop.id}] ${s}`);
        }
      }
    });

    child.stderr.on('data', chunk => {
      const s = chunk.toString().trim();
      if (s) log(`STDERR [${prop.id}] ${s}`);
    });

    child.on('close', code => {
      clearTimeout(runTimeout);
      // A SIGKILL'd child can exit with a null/zero-ish code; a timeout is a failure regardless.
      const effective = timedOut ? -2 : code;
      log(`EXIT   [${prop.id}] code=${effective}${timedOut ? ' (timed out)' : ''}`);
      resolve(effective);
    });
  });
}

async function main() {
  if (toRun.length === 0) {
    log('Nothing to run. All properties already have discovery data. Use --force to re-run.');
    return;
  }

  log(`=== discover-all starting: ${toRun.length} properties to scan ===`);
  log(`Properties: ${toRun.map(p => p.id).join(', ')}`);

  const results = { ok: [], failed: [] };

  for (let i = 0; i < toRun.length; i++) {
    const prop = toRun[i];
    log(`\n[${i + 1}/${toRun.length}] Starting: ${prop.display} (${prop.city})`);
    const code = await runOne(prop);
    if (code === 0) results.ok.push(prop.id);
    else results.failed.push(prop.id);
  }

  log(`\n=== discover-all complete ===`);
  log(`Success (${results.ok.length}): ${results.ok.join(', ') || 'none'}`);
  if (results.failed.length) {
    log(`Failed  (${results.failed.length}): ${results.failed.join(', ')}`);
  }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
