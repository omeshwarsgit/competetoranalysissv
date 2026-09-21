/**
 * test/csv-properties.test.js
 *
 * Locks the properties.csv contract — the single most bug-prone surface in this project.
 * Four scripts once carried four copies of this parser; BUG-000 (307 phantom properties) and
 * BUG-001 (share links) both came out of that area. These tests exist so the next edit to
 * lib/csv-properties.js cannot quietly change what a sheet means.
 *
 * Run: node --test test/
 */
'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
  readProperties, readCSVText, parseCSVLine, formatCSVLine, normaliseId, slugFromUrl,
  HEADER_ALIASES,
} = require('../lib/csv-properties');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'csvprops-'));
let n = 0;
/** Write a sheet to a temp file. `buf` lets a test control the byte encoding. */
function sheet(content) {
  const f = path.join(TMP, `s${++n}.csv`);
  fs.writeFileSync(f, content);
  return f;
}

const HDR = 'Property ID, Property,Booking.com Link,Location,Competitor Link';
const HOTEL = s => `https://www.booking.com/hotel/in/${s}.en-gb.html`;

// ── parseCSVLine ──────────────────────────────────────────────────────────────
test('parseCSVLine splits on commas and trims', () => {
  assert.deepStrictEqual(parseCSVLine('a, b ,c'), ['a', 'b', 'c']);
});

test('parseCSVLine honours double-quoted commas', () => {
  assert.deepStrictEqual(parseCSVLine('1,"Villa, The",url'), ['1', 'Villa, The', 'url']);
});

test('parseCSVLine keeps empty trailing fields', () => {
  assert.deepStrictEqual(parseCSVLine('1,name,url,,'), ['1', 'name', 'url', '', '']);
});

// ── formatCSVLine round-trip ──────────────────────────────────────────────────
test('formatCSVLine quotes only fields that need it, and round-trips', () => {
  assert.strictEqual(formatCSVLine(['1', 'plain', 'u']), '1,plain,u');
  assert.strictEqual(formatCSVLine(['1', 'Villa, The', 'u']), '1,"Villa, The",u');
  assert.strictEqual(formatCSVLine(['1', 'He said "hi"']), '1,"He said ""hi"""');
  const vals = ['1', 'Villa, The', 'He said "hi"', ''];
  assert.deepStrictEqual(parseCSVLine(formatCSVLine(vals)), vals);
});

// ── slugFromUrl ───────────────────────────────────────────────────────────────
test('slugFromUrl reads the slug from a canonical hotel URL', () => {
  assert.strictEqual(slugFromUrl(HOTEL('casa-2565-anjuna-north-goa')), 'casa-2565-anjuna-north-goa');
});

test('slugFromUrl stops at ? and #', () => {
  assert.strictEqual(slugFromUrl('https://www.booking.com/hotel/in/koral-1-bhk?checkin=2026-08-11'), 'koral-1-bhk');
  // The old copy in import-properties.js did NOT stop at '#', so a fragment leaked into the
  // slug and no stored record would ever match it again. That is BUG-001's failure mode.
  assert.strictEqual(slugFromUrl('https://www.booking.com/hotel/in/koral-1-bhk#map'), 'koral-1-bhk');
});

test('slugFromUrl returns null for a share link — it carries no slug (BUG-001)', () => {
  assert.strictEqual(slugFromUrl('https://www.booking.com/Share-aBcDeF'), null);
  assert.strictEqual(slugFromUrl(''), null);
  assert.strictEqual(slugFromUrl(null), null);
});

// ── normaliseId ───────────────────────────────────────────────────────────────
test('normaliseId keeps safe characters and replaces the rest', () => {
  assert.strictEqual(normaliseId('1'), '1');
  assert.strictEqual(normaliseId('SV-12_a'), 'SV-12_a');
  assert.strictEqual(normaliseId('12/34 56'), '12_34_56');
});

