/**
 * Competitor Price Analyzer — Google Sheets receiver
 *
 * Paste this into the Apps Script editor of the target spreadsheet
 * (Extensions → Apps Script), set SHARED_SECRET below, then deploy as a Web App.
 * Full instructions: SHEETS-SETUP.md in the project.
 *
 * The Node sync (sync-sheets.js) POSTs pricing rows here; this script upserts them
 * by the natural key in column A. No service account or Google Cloud project needed —
 * the script is bound to this sheet and runs as you.
 *
 * Deploy: Deploy → New deployment → type "Web app"
 *           Execute as:      Me
 *           Who has access:  Anyone
 *         Copy the /exec URL into config/sheets.json as webAppUrl.
 *
 * "Anyone" is required because the Node script calls it without a Google login.
 * SHARED_SECRET is what actually guards it — treat that string like a password.
 */

// ── CHANGE THIS to a long random string, and put the same value in config/sheets.json
var SHARED_SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';

var TAB_LOG = 'Sync Log';

function doPost(e) {
  var t0 = new Date().getTime();
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: 'empty request body' });
    }
    var body = JSON.parse(e.postData.contents);

    if (!SHARED_SECRET || SHARED_SECRET === 'CHANGE_ME_TO_A_LONG_RANDOM_STRING') {
      return json_({ ok: false, error: 'SHARED_SECRET not set in Code.gs' });
    }
    if (body.secret !== SHARED_SECRET) {
      return json_({ ok: false, error: 'unauthorized' });
    }

    // Serialise concurrent posts so two chunks can't interleave a read-merge-write
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(60000)) return json_({ ok: false, error: 'busy — another sync is writing' });

    try {
      var result = { ok: true, tabs: {} };

      // Delete every sheet except the named ones. A spreadsheet must keep at least
      // one sheet, so this refuses to run if it would remove them all.
      if (body.keepOnly && body.keepOnly.length) {
        result.deleted = deleteAllExcept_(body.keepOnly);
      }

      // Explicit opt-in wipe of data rows (headers kept). Used when the sync scope
      // narrows, so rows for properties no longer in scope don't linger.
      if (body.reset && body.reset.length) {
        result.reset = {};
        for (var t = 0; t < body.reset.length; t++) {
          result.reset[body.reset[t]] = clearTab_(body.reset[t]);
        }
      }

      if (body.rates && body.rates.rows && body.rates.rows.length) {
        result.tabs.rates = upsert_(body.rates.tab || 'Rates', body.rates.headers, body.rates.rows);
      }
      if (body.summary && body.summary.rows && body.summary.rows.length) {
        result.tabs.summary = upsert_(body.summary.tab || 'Property Summary', body.summary.headers, body.summary.rows);
      }

      // Log only on the final chunk, so one run produces one log line
      if (body.log && body.isLastChunk !== false) {
        appendLog_(body.log.headers, body.log.row);
      }

      result.durationMs = new Date().getTime() - t0;
      return json_(result);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/** Health check: open the /exec URL in a browser to confirm the deployment works. */
function doGet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = ss.getSheets().map(function (s) {
    return { name: s.getName(), rows: Math.max(0, s.getLastRow() - 1) };
  });
  return json_({
    ok: true,
    service: 'Competitor Price Analyzer — Sheets receiver',
    spreadsheet: ss.getName(),
    secretConfigured: SHARED_SECRET !== 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
    tabs: tabs,
  });
}

/**
 * Upsert rows by the natural key in column A.
 *
 * Reads the whole data range once, merges in memory, writes once. Doing it this way
 * keeps a 1,000+ row sync inside the Apps Script execution limit — per-row
 * setValues() calls would not finish.
 */
