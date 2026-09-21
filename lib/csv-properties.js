/**
 * lib/csv-properties.js
 *
 * The one place that knows how to read properties.csv.
 *
 * Four separate scripts had each grown their own copy of this parser (serve.js,
 * import-properties.js, prune-to-csv.js, resolve-property-coords.js). They agreed today, but
 * the CSV contract has enough quirks — a column that changes meaning by row, legacy header
 * names, Windows-1252 encoding, ID normalisation — that four copies were four chances to
 * drift. A dropdown that disagrees with an importer about which properties exist is exactly
 * the class of bug this project has already been bitten by.
 *
 * THE CSV CONTRACT
 *   Property ID        StayVista's system ID. Blank on a competitor row.
 *   Property           Display name of YOUR property (Column B).
 *   Booking.com Link   Booking.com URL of YOUR property.
 *   Location           City/area for search — BUT on a row with no Property ID this column
 *                      instead holds the COMPETITOR'S NAME.
 *   Competitor Link    Booking.com URL of a manual competitor.
 *
 * A competitor row belongs to whichever own property appears ABOVE it, so row order matters.
 * One entry per Property ID: repeated IDs are separately sellable units of a single listing
 * ("Amber @ Golden Triangle") and collapse to one entry, first row winning.
 *
 * Legacy header names are still accepted, because sheets in the wild still use them.
 */
'use strict';
const fs = require('fs');

// Header aliases, most-current first
const H = {
  id:       ['Property ID', 'Property ID (according to our System)', 'Sr.', 'Sr'],
  name:     ['Property', 'Stayvista Property', 'Stayvista property'],
  url:      ['Booking.com Link', 'Own Link', 'Booking.com links'],
  location: ['Location', 'City'],
  compUrl:  ['Competitor Link', 'Deal % (own)', 'Deal %'],
};

/**
 * Split one CSV line, honouring double-quoted fields.
 *
 * A doubled quote inside a quoted field is one literal quote (RFC 4180) — Excel writes
 * `Casa ""Bella""` for `Casa "Bella"`. The earlier version simply flipped an in-quote flag on
 * every `"`, so it dropped those quotes entirely: formatCSVLine would write the escaped form
 * and this would read it back short. That made a read-modify-write of the sheet lossy, which
 * is exactly what `resolve-property-coords.js --write-csv` does to fix up a link.
 */
function parseCSVLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c !== '"') { cur += c; }
      else if (line[i + 1] === '"') { cur += '"'; i++; }   // "" -> literal "
      else { inQ = false; }
    } else if (c === '"') { inQ = true; }
    else if (c === ',') { out.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  out.push(cur.trim());
  return out;
}

const WIN1252_MAP = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152,
  0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A,
  0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178,
};

function decodeWindows1252(buf) {
  let str = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    str += WIN1252_MAP[b] ? String.fromCharCode(WIN1252_MAP[b]) : String.fromCharCode(b);
  }
  return str;
}

/**
 * Read the file as text.
 *
 * Excel exports this sheet as Windows-1252, not UTF-8. Decoding it as UTF-8 turns curly
 * apostrophes and accents into U+FFFD — "Nature's Nook" becomes "Nature<?>s Nook" — and those
 * names are what get fed to Booking.com search and to geocoding. Try strict UTF-8 first so a
 * genuinely-UTF-8 file is read correctly, and fall back rather than corrupting the text.
 */
function readCSVText(file) {
  const buf = fs.readFileSync(file);
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }; }
  catch (_) { return { text: decodeWindows1252(buf), encoding: 'windows-1252' }; }
}

/** Property IDs are used as object keys and in filesystem-adjacent contexts. */
function normaliseId(raw) { return String(raw).replace(/[^a-zA-Z0-9_-]/g, '_'); }

/** The Booking.com slug — the only reliable identity for a listing, since IDs get reused. */
function slugFromUrl(url) {
  return (String(url || '').match(/booking\.com\/hotel\/[a-z]{2}\/([^.?/#]+)/i) || [])[1] || null;
}

/**
 * Parse properties.csv.
 *
 * @param {string} file path to properties.csv
 * @returns {{
 *   encoding: string,
 *   headers: string[],
 *   lines: string[],                      raw lines, so callers can rewrite the file in place
 *   index: {id:number,name:number,url:number,location:number,compUrl:number},
 *   properties: Array<{id,name,url,slug,location,line}>,   own properties, in sheet order
 *   competitors: Array<{ownId,name,url,slug,line}>,        manual competitor rows
 *   duplicateIdRows: Array<{id,line}>,    extra rows for an ID already seen (collapsed units)
 *   orphanCompetitors: Array<{name,line}> competitor rows with no own property above them
 * }}
 */
function readProperties(file) {
  const { text, encoding } = readCSVText(file);
  const lines = text.replace(/\r/g, '').split('\n');
  const headers = parseCSVLine(lines[0] || '').map(s => s.trim());

  const pick = names => { for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; } return -1; };
  const index = {
    id: pick(H.id), name: pick(H.name), url: pick(H.url),
    location: pick(H.location), compUrl: pick(H.compUrl),
  };
  const at = (vals, i) => (i >= 0 ? (vals[i] || '').trim() : '');

  const properties = [], competitors = [], duplicateIdRows = [], orphanCompetitors = [];
  const seen = new Set();
  let currentOwnId = null;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCSVLine(lines[i]);
    const rawId = at(vals, index.id);

    if (rawId) {
      const id = normaliseId(rawId);
      currentOwnId = id;
      if (seen.has(id)) { duplicateIdRows.push({ id, line: i, name: at(vals, index.name) }); continue; }
      seen.add(id);
      const url = at(vals, index.url);
      properties.push({
        id,
        name: at(vals, index.name),
        url,
        slug: slugFromUrl(url),
        location: at(vals, index.location),
        line: i,
      });
      continue;
    }

    // No Property ID: a manual competitor row, where Location holds the NAME
    const compName = at(vals, index.location);
    const compUrl  = at(vals, index.compUrl);
    if (!compName || !compUrl) continue;
    if (!currentOwnId) { orphanCompetitors.push({ name: compName, line: i }); continue; }
    competitors.push({
      ownId: currentOwnId,
      name: compName,
      url: compUrl,
      slug: slugFromUrl(compUrl),
      line: i,
    });
  }

  return { encoding, headers, lines, index, properties, competitors, duplicateIdRows, orphanCompetitors };
}

/** Re-encode one row after mutating its fields, quoting only where required. */
function formatCSVLine(vals) {
  return vals.map(f => {
    const s = String(f == null ? '' : f);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }).join(',');
}

module.exports = {
  readProperties, readCSVText, parseCSVLine, formatCSVLine, normaliseId, slugFromUrl, HEADER_ALIASES: H,
};
