---
name: csv-single-source-of-truth
description: properties.csv is authoritative; config/properties.json is a derived cache that only ever accumulates
metadata:
  type: project
---

`properties.csv` is the only authoritative list of which properties exist. `config/properties.json`
is a **derived cache that accumulates and never shrinks on its own**: `import-properties.js
--property=<id>` deliberately preserves every *other* entry (its `untouched` array), so any Property
ID removed from the CSV survives in config — and in `data/latest.dashboard.json`,
`discovery-cache.json`, `property-meta.json` and `geo-cache.json` — indefinitely.

This is how 307 phantom properties ended up in the dashboard dropdown, and later how 1,038 stale own
entries plus 5,423 competitors were still live after the sheet shrank to 6 rows.

**Why:** only a *full* `import-properties.js` run prunes config, and even that touches none of the
other caches.

**How to apply:** never treat config as the property list. Reconcile against the CSV —
`GET /api/csv-properties` serves a live parse of it, and `prune-to-csv.js` purges every data file
down to the sheet. Check [[booking-slug-is-identity]] before carrying any data across a sheet change.
