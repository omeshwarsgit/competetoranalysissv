# 🤝 HANDOFF — read this first

> **New AI: start here.** This file is your 2-minute catch-up. Read it, then `CONTEXT.json`,
> then only the detailed files relevant to the next step. Do not ask the user to re-explain
> anything below — it's already here. Maintain this brain per `../BRAIN_PROTOCOL.md`.

**Last updated:** 2026-08-13 01:30 · by Claude Opus 5 (1M context), Claude Code session

---

## In one paragraph

`competitor-pricing-monitor` is a **local Windows rate-shopping tool for StayVista**, an Indian
villa/homestay brand. For each StayVista property it finds nearby competitors on Booking.com,
scrapes 30 nights of forward rates for both, and shows where StayVista is over- or under-priced —
through a local dashboard on `:3000`, a live Google Sheet, and generated PDF reports. It is plain
Node ≥18 with a single dependency (Playwright); there is **no database** — JSON files on disk are
the store, and `properties.csv` is the human-maintained contract that drives everything. The whole
pipeline works and is verified: 6 North Goa properties, each with a canonical Booking.com slug,
exact coordinates, 22–95 discovered competitors, and 30 nights of scraped rates. The engineering
backlog is clear.

## Where we are right now

- **Phase:** stable / hardened / verified
- **% complete (rough):** 99%
- **Currently working on:** nothing in flight.
- **Works today:** everything in the pipeline — CSV import, discovery, 30-night scraping, the
  7-panel dashboard in **dark and light themes**, Sheets sync, PDF reports, plus daily scheduling
  for both discovery and scraping, and two verification suites (`npm test`,
  `npm run verify:dashboard`).
- **Broken / incomplete:** nothing blocking. The open items are **decisions for the user**, not
  code gaps — see below.
- **Last session (2026-08-13, T-025):** finished the **light theme**, which an unrecorded session
  had added late on 2026-08-12 and left mid-audit. Three defects fixed: map popups and the confirm
  modal were invisible in light theme at **1.03:1** contrast (BUG-015), the sidebar read "Loading…"
  forever (BUG-016), and a chart border was set to a CSS `var()` a canvas cannot resolve (BUG-017).
  `verify-dashboard.js` now drives **both themes** and asserts theme contrast at the token level.
- **Session before (2026-08-12, T-024):** a production-hardening pass over every file. 21 bugs fixed
  (BUG-009…BUG-014 are the notable ones), 356 KB of stale baked-in portfolio data and ~500 lines of
  unreachable code removed (`dashboard/index.html` 667 KB → 295 KB), all JSON/CSV writes made atomic
  and single-implementation, two server crash paths closed. Re-verified with a live scrape. Read the
  2026-08-12 and 2026-08-13 `CHANGELOG.md` entries before touching `serve.js` or
  `dashboard/index.html`.

## Do this next 👇

1. **T-015 — how many competitors per property?** Needs the user's judgement, so **ask**. Pools now
   swing hard (property 2: 22 → 95 → 613 across three scans), and `sync-inventory.js` deliberately
   holds each property's tracked count at whatever it already was, printing how many candidates it
   left out. `node sync-inventory.js --target=<n>` is the lever.
2. **T-016 — is the old portfolio retired for good?** Also the user's call.
   `_backup-2026-08-10-15-39-41/` (249 MB) is the **only** copy of the previous 737-property data.
3. **Register the two scheduled tasks** if that hasn't been done — run `setup-daily-scan.bat` and
   `setup-daily-refresh.bat` once each. Nothing runs automatically until then.
4. **Push the Sheets sync when the user wants it** — only `--dry-run` has been exercised, because a
   live run writes to their production sheet. `npm run sync`.
5. **T-023 — watch `data/config-audit.json`** if a property's `competitors[]` ever empties again.
   No recurrence since 2026-08-11, and one unattributed mutation path (the Discover tab's silent
   background scans) has since been removed — see BUG-010.

## Gotchas the next AI must know

- **The dashboard has two themes, so no colour may be hardcoded.** Every surface comes from a token
  defined in *both* `:root` and `[data-theme="light"]`. Four surfaces predated the light theme and
  kept literal dark values while their text read `var(--text)` — in light theme the map popups and
  the confirm modal became near-black on near-black, **1.03:1** (BUG-015). If you need a new opaque
  surface, add a token; don't write `#161924`.
