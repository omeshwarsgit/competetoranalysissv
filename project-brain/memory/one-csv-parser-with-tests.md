---
name: one-csv-parser-with-tests
description: All CSV reading goes through lib/csv-properties.js, and test/csv-properties.test.js locks the contract — never re-implement the parser
metadata:
  type: feedback
---

`properties.csv` is read by `serve.js`, `import-properties.js`, `prune-to-csv.js` and
`resolve-property-coords.js`. Each had grown **its own copy** of the parser, and the copies had
already begun to disagree:

- `import-properties.js`'s slug regex was `[^.?/]+` while everyone else used `[^.?/#]+`, so a URL
  with a `#fragment` produced a slug that no stored record could ever match again.
- `import-properties.js` preferred the legacy `Stayvista Property` column for a display name
  while the dashboard dropdown preferred `Property` — on a sheet carrying both, the importer and
  the UI would label the same row differently.

All four now call `lib/csv-properties.js`, which is the only place that knows the contract.
`import-properties.js` keeps its own row-object layer and multi-unit grouping on purpose:
`readProperties()` collapses repeated Property IDs to one row, but the import needs to *see*
every unit row to derive a shared base name via `pickBaseName()`.

`test/csv-properties.test.js` (24 tests, `npm test`) locks the quirks: the `Location` column's
dual meaning, competitor-row ownership by position, repeated-ID collapse, Windows-1252 fallback,
share links yielding no slug, CRLF, legacy headers, and the read-modify-write round-trip that
`resolve-property-coords.js --write-csv` depends on.

**Why:** BUG-000 (307 phantom properties) and BUG-001 (share links) both came out of this area,
and a dropdown that disagrees with an importer about which properties exist is the exact class of
bug that keeps recurring here.

**How to apply:** never add a `parseCSVLine` / header-alias list / slug regex to a new script —
import from the lib. If the contract genuinely needs to change, change it in the lib and add a
test that pins the new behaviour. Writing the tests immediately found a real bug: `parseCSVLine`
could not read the escaped-quote form (`""`) that `formatCSVLine` writes, so any name containing
a double quote lost its quotes on every `--write-csv` round-trip.

Related: [[csv-single-source-of-truth]], [[csv-column-contract]], [[booking-slug-is-identity]],
[[share-links-break-pipeline]].
