/**
 * test/json-store.test.js
 *
 * The optimistic-concurrency guard on config/properties.json. This exists because a real lost
 * update destroyed data once (property 1's competitors[] went 12 → 2 with no attribution), so the
 * behaviour that matters is: refuse to write, do not "win the race".
 *
 * Run: npm test
 */
'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { readTracked, writeIfUnchanged } = require('../lib/json-store');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstore-'));
let n = 0;
const tmpFile = (content) => {
  const f = path.join(TMP, `f${++n}.json`);
  if (content !== undefined) fs.writeFileSync(f, JSON.stringify(content, null, 2));
  return f;
};
/** mtime resolution can be coarse; force a distinct value so "changed" is unambiguous. */
const touchLater = (f, content) => {
  fs.writeFileSync(f, JSON.stringify(content, null, 2));
  const t = Date.now() / 1000 + 5;
  fs.utimesSync(f, t, t);
};

test('readTracked returns the parsed data and marks the file as existing', () => {
  const f = tmpFile({ a: 1 });
  const t = readTracked(f);
  assert.deepStrictEqual(t.data, { a: 1 });
  assert.strictEqual(t.existed, true);
  assert.ok(typeof t.mtimeMs === 'number');
});

test('readTracked on a missing file yields the fallback and existed=false', () => {
  const t = readTracked(path.join(TMP, 'nope.json'), { fallback: true });
  assert.deepStrictEqual(t.data, { fallback: true });
  assert.strictEqual(t.existed, false);
  assert.strictEqual(t.mtimeMs, null);
});

test('readTracked on malformed JSON yields the fallback rather than throwing', () => {
  const f = path.join(TMP, 'bad.json');
  fs.writeFileSync(f, '{not json');
  assert.deepStrictEqual(readTracked(f, null).data, null);
});

test('writeIfUnchanged writes when nothing else touched the file', () => {
  const f = tmpFile({ a: 1 });
  const t = readTracked(f);
  writeIfUnchanged(t, { a: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 2 });
});

test('writeIfUnchanged REFUSES when the file changed underneath, and leaves it alone', () => {
  // The scenario that lost data: read config, spend minutes probing, meanwhile the dashboard
  // rewrites it. Writing here would discard the dashboard's change.
  const f = tmpFile({ competitors: ['a', 'b'] });
  const t = readTracked(f);
  touchLater(f, { competitors: ['x'] });          // someone else writes

  assert.throws(() => writeIfUnchanged(t, { competitors: ['a', 'b', 'c'] }), e => e.code === 'ESTALE');
  // The other writer's content must survive untouched.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { competitors: ['x'] });
});

test('the refusal error explains that nothing was written', () => {
  const f = tmpFile({ a: 1 });
  const t = readTracked(f);
  touchLater(f, { a: 2 });
  try { writeIfUnchanged(t, { a: 3 }); assert.fail('should have thrown'); }
  catch (e) {
    assert.strictEqual(e.code, 'ESTALE');
    assert.match(e.message, /Nothing has been written/);
    assert.match(e.message, new RegExp(path.basename(f)));
  }
});

test('a file created by someone else after an absent read is also a conflict', () => {
  const f = path.join(TMP, 'race-create.json');
  const t = readTracked(f, { fresh: true });      // did not exist
  fs.writeFileSync(f, JSON.stringify({ theirs: true }));
  assert.throws(() => writeIfUnchanged(t, { mine: true }), e => e.code === 'ESTALE');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { theirs: true });
});

test('writing a file that legitimately did not exist works', () => {
  const f = path.join(TMP, 'brand-new.json');
  const t = readTracked(f, {});
  writeIfUnchanged(t, { created: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { created: true });
});

test('the returned tracker allows a second safe write in the same run', () => {
  const f = tmpFile({ step: 0 });
  let t = readTracked(f);
  t = writeIfUnchanged(t, { step: 1 });
  // Without re-tracking, this second write would look stale against our own first write.
  writeIfUnchanged(t, { step: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { step: 2 });
});

test('pretty:false writes compact JSON (used for the large dashboard payload)', () => {
  const f = tmpFile({ a: 1 });
  const t = readTracked(f);
  writeIfUnchanged(t, { a: 1, b: 2 }, { pretty: false });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1,"b":2}');
});

test('no .tmp file is left behind after a successful write', () => {
  const f = tmpFile({ a: 1 });
  writeIfUnchanged(readTracked(f), { a: 9 });
  assert.strictEqual(fs.existsSync(f + '.tmp'), false);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
