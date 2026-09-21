# Tasks

> Live task board. Move items between sections as status changes. IDs never change or repeat.

## 🔵 In progress

_(nothing in flight)_

## 🟡 To do

All remaining items need the user's judgement, not a fix.

- **T-023** — Find out what is calling `POST /api/reset-competitors`. It has emptied a property's
  `competitors[]` twice on 2026-08-11 (property 1: 12 → 2; properties 2 and 4: 10 → 0 and 15 → 0,
  taking 25 competitor records and their scraped rates with them). The user confirmed neither was
  them. Both restored. `data/config-audit.json` now records caller, user-agent, referer and
  before/after counts for that endpoint, so the next occurrence is attributable — check it after any
  recurrence. **No recurrence as of 2026-08-12**, and one plausible contributor is now gone: the
  Discover tab used to fire background forced scans on its own (BUG-010), which mutated the same
  file from a code path nobody was watching · priority: **high**
- **T-015** — Decide how many competitors to track per property, then re-link. The 2026-08-11
  scan took property 2's candidate pool from 22 to **95** (the intermittent text search fired —
  see `memory/booking-text-search-is-flaky.md`), but `config.competitors[]` still carries the
  curated 10–15 per property, so the extra 80 are discovered and mapped but not priced. Curation
  is deliberate and `refresh.js` only scrapes what is linked. `node import-properties.js --offline
  --max-competitors=<n>` re-picks from the cached scan · priority: medium
- **T-016** — Decide the fate of the retired 737-property portfolio.
  `_backup-2026-08-10-15-39-41/` (249 MB) is the **only** copy of its data and of the 244 MB
  pre-prune discovery cache. Nothing records whether the Goa set is a permanent re-point or a
  scoped test, so it has deliberately not been deleted. If the retirement is permanent, this can
  go; if the Goa set is a test, it is the restore path · priority: medium

## ✅ Done

- **T-025** — Light theme finished and verified. Picked up an unrecorded session (2026-08-12 23:35 →
  2026-08-13 00:04) that had added the theme but stopped mid-audit. Fixed the three defects it left
  (BUG-015 map popups + confirm modal invisible at 1.03:1 contrast, BUG-016 sidebar stuck on
  "Loading…", BUG-017 a CSS `var()` handed to a canvas), replaced four hardcoded surfaces with
  per-theme tokens, and extended `verify-dashboard.js` to run **both themes** plus a token-level
  contrast assertion — proved non-vacuous by reintroducing the bug and watching it fail. Also
  closed the question that session was chasing: the missing `discFullMktBtn` / `discRunBtn` ids
  were a deliberate retirement, not a regression · done 2026-08-13 · refs BUG-015…BUG-017

- **T-024** — Production-hardening pass across the whole codebase: 21 bugs fixed (BUG-009…BUG-014
  plus 15 smaller ones), 356 KB of stale baked-in portfolio data and ~500 lines of unreachable code
  removed (`dashboard/index.html` 667 KB → 295 KB), every JSON/CSV write made atomic and
  single-implementation, two server crash paths closed, and the Discover availability filter
  finished. Verified with `npm test` (73/73), `verify-dashboard.js` (0 errors, 0 forced scans), a
  live `refresh.js --property=3`, a clean report build and three dry-runs
  · done 2026-08-12 · refs BUG-009…BUG-014
- **T-022** — Closed as already resolved: `data/latest.dashboard.json` has **0** orphan competitor
  records and 0 dangling references as of 2026-08-12 (checked directly). The 12 records were cleared
  by an earlier prune · done 2026-08-12
- **T-018** — Config write race closed: `lib/json-store.js` optimistic concurrency on the three
  long-window writers (`sync-inventory.js`, `resolve-property-coords.js`, `discover.js`), which now
  **abort** rather than clobber a concurrent edit, plus an audit trail on the mutating `serve.js`
  endpoints · done 2026-08-11 · 11 tests
- **T-019** — Trendline and analysis correctness: R²-gated, ADR-relative trend (the old test was a
  flat ±₹30/day across a 6x ADR spread); unknowns render as "—" with a reason instead of a confident
  0; market position anchors on the first bookable night rather than blanking for 4 of 6 properties;
  weekend premium windowed to the forward 30 and correctly signed; unpriced competitors moved out of
  'Mid-Market' into their own "No rate" bucket · done 2026-08-11
