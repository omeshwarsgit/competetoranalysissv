---
name: config-writes-race-no-locking
description: Five separate things read-modify-write config/properties.json with no locking, so a concurrent write silently loses the other's changes
metadata:
  type: project
---

`config/properties.json` is read-modify-written by **five** independent things, none of which take
a lock or check whether the file changed underneath them:

| writer | what it changes |
|---|---|
| `import-properties.js` | rebuilds the whole file from the CSV |
| `discover.js` | writes back the own property's resolved lat/lng |
| `resolve-property-coords.js` | slug, sourceUrl, display, coordinates, city |
| `sync-inventory.js` | `competitors[]`, plus new competitor entries |
| `serve.js` | `/api/discover/commit`, `/api/reset-competitors`, `/api/add-competitor` |

Each does `JSON.parse(readFileSync(...))` → mutate → write. Two overlapping runs therefore produce
a **lost update**: whichever writes second silently discards everything the first one did. A
long-running `discover.js` is the easy way to hit this, because it reads config near the start and
writes minutes later.

This is not hypothetical. During the 2026-08-11 session property 1's `competitors[]` went from 12
entries to exactly the 2 ids sitting in `discovery-cache.json`'s `selected` list for that property —
the signature of `/api/reset-competitors` followed by `/api/discover/commit` — while background
scans and browser-driven dashboard verification were running against a live server. The 12 were
restored from a pre-session copy (union with the 2, giving 14). The exact trigger was never pinned
down, which is itself the lesson: with no locking and no audit trail, config damage is not
attributable after the fact.

**How to apply:**
- Do **not** run `discover.js` / `discover-all.js` / `import-properties.js` / `sync-inventory.js`
  while `serve.js` is up and someone is using the Discover tab. The scheduled tasks run at 02:00
  and 06:00 partly for this reason.
- Before any operation that writes config, take a copy. `import-properties.js` and
  `sync-inventory.js` both back up automatically (newest 5 kept); the others do not.
- After anything that might have raced, check `competitors[]` counts per own property — a silent
  drop is the symptom. `node import-properties.js --check` catches dangling references but **not**
  a shrunken competitor list.
- The real fix, if this bites again: a lock file, or write-if-unchanged using the mtime read at
  load. Not done yet.

Related: [[csv-single-source-of-truth]], [[one-csv-parser-with-tests]].
