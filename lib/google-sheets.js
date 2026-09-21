/**
 * lib/google-sheets.js
 *
 * Minimal zero-dependency Google Sheets v4 client.
 *
 * Uses a service-account JWT signed with Node's built-in crypto, exchanged for an
 * access token — no googleapis package, no OAuth browser flow, so it runs
 * unattended from cron/Task Scheduler.
 *
 * Credentials are resolved in this order:
 *   1. process.env.GOOGLE_APPLICATION_CREDENTIALS  (path to service-account JSON)
 *   2. config/google-service-account.json
 *
 * The target spreadsheet must be shared (Editor) with the service account's
 * client_email, otherwise every write returns 403.
 */
'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const SCOPE      = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const API        = 'https://sheets.googleapis.com/v4/spreadsheets';
const CRED_PATHS = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  path.join(__dirname, '..', 'config', 'google-service-account.json'),
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadCredentials() {
  for (const p of CRED_PATHS) {
    if (!fs.existsSync(p)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { throw new Error(`Service-account file is not valid JSON: ${p} (${e.message})`); }
    if (!j.client_email || !j.private_key) {
      throw new Error(`Service-account file is missing client_email/private_key: ${p}`);
    }
    return { ...j, _path: p };
  }
  throw new Error(
    'No Google credentials found. Place a service-account JSON at ' +
    'config/google-service-account.json or set GOOGLE_APPLICATION_CREDENTIALS.'
  );
}

// ── auth ──────────────────────────────────────────────────────────────────────
let _tok = null;   // { token, exp }

async function getAccessToken(creds) {
  if (_tok && Date.now() < _tok.exp - 60_000) return _tok.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' +
    b64({ iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(creds.private_key, 'base64url');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  const j = JSON.parse(body);
  _tok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _tok.token;
}

// ── request with retry ────────────────────────────────────────────────────────
async function api(creds, method, urlPath, body, attempt = 0) {
  const token = await getAccessToken(creds);
  const res = await fetch(API + urlPath, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 5) {
      // Sheets quota is per-minute; back off generously rather than hammering
      await sleep(Math.min(32000, 1000 * 2 ** attempt) + Math.random() * 500);
      return api(creds, method, urlPath, body, attempt + 1);
    }
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try { msg = JSON.parse(text).error?.message || msg; } catch (_) {}
    const err = new Error(`Sheets ${method} ${urlPath} → ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

const enc = s => encodeURIComponent(s);

// ── spreadsheet ops ───────────────────────────────────────────────────────────
async function getSpreadsheet(creds, id) {
  return api(creds, 'GET', `/${id}?fields=spreadsheetId,properties.title,sheets(properties(sheetId,title,gridProperties))`);
}

/** Create the tab if absent; returns its sheetId. Never touches an existing tab's data. */
async function ensureSheet(creds, id, title, colCount) {
  const ss = await getSpreadsheet(creds, id);
  const found = ss.sheets.find(s => s.properties.title === title);
  if (found) return { sheetId: found.properties.sheetId, created: false, spreadsheetTitle: ss.properties.title };
  const out = await api(creds, 'POST', `/${id}:batchUpdate`, {
    requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: Math.max(colCount || 26, 26), frozenRowCount: 1 } } } }],
  });
  return { sheetId: out.replies[0].addSheet.properties.sheetId, created: true, spreadsheetTitle: ss.properties.title };
}

async function getValues(creds, id, range) {
  const r = await api(creds, 'GET', `/${id}/values/${enc(range)}?majorDimension=ROWS`);
  return r.values || [];
}

async function updateValues(creds, id, range, values) {
  return api(creds, 'PUT', `/${id}/values/${enc(range)}?valueInputOption=RAW`, { range, majorDimension: 'ROWS', values });
}

async function appendValues(creds, id, range, values) {
  return api(creds, 'POST',
    `/${id}/values/${enc(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { range, majorDimension: 'ROWS', values });
}

/** Several disjoint ranges in one request — the efficient way to patch changed rows. */
async function batchUpdateValues(creds, id, data) {
  if (!data.length) return { totalUpdatedCells: 0 };
  const out = { totalUpdatedCells: 0 };
  // Sheets rejects very large payloads; chunk the range list
  for (let i = 0; i < data.length; i += 500) {
    const r = await api(creds, 'POST', `/${id}/values:batchUpdate`, {
      valueInputOption: 'RAW', data: data.slice(i, i + 500),
    });
    out.totalUpdatedCells += r.totalUpdatedCells || 0;
  }
  return out;
}

async function ensureCapacity(creds, id, sheetId, neededRows, neededCols) {
  const ss = await getSpreadsheet(creds, id);
  const sh = ss.sheets.find(s => s.properties.sheetId === sheetId);
  if (!sh) return;
  const g = sh.properties.gridProperties || {};
  const reqs = [];
  if ((g.rowCount || 0) < neededRows) {
    reqs.push({ appendDimension: { sheetId, dimension: 'ROWS', length: neededRows - g.rowCount + 100 } });
  }
  if (neededCols && (g.columnCount || 0) < neededCols) {
    reqs.push({ appendDimension: { sheetId, dimension: 'COLUMNS', length: neededCols - g.columnCount } });
  }
  if (reqs.length) await api(creds, 'POST', `/${id}:batchUpdate`, { requests: reqs });
}

/** Bold + freeze the header row. Cosmetic only, applied once on tab creation. */
async function formatHeader(creds, id, sheetId, colCount) {
  await api(creds, 'POST', `/${id}:batchUpdate`, { requests: [
    { repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: .93, green: .95, blue: .97 } } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
  ]});
}

// A1 column label for a 1-based index (1 → A, 27 → AA)
function colA1(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// getAccessToken / getSpreadsheet / CRED_PATHS are used internally only — not exported.
module.exports = {
  loadCredentials, ensureSheet, ensureCapacity, formatHeader,
  getValues, updateValues, appendValues, batchUpdateValues, colA1,
};