function upsert_(tabName, headers, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(tabName);
  var created = false;
  if (!sh) { sh = ss.insertSheet(tabName); created = true; }

  var nCols = headers.length;
  if (sh.getMaxColumns() < nCols) sh.insertColumnsAfter(sh.getMaxColumns(), nCols - sh.getMaxColumns());

  // Header: write it if missing or drifted, so columns can never silently misalign
  var headerRow = sh.getRange(1, 1, 1, nCols).getValues()[0];
  if (headerRow.join('|') !== headers.join('|')) {
    sh.getRange(1, 1, 1, nCols).setValues([headers]);
    sh.getRange(1, 1, 1, nCols).setFontWeight('bold').setBackground('#eef1f4');
    sh.setFrozenRows(1);
  }

  var lastRow = sh.getLastRow();
  var data = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, nCols).getValues() : [];

  var idx = {};
  for (var i = 0; i < data.length; i++) {
    var k = data[i][0];
    if (k !== '' && k != null) idx[norm_(k)] = i;
  }

  var added = 0, updated = 0, unchanged = 0;
  // Track the touched span so we write back only the rows that actually changed.
  // Rewriting the whole range on every chunk is O(sheet size) per chunk, which turns
  // a 32k-row load into minutes; appends are contiguous so this collapses to the new block.
  var minDirty = -1, maxDirty = -1;
  function markDirty_(i) {
    if (minDirty < 0 || i < minDirty) minDirty = i;
    if (i > maxDirty) maxDirty = i;
  }

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    // pad/trim to the header width so setValues never throws on ragged rows
    while (row.length < nCols) row.push('');
    if (row.length > nCols) row = row.slice(0, nCols);

    var key = norm_(row[0]);
    if (Object.prototype.hasOwnProperty.call(idx, key)) {
      var at = idx[key];
      var cur = data[at];
      var same = true;
      // compare all but the trailing Last Synced column
      for (var c = 0; c < nCols - 1; c++) {
        if (norm_(cur[c]) !== norm_(row[c])) { same = false; break; }
      }
      if (same) { unchanged++; continue; }
      data[at] = row;
      markDirty_(at);
      updated++;
    } else {
      idx[key] = data.length;
      data.push(row);
      markDirty_(data.length - 1);
      added++;
    }
  }

  if (minDirty >= 0) {
    var need = data.length + 1;
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    var span = maxDirty - minDirty + 1;
    sh.getRange(2 + minDirty, 1, span, nCols).setValues(data.slice(minDirty, maxDirty + 1));
  }

  return { tab: tabName, created: created, added: added, updated: updated,
           unchanged: unchanged, total: data.length, wrote: minDirty < 0 ? 0 : (maxDirty - minDirty + 1) };
}

/**
 * Normalise a cell for key matching and change comparison.
 *
 * Sheets silently coerces a bare "2026-08-08" into a Date value. Reading it back
 * then yields a Date object whose String() form never equals the text we sent, so
 * every sync would treat the row as new and append a duplicate. Converting Dates
 * back to yyyy-MM-dd makes the comparison stable. Numbers are normalised too, so
 * "599" and 599 are treated as equal.
 */
function norm_(v) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (typeof v === 'number') return String(v);
  return String(v);
}

/**
 * Delete every sheet whose name is not in `keep`. Returns the names removed.
 * Refuses to act if nothing would survive — Sheets requires at least one sheet.
 */
function deleteAllExcept_(keep) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var all = ss.getSheets();
  var keepSet = {};
  for (var i = 0; i < keep.length; i++) keepSet[String(keep[i])] = true;

  var survivors = all.filter(function (s) { return keepSet[s.getName()]; });
  if (!survivors.length) return { error: 'refused — none of ' + keep.join(', ') + ' exist; would delete every sheet' };

  var removed = [];
  for (var j = 0; j < all.length; j++) {
    if (keepSet[all[j].getName()]) continue;
    removed.push(all[j].getName());
    ss.deleteSheet(all[j]);
  }
  return { removed: removed, kept: survivors.map(function (s) { return s.getName(); }) };
}

/** Delete every data row on a tab, keeping the header. Returns rows removed. */
function clearTab_(tabName) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  sh.deleteRows(2, last - 1);
  return last - 1;
}

function appendLog_(headers, row) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB_LOG);
  if (!sh) {
    sh = ss.insertSheet(TAB_LOG);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#eef1f4');
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sh.appendRow(row);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
