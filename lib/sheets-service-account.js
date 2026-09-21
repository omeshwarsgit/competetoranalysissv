/**
 * lib/sheets-service-account.js
 *
 * Sync transport that writes to the Google Sheets REST API using a service-account
 * JWT. Selected when config/sheets.json has spreadsheetId and no webAppUrl.
 *
 * Needs a Google Cloud project, the Sheets API enabled, a service-account key, and
 * the sheet shared with the service account as Editor. The Apps Script transport
 * (lib/sheets-appscript.js) avoids all of that — prefer it unless you specifically
 * want server-to-server auth.
 */
'use strict';
const G = require('./google-sheets');

/** Upsert rows into one tab, keyed on column A. */
async function upsertTab(creds, id, tab, cols, rows, dry) {
  const { sheetId, created } = await G.ensureSheet(creds, id, tab, cols.length);
  if (created) {
    await G.updateValues(creds, id, `${tab}!A1`, [cols]);
    await G.formatHeader(creds, id, sheetId, cols.length);
  } else {
    const hdr = await G.getValues(creds, id, `${tab}!A1:${G.colA1(cols.length)}1`);
    if (!hdr.length || hdr[0].join('|') !== cols.join('|')) {
      // header drift would silently misalign every column
      await G.updateValues(creds, id, `${tab}!A1`, [cols]);
    }
  }

  const lastCol = G.colA1(cols.length);
  const current = new Map();
  const all = await G.getValues(creds, id, `${tab}!A2:${lastCol}`);
  all.forEach((r, i) => { const k = r[0]; if (k) current.set(String(k), { row: i + 2, vals: r }); });

  const toUpdate = [], toAppend = [];
  let unchanged = 0;

  for (const row of rows) {
    const cur = current.get(String(row[0]));
    if (!cur) { toAppend.push(row); continue; }
    // compare all but the trailing Last Synced column
    const a = row.slice(0, -1).map(v => v == null ? '' : String(v)).join('');
    const b = cols.slice(0, -1).map((_, i) => cur.vals[i] == null ? '' : String(cur.vals[i])).join('');
    if (a === b) { unchanged++; continue; }
    toUpdate.push({ range: `${tab}!A${cur.row}:${lastCol}${cur.row}`, majorDimension: 'ROWS', values: [row] });
  }

  if (dry) {
    console.log(`  [dry-run] ${tab}: ${toAppend.length} to add, ${toUpdate.length} to update, ${unchanged} unchanged`);
    return { added: toAppend.length, updated: toUpdate.length, unchanged };
  }

  await G.ensureCapacity(creds, id, sheetId, current.size + toAppend.length + 10, cols.length);
  if (toUpdate.length) await G.batchUpdateValues(creds, id, toUpdate);
  for (let i = 0; i < toAppend.length; i += 5000) {
    await G.appendValues(creds, id, `${tab}!A1`, toAppend.slice(i, i + 5000));
  }
  console.log(`  ${tab}: +${toAppend.length} added · ${toUpdate.length} updated · ${unchanged} unchanged`);
  return { added: toAppend.length, updated: toUpdate.length, unchanged };
}

async function sync(cfg, built, cols, opts = {}) {
  if (!cfg.spreadsheetId) throw new Error('No spreadsheetId in config/sheets.json.');
  const creds = G.loadCredentials();
  const rates   = await upsertTab(creds, cfg.spreadsheetId, 'Rates', cols.RATES_COLS, built.rateRows, opts.dry);
  const summary = await upsertTab(creds, cfg.spreadsheetId, 'Property Summary', cols.SUM_COLS, built.sumRows, opts.dry);
  return { rates, summary };
}

async function appendLog(cfg, logCols, row) {
  const creds = G.loadCredentials();
  await G.ensureSheet(creds, cfg.spreadsheetId, 'Sync Log', logCols.length);
  const hdr = await G.getValues(creds, cfg.spreadsheetId, 'Sync Log!A1:A1');
  if (!hdr.length) await G.updateValues(creds, cfg.spreadsheetId, 'Sync Log!A1', [logCols]);
  await G.appendValues(creds, cfg.spreadsheetId, 'Sync Log!A1', [row]);
}

module.exports = { sync, appendLog };