// ── Encoding ──────────────────────────────────────────────────────────────────
test('readCSVText decodes valid UTF-8 as UTF-8', () => {
  const f = sheet(Buffer.from(`${HDR}\n1,Nature’s Nook,${HOTEL('x')},,\n`, 'utf8'));
  const { text, encoding } = readCSVText(f);
  assert.strictEqual(encoding, 'utf-8');
  assert.ok(text.includes('Nature’s Nook'));
});

test('readCSVText falls back to Windows-1252 rather than corrupting names', () => {
  // 0x92 is a curly apostrophe in Windows-1252 and invalid as standalone UTF-8.
  const buf = Buffer.concat([
    Buffer.from(`${HDR}\n1,Nature`, 'utf8'), Buffer.from([0x92]),
    Buffer.from(`s Nook,${HOTEL('x')},,\n`, 'utf8'),
  ]);
  const f = sheet(buf);
  const { text, encoding } = readCSVText(f);
  assert.strictEqual(encoding, 'windows-1252');
  assert.ok(text.includes('Nature’s Nook'), 'expected a curly apostrophe, got: ' + text);
  assert.ok(!text.includes('�'), 'name must not contain U+FFFD');
});

// ── readProperties: the row model ─────────────────────────────────────────────
test('readProperties returns own rows in sheet order with slugs', () => {
  const f = sheet(`${HDR}\n`
    + `1,Lirio,${HOTEL('lirio-villa')},,\n`
    + `2,Casa 2565,${HOTEL('casa-2565')},,\n`);
  const { properties, competitors } = readProperties(f);
  assert.deepStrictEqual(properties.map(p => p.id), ['1', '2']);
  assert.deepStrictEqual(properties.map(p => p.name), ['Lirio', 'Casa 2565']);
  assert.deepStrictEqual(properties.map(p => p.slug), ['lirio-villa', 'casa-2565']);
  assert.strictEqual(competitors.length, 0);
});

test('a row with no Property ID is a competitor, and Location holds its NAME', () => {
  // The Location column means two different things depending on the row. This is the quirk
  // most likely to be "simplified" away by a future edit.
  const f = sheet(`${HDR}\n`
    + `1,Lirio,${HOTEL('lirio-villa')},Candolim,\n`
    + `,,,Hilton Goa Resort,${HOTEL('hilton-goa-resort')}\n`);
  const { properties, competitors } = readProperties(f);
  assert.strictEqual(properties.length, 1);
  assert.strictEqual(properties[0].location, 'Candolim', 'own row: Location is the area');
  assert.strictEqual(competitors.length, 1);
  assert.strictEqual(competitors[0].name, 'Hilton Goa Resort', 'competitor row: Location is the name');
  assert.strictEqual(competitors[0].slug, 'hilton-goa-resort');
});

test('a competitor belongs to the own property above it, so row order matters', () => {
  const f = sheet(`${HDR}\n`
    + `1,Lirio,${HOTEL('lirio-villa')},,\n`
    + `,,,Comp A,${HOTEL('comp-a')}\n`
    + `2,Casa,${HOTEL('casa-2565')},,\n`
    + `,,,Comp B,${HOTEL('comp-b')}\n`);
  const { competitors } = readProperties(f);
  assert.deepStrictEqual(competitors.map(c => [c.ownId, c.name]), [['1', 'Comp A'], ['2', 'Comp B']]);
});

test('a competitor row before any own property is an orphan, not a silent drop', () => {
  const f = sheet(`${HDR}\n`
    + `,,,Stray Comp,${HOTEL('stray')}\n`
    + `1,Lirio,${HOTEL('lirio-villa')},,\n`);
  const { properties, competitors, orphanCompetitors } = readProperties(f);
  assert.strictEqual(properties.length, 1);
  assert.strictEqual(competitors.length, 0);
  assert.deepStrictEqual(orphanCompetitors.map(o => o.name), ['Stray Comp']);
});

test('repeated Property IDs collapse to one entry, first row winning', () => {
  const f = sheet(`${HDR}\n`
    + `7,Amber @ Golden Triangle,${HOTEL('golden-triangle-amber')},,\n`
    + `7,Jade @ Golden Triangle,${HOTEL('golden-triangle-jade')},,\n`);
  const { properties, duplicateIdRows } = readProperties(f);
  assert.strictEqual(properties.length, 1, 'one entry per Property ID');
  assert.strictEqual(properties[0].slug, 'golden-triangle-amber', 'first row wins');
  assert.deepStrictEqual(duplicateIdRows.map(d => d.id), ['7'], 'the extra unit row is reported');
});