- **T-020** — Competitor occupancy for the next 30 nights, measured from observed sold-out days
  (`nodata` nights excluded from both sides, with a coverage column), plus per-competitor comparison
  and own-vs-market demand rank · done 2026-08-11
- **T-021** — One shared discovered inventory per location — 1,011 unique listings across North Goa,
  unioned **on read** in `serve.js` with per-property distance ranking. Storing per-property copies
  would take the cache 2.3 MB → 10 MB · done 2026-08-11 · refs D-010
- **T-017** — Continuous inventory per location: newly listed properties are auto-linked (up to a
  target), and properties absent from 3 consecutive scans are confirmed against their own
  Booking.com page and deactivated only on a 404/410. `lib/inventory.js` + `sync-inventory.js` +
  38 tests, run automatically by `scheduled-scan.js` and exposed at `GET /api/inventory`.
  Deactivation preserves price history; `--purge` is opt-in · done 2026-08-11 · refs D-008, D-009
- **T-001** — Property dropdown shows only `properties.csv` rows, labelled from Column B, in sheet
  order, auto-updating; data purged for absent properties · done 2026-08-10 · refs D-001–D-004, BUG-000
- **T-002** — Canonical Booking.com URLs + slugs recovered for all 6 via share-link redirect
  resolution; sheet rewritten · done 2026-08-10 · refs D-005, BUG-001
- **T-003** — Config populated with slug / coordinates / city for all 6, competitor discovery run
  · done 2026-08-10
- **T-004** — Prices scraped and confirmed on the dashboard for all 6 · done 2026-08-11 ·
  102 own priced nights + 2,463 competitor priced nights
- **T-005** — Share-link resolution folded into `import-properties.js`. Added `--links-only` to
  `resolve-property-coords.js` (redirect follow only, no browser); the import detects slug-less
  rows and delegates before parsing, while `--check` stays read-only and prints the command
  · done 2026-08-11
- **T-006** — Stale `meta.today` on the `--property=` merge path fixed; the merge now takes the
  fresh run's meta wholesale · done 2026-08-11 · refs BUG-002
- **T-007** — `discovery-cache.json` growth: dropped the `allDiscovered` duplicate of
  `fullMarket` (21% of the file, byte-identical); a scan strips it from every entry.
  377 KB → 266 KB · done 2026-08-11 · refs BUG-003
- **T-008** — `config/sheets.json` no longer pins `"properties": ["1"]`; with no filter the sync
  follows the CSV automatically · done 2026-08-11
- **T-009** — Price scraping has its own scheduled task: `scheduled-refresh.js` +
  `setup-daily-refresh.bat` (06:00, after the 02:00 discovery scan), with a run log and non-zero
  exit on failure. Also fixed the pre-existing scan task, whose `>> log 2>&1` inside
  `schtasks /TR` was being passed to node as argv rather than redirecting · done 2026-08-11
- **T-010** — CSV parser consolidated: all four scripts read the sheet through
  `lib/csv-properties.js`, and `test/csv-properties.test.js` (24 tests) pins the contract
  · done 2026-08-11 · refs D-006
- **T-012** — Discover map crash on properties without coordinates · done 2026-08-10 · refs BUG-004
- **T-013** — Discovered competitors linked into `config.competitors[]` (10–15 per property), so
  Overview / Analysis / Suggestions / Map populate · done 2026-08-11
- **T-014** — `discover.js` region-destination handling. Closed as **not a defect**: the `ss=`
  text search is intermittent rather than broken, and the existing design (one cheap probe →
  coordinate-search fallback → honest reporting) is the right response · done 2026-08-11 · refs BUG-005

## 🧊 Backlog / someday

- Resolve competitor `beds` properly — `discover.js` hardcodes `beds: null`, so the capacity factor
  (15% of the relevance score) contributes a flat 0.5 for every candidate
- Deduplicate co-located listings: properties 3–6 sit in shared apartment complexes, so many
  candidates share a building's exact coordinates and stack on the map
- Track more than 30 nights forward
- Second OTA source for cross-checking rates
- Alerting when a competitor makes a large rate move
- Investigate the ~100 competitor `noDataDates` per full refresh — nights that came back neither
  priced nor sold out, most likely 429 throttling. Not blocking, but it thins some peer curves.

---
_Guidance: keep "In progress" to what's genuinely in flight (ideally one thing). When a task
completes, move it to Done and add a `CHANGELOG.md` entry._