- **A rendering sweep cannot see a contrast bug** — the DOM is perfect and only the pixels are
  wrong, and a Leaflet popup does not exist until a pin is clicked. That is why
  `verify-dashboard.js` asserts contrast on the *tokens* (every surface ≥ 4.5:1 vs `--text`, ≥ 3:1
  vs `--text-muted`, translucent films composited over `--bg` first). Keep that check honest: it
  was validated by reintroducing the bug and confirming it fails.
- **`var()` is resolved by the CSS engine, not by a canvas.** `borderColor: 'var(--gold)'` in a
  Chart.js dataset is silently ignored and the previous colour stands (BUG-017). Charts take
  literals from the JS-side `C` palette, which is rebuilt per theme at render time.
- **Toggling the theme re-renders the active panel; it must never reload.** The CSS switches on
  `[data-theme]` by itself, but Chart.js bakes its colours in at construction, so the charts need
  rebuilding. A reload would discard the loaded data, the selected property, the Discover map and
  every in-flight fetch to change two colours.
- **A placeholder in markup needs an owner on every path that can reach it.** `#lastUpdated`
  shipped as "Loading…" and was written only by the SSE refresh handler, so a fully-loaded
  dashboard claimed to be loading until someone hit Refresh — including on the error paths, where
  it was most misleading (BUG-016).
- **`discFullMktBtn` / `discRunBtn` / `themeBtn` are gone on purpose.** They were retired when
  Discover and Map merged and when the theme button moved to an inline `onclick`. If you find them
  in a grep, you are looking at `_backup-pre-hardening-2026-08-12/index.html`, not the live file —
  this already cost one session an inconclusive audit.
- **`inferPrice()` is not evidence a night exists.** For a date outside `room.observed` it returns
  the median of that night type — a plausible number for a night nobody fetched. The Long Weekends
  panel displayed those as quoted rates for Diwali and Christmas (BUG-009). Any panel that can show
  a date beyond `SCRAPE_NIGHTS` must gate on `availabilityOf()` first.
- **Rendering a panel must never start a scrape.** The Discover tab used to fire a forced
  Booking.com crawl per property whenever its cache was >24h old (BUG-010). `verify-dashboard.js`
  now fails if browsing triggers one — don't re-add it.
- **A zero from an empty input is not a measurement.** `calcStdDev([])` is 0, `Math.round(null*100)`
  is 0. Both have shipped as confident figures (BUG-012). Return null and render "—" with a reason.
- **There is one CSV writer now**, matching the one CSV parser: `csvCell` / `csvCompetitorRow` /
  `readCsvLines` / `writeCsvLines` in `serve.js`. Three hand-rolled copies had diverged and one
  corrupted the sheet on a quoted name (BUG-014). Don't add a fourth.
- **Never `fs.writeFileSync` a JSON file here** — use `writeJsonAtomic()`, and use
  `updateDiscoveryCache()` (which re-reads from disk) to modify `discovery-cache.json`. Reading it
  via `readJsonCached()` hands back the shared cached object; mutating that and writing it back
  clobbers concurrent `discover.js` runs.
- **`dashboard/index.html` ships with EMPTY `PORTFOLIO` / `COMPETITORS`.** They are filled at
  runtime from `/api/config` and `/api/latest`. The 356 KB snapshot that used to be baked in was
  dead in the normal case and rendered months-old Gurgaon rates as current when the server was
  unreachable. If the server is down the dashboard now shows a banner — that is intended.
- **`config/properties.json` is a cache, not a source of truth.** An `import-properties.js
  --property=<id>` run preserves every *other* entry, so IDs deleted from the CSV linger forever.
  That is why the dropdown once showed 307 phantom properties. Always reconcile against the CSV.
- **Property IDs are reused across CSV revisions.** The **Booking.com slug is the only reliable
  identity**. This has bitten twice: the phantom dropdown (BUG-000) and a rate report that named a
  former ID 1's competitors while analysing a villa (BUG-006).
- **Never re-implement the CSV parser.** `lib/csv-properties.js` is the one implementation and
  `test/csv-properties.test.js` pins it. Four copies had already silently diverged (D-006).
