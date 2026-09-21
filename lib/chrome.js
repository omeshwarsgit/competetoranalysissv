'use strict';
/**
 * lib/chrome.js — Shared Chrome management (cross-platform)
 * Detects Chrome path from env var, common OS locations, or PATH.
 * Usage: const { ensureChrome, CDP_URL } = require('./lib/chrome');
 */
const http          = require('http');
const { execSync, spawn } = require('child_process');
const path          = require('path');
const fs            = require('fs');

const CDP_URL  = process.env.CDP_URL  || 'http://127.0.0.1:9222';
const CDP_PORT = parseInt((CDP_URL.split(':')[2] || '9222'), 10);

// ── Cross-platform Chrome path resolution ─────────────────────────────────────
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ],
  };

  const list = candidates[process.platform] || candidates.linux;
  for (const c of list) {
    if (c && fs.existsSync(c)) return c;
  }

  // Try PATH
  try {
    const cmd = process.platform === 'win32' ? 'where chrome' : 'which google-chrome || which chromium-browser || which chromium';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0].trim();
    if (out && fs.existsSync(out)) return out;
  } catch (_) {}

  throw new Error(
    'Chrome not found. Install Google Chrome or set the CHROME_PATH environment variable.\n' +
    '  e.g.: CHROME_PATH="/usr/bin/chromium-browser" node serve.js'
  );
}

// ── Ping CDP endpoint ─────────────────────────────────────────────────────────
function pingCDP() {
  return new Promise((resolve, reject) => {
    const req = http.get(CDP_URL + '/json', (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.setTimeout(1500, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Detect if user's main Chrome is running (Windows only) ───────────────────
function isMainChromeRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.includes('chrome.exe');
  } catch (_) {
    return false;
  }
}

// ── Temp profile directory (platform-aware) ───────────────────────────────────
function getTempProfileDir() {
  if (process.env.CHROME_PROFILE_DIR) return process.env.CHROME_PROFILE_DIR;
  if (process.platform === 'win32') return 'C:\\temp\\chrome-cdp';
  return path.join(require('os').tmpdir(), 'chrome-cdp-sv');
}

// ── Main: ensure Chrome is running with debug port ────────────────────────────
async function ensureChrome() {
  const isRefresh = process.argv[1] && process.argv[1].includes('refresh.js');
  
  if (isRefresh) {
    // Terminate ONLY the process listening on CDP_PORT to avoid killing the user's personal Chrome
    try {
      if (process.platform === 'win32') {
        const netstat = execSync('netstat -ano', { encoding: 'utf8' });
        const lines = netstat.split('\n');
        for (const line of lines) {
          if (line.includes(`:${CDP_PORT}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && pid !== '0') {
              execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
            }
          }
        }
      } else {
        const lsof = execSync(`lsof -t -i:${CDP_PORT}`, { encoding: 'utf8' }).trim();
        if (lsof) {
          execSync(`kill -9 ${lsof}`, { stdio: 'ignore' });
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (_) {}
  } else {
    // Already running?
    try { await pingCDP(); return; } catch (_) {}
  }

  const chromePath = findChrome();
  const profileDir = getTempProfileDir();
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-sync',
  ];

  if (!isRefresh) {
    args.unshift('--headless=new');
  }

  if (isMainChromeRunning()) {
    console.log('Chrome is running — launching temp-profile debug instance alongside (your tabs stay open)…');
  } else {
    console.log('Launching Chrome with debug port…');
  }

  spawn(chromePath, args, { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { await pingCDP(); console.log('Chrome ready.'); return; } catch (_) {}
  }

  throw new Error(
    'Chrome did not start on time. Try:\n' +
    '  1. Close all Chrome windows and retry.\n' +
    '  2. Set CHROME_PATH to your Chrome executable.\n' +
    `  3. Launch Chrome manually with: --remote-debugging-port=${CDP_PORT} --user-data-dir=${profileDir}`
  );
}

module.exports = { ensureChrome, CDP_URL, findChrome };