test('a share-link row parses but yields no slug, so identity is unverifiable', () => {
  const f = sheet(`${HDR}\n1,Lirio,https://www.booking.com/Share-aBcDeF,,\n`);
  const { properties } = readProperties(f);
  assert.strictEqual(properties.length, 1);
  assert.strictEqual(properties[0].slug, null);
});

test('blank lines and a trailing newline do not create phantom rows (BUG-000)', () => {
  const f = sheet(`${HDR}\n1,Lirio,${HOTEL('lirio-villa')},,\n\n\n`);
  assert.strictEqual(readProperties(f).properties.length, 1);
});

test('a header-only sheet yields zero properties, not an error', () => {
  assert.strictEqual(readProperties(sheet(`${HDR}\n`)).properties.length, 0);
});

test('CRLF line endings parse the same as LF', () => {
  const f = sheet(`${HDR}\r\n1,Lirio,${HOTEL('lirio-villa')},,\r\n`);
  const { properties } = readProperties(f);
  assert.strictEqual(properties.length, 1);
  assert.strictEqual(properties[0].slug, 'lirio-villa');
});

test('quoted names containing commas survive into the parsed row', () => {
  const f = sheet(`${HDR}\n1,"Lirio, 2 BHK",${HOTEL('lirio-villa')},,\n`);
  assert.strictEqual(readProperties(f).properties[0].name, 'Lirio, 2 BHK');
});

// ── Legacy headers ────────────────────────────────────────────────────────────
test('legacy header names still resolve', () => {
  const f = sheet('Property ID (according to our System),Stayvista Property,Own Link,City,Deal % (own)\n'
    + `1,Lirio,${HOTEL('lirio-villa')},Candolim,\n`);
  const { properties } = readProperties(f);
  assert.strictEqual(properties.length, 1);
  assert.strictEqual(properties[0].name, 'Lirio');
  assert.strictEqual(properties[0].slug, 'lirio-villa');
  assert.strictEqual(properties[0].location, 'Candolim');
});

test('when both current and legacy name columns exist, the current one wins', () => {
  // import-properties.js used to prefer "Stayvista Property" here while the dashboard
  // dropdown preferred "Property" — the importer and the UI would label a row differently.
  assert.strictEqual(HEADER_ALIASES.name[0], 'Property');
  const f = sheet('Property ID,Property,Stayvista Property,Booking.com Link,Location,Competitor Link\n'
    + `1,New Name,Old Name,${HOTEL('lirio-villa')},,\n`);
  assert.strictEqual(readProperties(f).properties[0].name, 'New Name');
});

test('missing optional columns degrade to empty strings, not crashes', () => {
  const f = sheet(`Property ID,Property,Booking.com Link\n1,Lirio,${HOTEL('lirio-villa')}\n`);
  const { properties, index } = readProperties(f);
  assert.strictEqual(index.compUrl, -1);
  assert.strictEqual(properties[0].location, '');
});

// ── lines/index are usable for in-place rewrites (resolve-property-coords --write-csv) ──
test('lines and index let a caller rewrite one field in place', () => {
  const f = sheet(`${HDR}\n1,Lirio,https://www.booking.com/Share-aBcDeF,,\n`);
  const { lines, index, properties } = readProperties(f);
  const row = properties[0];
  const vals = parseCSVLine(lines[row.line]);
  vals[index.url] = HOTEL('lirio-villa');
  lines[row.line] = formatCSVLine(vals);

  const f2 = sheet(lines.join('\n'));
  const after = readProperties(f2).properties[0];
  assert.strictEqual(after.slug, 'lirio-villa');
  assert.strictEqual(after.name, 'Lirio', 'the rest of the row is untouched');
  assert.strictEqual(after.id, '1');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
