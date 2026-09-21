# Current State

> Living snapshot of *now*. Overwrite freely — this is not a history (that's `CHANGELOG.md`).

**Last updated:** 2026-09-21

## Focus

Analyzed codebase architecture and execution pipeline. Fixed cross-platform Windows-1252 decoding fallback in `lib/csv-properties.js` (BUG-018) when running on Node.js without CP1252 single-byte mappings. Verified test suite, CSV validation, inventory sync dry-run, Sheets sync dry-run, HTML rate report generation, and server execution.

## Progress

- **Phase:** stable / hardened / verified
- **% complete (rough):** 99%

## What works end-to-end ✅

- **CSV → config import** — 3-pass parse, multi-unit collapse, manual competitors, auto-backup
  (rotating, newest 5), write-then-rename, dangling-reference check. A slug-less share link is
  detected and resolved automatically before parsing.
- **One CSV parser _and one CSV writer_** — `lib/csv-properties.js` reads; `csvCell` /
  `csvCompetitorRow` / `readCsvLines` / `writeCsvLines` in `serve.js` write. The three endpoints
  that append competitor rows all go through the writer (they used to have three divergent copies —
  BUG-014).
- **Market discovery** — text + coordinate Booking.com search, API interception for exact coords,
  8-factor relevance scoring, cumulative cache. **Never triggered by rendering a panel** (BUG-010).
- **Price scraping** — 30 nights × property × room, ~80-way concurrency, adaptive 429 throttling,
  dated history snapshots with 90-day retention.
- **Dashboard** — 7 panels, SSE live refresh progress, Leaflet competitor map, Excel export that
  now agrees with the on-screen calendar about sold-out nights, and **dark + light themes** (sidebar
  "Toggle Theme", remembered in `localStorage` under `sv-theme`; toggling re-renders the active
  panel rather than reloading, because Chart.js bakes its colours in at construction time).
- **Google Sheets sync** — Apps Script transport, idempotent keyed upsert, SHA-256 change
  detection, `--watch`; follows the CSV automatically.
- **Reports** — HTML + PDF rate analysis, fully data-driven.
- **Scheduling** — discovery at 02:00 and price scraping at 06:00, via wrapper `.cmd` files that
  actually capture their logs.
- **Verification** — `npm test` (73 tests) and `npm run verify:dashboard`, which drives **both
  themes** and fails on markdown artifacts, negative position scores, statistics over empty samples,
  any forced scan triggered merely by browsing, a sidebar still reading "Loading…", and any theme
  surface that does not contrast with that theme's text.

## Verified on 2026-09-21

| check | result |
|---|---|
| `npm test` | 73/73 pass (100%) |
| `npm run validate` | 6 own properties, 4 manual competitors validated cleanly |
| `sync-inventory.js --dry-run` | pools read, 6 properties, +0 linked · −0 delisted, no unintended churn |
| `sync-sheets.js --dry-run` | 64 rows × 54 cols, 50 properties, daily-grid mode |
| `serve.js` | launches HTTP dashboard server on :3000 / :3001 |
| `node build-price-report.js --property=3` | HTML report generated cleanly (`reports/rate-analysis-3-2026-09-21.html`) |
| `import-properties.js --check` | 6 own properties, 1 manual competitor |
| `dashboard/index.html` | 667 KB → 295 KB (hardening, 08-12) → 307 KB (light theme, 08-12 late) → **310 KB** (theme fixes, 08-13) |

## Verified on 2026-08-12 (still current — not re-run today, nothing since touches these paths)

| check | result |
|---|---|
| `node refresh.js --property=3` (live) | 390 fetches, 81.6 s, 10 room types across 13 properties, **0 no-data** |
| Own price coverage (property 3, fresh) | 14 priced · 16 sold out · 0 no-data over 2026-08-12 → 09-10 |
| Data integrity | 51 competitors · **0** orphan records · **0** dangling references |
| Long Weekends honesty | in-window weekend shows real rates + Sold Out; the 7 beyond the window show "Not scraped yet" |

## What's broken or incomplete ⚠️

- ℹ️ **Competitor curation has not caught up with the last scan.** Pools are now 57–849 per property
  (the intermittent text search fired on 2026-08-12), but `config.competitors[]` still carries the
  curated 1–15 per property. Deliberate — `refresh.js` scrapes what is linked — but the number to
  track is a decision for the user (T-015).
- ℹ️ **19 of 51 competitors are sold out for all 30 nights.** Recorded correctly as sold-out, so
  they legitimately carry no rate.
- ℹ️ **The Sheets sync has not been pushed since these changes** — validated by `--dry-run` only,
  because a real run writes to the live sheet. Run `npm run sync` when ready.
- ℹ️ **The dashboard needs a network for its CDN libraries** (Chart.js, Leaflet, markercluster,
  xlsx). Offline, charts/map/export degrade — the panels still render. Only Chart.js is pinned with
  an SRI hash.

## Blocked on 🚧

- Nothing.

## Environment / how to run

```bash
npm test                                    # 73 unit tests (CSV contract, inventory, json-store)
npm run verify                              # unit tests + full browser verification
npm run validate                            # validate the CSV, write nothing

# after any sheet change
npm run prune:dry                           # preview what leaves the system
npm run prune                               # scope all data to the sheet (backs up first)
npm run coords                              # share links -> slugs + accurate coordinates
npm run discover                            # find competitors for each property
npm run import                              # full import (rebuilds config, runs discovery)
npm run import:offline                      # re-link competitors from the cached scan

npm run scrape                              # all properties, 30 nights
node refresh.js --property=3                # one property + its competitors
npm run scrape:scheduled                    # scrape (+ sync), logged to data/refresh-log.json

npm run serve                               # http://localhost:3000
node serve.js --no-open --port=3111         # ...without a browser, on another port
npm run verify:dashboard -- --port=3111     # every panel in a real browser, BOTH themes
node verify-dashboard.js --theme=light      # one theme only (default: both)
node verify-dashboard.js --screenshots=./shots   # <panel>-<theme>.png, 4 panels per theme

npm run inventory:dry                       # preview inventory churn
npm run sync:dry                            # preview the Sheets payload
npm run report -- --property=3              # HTML + PDF rate report
```

Requires Node ≥18, Google Chrome, and a Booking.com login in the Chrome window `refresh.js` opens
(the CDP profile at `C:\temp\chrome-cdp` persists that session between runs). Not a git repository —
`_backup-pre-hardening-2026-08-12/` holds the pre-change copies of the three files most edited.

## Open questions

- How many competitors should each property track, now that a good scan surfaces 500+? (T-015)
- Is the 737-property portfolio retired for good, or is the Goa set a scoped test? Its only copy is
  `_backup-2026-08-10-15-39-41/` (249 MB), deliberately not deleted. (T-016)
- Should the CDN libraries be vendored locally so the dashboard works with no network at all?
