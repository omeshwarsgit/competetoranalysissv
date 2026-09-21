/**
 * lib/json-store.js — optimistic-concurrency helpers for the JSON files that act as this
 * project's database.
 *
 * THE PROBLEM
 *   `config/properties.json` is read-modify-written by five independent things
 *   (`import-properties.js`, `discover.js`, `resolve-property-coords.js`, `sync-inventory.js`,
 *   and several `serve.js` endpoints). None of them coordinated, so two overlapping runs produced a
 *   lost update: whichever wrote second silently discarded everything the first had done. On
 *   2026-08-11 property 1's `competitors[]` went from 12 entries to 2 this way, and because nothing
 *   recorded who wrote what, it was not attributable afterwards.
 *
 *   The dangerous writers are the ones with a long gap between read and write —
 *   `resolve-property-coords.js` drives a browser for minutes, `sync-inventory.js` probes property
 *   pages — during which a dashboard click can rewrite the same file.
 *
 * THE APPROACH
 *   Optimistic concurrency, not locking. Record the file's mtime when reading; refuse to write if
 *   it changed. A lock file would need stale-lock recovery and could wedge the scheduled tasks;
 *   aborting a run that would otherwise destroy data is strictly better than the run succeeding.
 *   Losing a scan costs one re-run. Losing linked competitors loses price history permanently,
 *   because rates are only observable going forward.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

/** Read a JSON file and remember the version we read, so a later write can verify it. */
function readTracked(file, fallback = null) {
  try {
    const st = fs.statSync(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { data, mtimeMs: st.mtimeMs, existed: true, file };
  } catch (_) {
    return { data: fallback, mtimeMs: null, existed: false, file };
  }
}

/**
 * Write only if the file still looks like what `readTracked` saw.
 *
 * @param {object} tracked  the object returned by readTracked
 * @param {*}      data     what to write
 * @param {{pretty?:boolean}} opts
 * @throws {Error} with `.code = 'ESTALE'` when the file changed underneath
 */
function writeIfUnchanged(tracked, data, opts = {}) {
  const { file, mtimeMs, existed } = tracked;
  let current = null;
  try { current = fs.statSync(file).mtimeMs; } catch (_) { current = null; }

  const changed = existed
    ? current !== mtimeMs
    // It did not exist when we read it; someone else creating it in the meantime is also a conflict.
    : current !== null;

  if (changed) {
    const err = new Error(
      `${path.basename(file)} was modified by something else while this run was working.\n`
      + '    Refusing to write, because doing so would silently discard those changes.\n'
      + '    Nothing has been written. Close the dashboard (or wait for the other job to finish)\n'
      + '    and re-run.');
    err.code = 'ESTALE';
    throw err;
  }

  // write-then-rename so a reader never sees a half-written file
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, opts.pretty === false ? JSON.stringify(data) : JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  // Hand back a tracker for the version we just wrote, so a caller can write again safely.
  try { return { ...tracked, mtimeMs: fs.statSync(file).mtimeMs, existed: true }; }
  catch (_) { return tracked; }
}

module.exports = { readTracked, writeIfUnchanged };