- **`build-price-report.js` must never contain a literal competitor name, rate or percentage**
  (D-007). It used to, and confidently reported them for unrelated properties.
- **Booking.com's `ss=` text search is intermittent, not broken.** 0 cards on 2026-08-10, 24 on
  2026-08-11 for the identical query, then 835 later the same day. Consequence: **candidate pool
  sizes are not comparable between scans.** Don't "fix" the probe, and don't delete it.
- **Absence from a scan is NOT evidence a listing is gone.** The scan probes one night and
  Booking.com hides properties with no availability for it, so a sold-out property vanishes exactly
  like a deleted one — 12 of property 1's 24 went missing in one scan and **all 12 were live**.
  Delisting requires a 404/410 from the property's own page (`sync-inventory.js`). Never add a code
  path that drops a property on absence alone.
- **`config/properties.json` has five uncoordinated writers and no locking.** Concurrent runs
  silently lose each other's changes. Don't scan/import while the dashboard is being used.
- **Excel locks `properties.csv` while it's open.** Writes from Node fail with `EBUSY`.
- **`properties.csv` is Windows-1252, not UTF-8** — the lib decodes strict UTF-8 first and falls
  back, or names come out as mojibake (`Nature<?>s Nook`).
- **`refresh.js` needs a *visible* Chrome window** the first time, so the user can log in to
  Booking.com. The CDP profile (`C:\temp\chrome-cdp`) persists that session, which is what makes
  the scheduled scrape work unattended; when it expires the task exits non-zero rather than
  recording a silent empty day.
- **`schtasks /TR` does not run through a shell**, so `>> log 2>&1` written there is passed to
  node as argv and redirects nothing. Both scheduled tasks now point at `run-scheduled-*.cmd`
  wrappers that own the redirection. Don't "simplify" that back.
- **Secrets are already handled correctly.** The real Apps Script shared secret lives only in
  `config/Code.deploy.gs` and `config/sheets.json`, both gitignored. `apps-script/Code.gs` holds
  the placeholder. Don't "fix" this.
- **Leaflet returns null from `L.latLng()`** for malformed coordinates instead of throwing. Always
  go through `validCoords()` / `readCoordCache()` / `coordsOf()` in `dashboard/index.html`.
- **A bare `fetch` cannot read a Booking.com property page** — it returns a ~4 KB HTTP 202
  bot-check stub. Page metadata needs the browser; prices are fine over `fetch` because
  `refresh.js` supplies logged-in cookies.
- This is **not a git repository**, so there is no undo. Check before overwriting.

## How to run it

```bash
npm test                                     # 24 CSV-contract tests
npm run validate                             # validate the CSV, write nothing
node prune-to-csv.js --dry-run               # preview scoping all data to the sheet
node prune-to-csv.js                         # apply it (backs up first)
node resolve-property-coords.js              # share links -> slugs + accurate coordinates
node resolve-property-coords.js --links-only --write-csv   # links only, no browser
node discover-all.js                         # find competitors for every property
node sync-inventory.js --dry-run             # preview inventory churn (adds / delists)
node sync-inventory.js                       # apply: link new, deactivate confirmed-delisted
node sync-inventory.js --target=20           # also raise how many are tracked per property
node import-properties.js                    # CSV -> config (runs discovery too)
node import-properties.js --offline          # re-link competitors from the cached scan
node refresh.js [--property=1]               # scrape 30 nights
node scheduled-refresh.js [--no-sync]        # scrape (+sync) with a run log
node serve.js [--no-open]                    # dashboard at http://localhost:3000
npm run verify:dashboard                     # every panel in a real browser, BOTH themes
node verify-dashboard.js --theme=light       # one theme only (default: both)
npm run sync:dry                             # preview the Sheets payload
npm run report -- --property=1               # HTML + PDF rate report
```

## Where to look for detail

- Full history & reasoning → `CHANGELOG.md`, `DECISIONS.md`
- System shape → `ARCHITECTURE.md`
- Open work → `TASKS.md`, `ROADMAP.md`
- Known problems → `BUGS.md` (all currently fixed, BUG-000…BUG-017)
- Durable facts → `memory/MEMORY.md`
