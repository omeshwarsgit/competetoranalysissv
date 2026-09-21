# Changelog

> **Append-only chronological log**, newest first. The project's black-box recorder: files
> touched, features shipped, bugs fixed, commands run, config changed. Each entry is one action
> with its reasoning. This is the timeline a new AI reads to understand *how* we got here.

## 2026-09-21

### 16:17 — Analysis & run; fixed Windows-1252 decoder fallback (BUG-018); 73/73 unit tests passing

- **Analyzed codebase**: architecture, data pipeline, server on :3000, Google Sheets integration, discovery engine, and Playwright scraping.
- **Fixed BUG-018 in `lib/csv-properties.js`**: added `decodeWindows1252()` with explicit `WIN1252_MAP` (0x80–0x9F codepage characters) because runtime `TextDecoder('windows-1252')` in Node.js on macOS mapped single bytes directly to ISO-8859-1 control code points (0x0092 instead of U+2019 `’`), causing unit test failure on `readCSVText`.
- **Ran verification**:
  - `npm test`: 73/73 unit tests pass (100%).
  - `npm run validate`: clean validation of all 6 own properties and 4 manual competitors in `properties.csv`.
  - `npm run inventory:dry`: 6 properties, 0 churn.
  - `npm run sync:dry`: 64 rows × 54 cols daily grid preview ready.
  - `node serve.js`: verified server startup on port 3001 and existing server on port 3000.
  - `npm run report -- --property=3`: HTML rate report generated successfully at `reports/rate-analysis-3-2026-09-21.html`.

## 2026-08-13

### 01:30 — Light theme finished and verified; the dashboard is now checked in both themes

Picked up an **unrecorded session** that ran 2026-08-12 23:35 → 2026-08-13 00:04 and stopped
mid-audit. It had added a **light theme** to `dashboard/index.html` (a `[data-theme="light"]` token
block, a "Toggle Theme" sidebar button, `localStorage` persistence under `sv-theme`, and
theme-aware Chart.js palettes) but never wrote a CHANGELOG entry, so the brain still described a
295 KB dark-only dashboard while the file on disk was 307 KB.

What it was doing when it stopped is recoverable: it left a grep of the *pre-hardening backup* for
`discFullMktBtn` / `discRunBtn` / `themeBtn` in `project-brain/` (line 300 of the output matches
`_backup-pre-hardening-2026-08-12/index.html` exactly). It was checking whether the hardening pass
had dropped the Discover buttons. **It had not** — those ids were deliberately retired when
Discover and Map merged, replaced by inline `onclick="discoverStart()"` / `discoverStart(true)`
handlers, and `_discLoadFullMarket()` documents the retirement in place. That stray grep output has
been deleted; no code change was needed.

**Light-theme defects found and fixed** (BUG-015, BUG-016, BUG-017)

- **Map popups and the confirm modal were invisible in light theme** — contrast **1.03:1**. Four
  surfaces were hardcoded dark from before the theme existed (`.leaflet-popup-content-wrapper` and
  its tip, `.map-loading-overlay`, `.chart-container`, and the JS-built confirm modal) while their
  text read `var(--text)`, so the foreground flipped to near-black and the background did not. Now
  four tokens — `--popup-bg`, `--modal-bg`, `--overlay-veil`, `--chart-bg` — defined per theme, the
  dark values byte-identical to the literals they replaced so dark is provably unchanged.
- **The sidebar said "Loading…" forever.** `#lastUpdated` was written only by the SSE handler,
  which fires during a refresh, so the freshness indicator never reported freshness on a normal
  load. Added `updateSidebarStatus()` ("Updated 11h ago", exact timestamp as tooltip), plus honest
  text on both of `loadApiData()`'s silent failure exits.
- **`borderColor: 'var(--gold)'`** on the distribution chart — a canvas cannot resolve a CSS
  variable, so the border silently never drew. Now `C.gold`, like its four sibling charts.

**`verify-dashboard.js` now checks both themes**

- `--theme=dark|light|both` (default **both**); every failure is tagged with its theme.
- A **token-level contrast assertion**, because a rendering sweep structurally cannot catch this
  bug class: the DOM is correct and only the pixels are wrong, and a Leaflet popup does not exist
  until someone clicks a pin. Every surface token is checked against `--text` (≥ 4.5:1) and
  `--text-muted` (≥ 3:1), with translucent films composited over `--bg` first.
- An assertion that the sidebar status is not still `/^loading/i` after the page settles.
- Screenshots now cover four panels per theme, written as `<panel>-<theme>.png`.
- **The guard was proved non-vacuous**: reinstating the `#1E2130` popup made the suite fail
  ("theme light: --text on --popup-bg is 1.03:1 (needs 4.5:1)") while the panel sweep reported
  0 errors — exactly the blind spot it was written to close. Then reverted.

**Verified end to end**

| check | result |
|---|---|
| `npm test` | **73/73** pass |
| `node verify-dashboard.js` | 6 properties × 7 panels × **2 themes** · 0 console errors · 0 page errors · **0 forced scans** |
| sidebar status | "Updated 11h ago" (was "Loading…") |
| `build-price-report.js --property=3` | HTML + PDF clean — 0 NaN / Infinity / null% / markdown |
| `sync-sheets.js --dry-run` | 31 rows × 61 cols, 57 properties |
| `sync-inventory.js --dry-run` | pools read, **+0 linked · −0 delisted**, no unintended churn |
| `import-properties.js --check` | 6 own properties, 1 manual competitor |
| API surface | `/api/config`, `/api/latest`, `/api/inventory`, `/api/csv-properties` → 200; unknown `/api/*` → 404 |
| path traversal | raw `../` and `..%2f` both → **404** (a plain `curl` shows 200 only because curl normalises the path client-side, which then hits the SPA catch-all and returns the dashboard HTML — not a leak) |
| `dashboard/index.html` | 307 KB → **310 KB** |

## 2026-08-12

### 20:55 — Production-hardening pass: 21 bugs fixed, 356 KB of dead payload removed

A full review of every file, then Build → Run → Test → Analyze. `npm test` 73/73,
`verify-dashboard.js` 6 properties × 7 panels with **0 console errors / 0 page errors / 0 forced
scans**, a live `refresh.js --property=3` (390 fetches, 0 no-data), a clean PDF+HTML report, and
`sync-sheets --dry-run` / `sync-inventory --dry-run` / `import --check` all green.

**Correctness — numbers that were being invented**

- **Long Weekends priced dates nobody scraped.** `getUpcomingLongWeekends()` returns the next 8;
  7 of them fall beyond the 30-night scrape window, where `inferPrice()` drops through to a
  night-type median. The panel printed that median as a quoted rate, then derived a Suggested price
  and a Raise/Lower action from it — for Diwali, Christmas and New Year. Every figure now reads
  through `observedPrice()`; out-of-window nights render "Not scraped yet" with a coverage note, and
  the demand-surge scorecard shows "—" rather than a surge computed against a ₹1 fallback baseline.
- **Sold-out nights displayed "Hold"** on the Long Weekends panel — `action === 'soldout'` had no
  branch and fell through to the final else, endorsing a rate nobody can book. `soldOutCount` was
  computed and never shown. Own and competitor cells now say "Sold Out", as the calendar does.
- **Position Score went negative.** With no rate tonight `myRank` is null, and
  `(null - 1) / (n - 1) * 100` rendered e.g. "-11%". Now "—" with the reason.
- **"Most Stable Competitor (volatility ₹0 over 0 snapshots)"** — `calcStdDev([])` returns 0, which
  sorted straight to the front, so the panel named the competitor it knew *least* about. Ranking now
  requires ≥ 2 snapshots; the table shows "—" instead of 0 for volatility/changes/drops.
- **The simulator modelled revenue off a placeholder 0.72 occupancy** when no night had both our
  rate and a market rate. It now says what it needs instead.
- **The Excel export disagreed with the calendar it exports from**: blank cells for both "sold out"
  and "not fetched", and Suggested/Action computed for sold-out nights. It now writes
  "Sold Out"/"No data" and suppresses the action, matching `renderCalendar()`.
- **The day-of-week chart drew ₹0 bars** for weekdays with no observed rate (the market series
  already used null). **Suggestions** still bucketed unpriced competitors as 'Mid-Market'; matched
  to Analysis's 'No rate'. **Literal `**markdown**`** was injected via innerHTML in 14 places and
  rendered to users as asterisks.

**Behaviour — things that should not have been automatic**

- **Opening the Discover tab launched a forced Booking.com crawl.** `_discAutoRefresh()` fired with
  `force: true` whenever the cache was over 24h old, so browsing six properties started six scans,
  each rewriting the discovery cache and `config/properties.json` in the background. Confirmed by
  catching two live `discover.js --force` processes spawned by a verification run. Removed in favour
  of the existing "↻ Scan again" link; first-time discovery for an uncached property still runs
  automatically (without `--force`). `verify-dashboard.js` now **fails** if browsing triggers any
  forced scan.
- **Discover showed almost nothing for properties 2–6**: while that auto-scan ran, the status branch
  returned early without loading results. Those panels now render ~164 KB of cards (was ~1.3 KB).
- **"Force Re-scan" was dead** — it set `#discForce.checked` on an element removed when Discover and
  Map merged, throwing a TypeError before `discoverStart()` could run. Force is now an argument.

**Server robustness**

- Two uncaught-TypeError crash paths: `discoverJobs[propId].log.push` on stderr arriving after the
  job's 5s cleanup deleted the entry, and `scanAllJob.*` after `/stop` nulled it. Both now hold the
  job object and null-check. Added `uncaughtException` / `unhandledRejection` guards — a
  single-process local tool with no supervisor should not die into a dead browser tab.
- Child stdout was split on chunk boundaries rather than line boundaries, producing truncated SSE
  events. Added `onLines()`; job logs are now bounded (1000/500 entries) instead of growing all run.
- `POST /refresh` wrote a 200 header *before* validating, so an unknown property id came back as
  HTTP 200 with an error body. Now 404/500 properly, plus a spawn-`error` path.
- **CSV writers**: three divergent copies — one never escaped a `"` inside a competitor name
  (corrupting that row and every row after it), one split on `\n` without stripping `\r`, and all
  three appended a blank line per call. Replaced with `csvCell` / `csvCompetitorRow` /
  `readCsvLines` / `writeCsvLines` (atomic write-then-rename).
- **JSON writers**: every config/dashboard/geo/audit write now goes through `writeJsonAtomic()`. The
  discovery cache was read-modify-written *from the shared in-memory cache object*, silently
  clobbering a concurrent `discover.js`; `updateDiscoveryCache()` re-reads from disk first.
- `readJsonCached` was unbounded — `/api/history` pinned every retained snapshot in memory for the
  life of the process. Now a 12-entry LRU, with `readJsonUncached()` for the one-shot listing.
- Manually added competitors were written with `distance: 0` (top of every distance sort, inside
  every radius filter) and only into `results`, never `fullMarket` — so they never appeared as a map
  pin. Both fixed.
- `--port=` is now supported and validated (previously the PORT env var only, despite the docs).

**Dead code / performance**

- **356 KB of stale baked-in data removed** (53% of `dashboard/index.html`): a `PORTFOLIO` +
  `COMPETITORS` snapshot of the retired 737-property Gurgaon/Srinagar portfolio, plus 28 hardcoded
  coordinate seeds. `applyDashboardData()` deletes every COMPETITORS key on load and
  `syncPortfolioToCsv()` drops every non-CSV id, so it was dead in the normal case — and actively
  misleading in the failure case, rendering May-2026 rates as current whenever the server was
  unreachable. An explicit offline/empty banner replaces it. **667 KB → 295 KB.**
- Removed the ~360-line dead MAP VIEW block (its markup was deleted when Discover and Map merged, so
  `renderMap()` had no caller and every helper addressed missing elements), keeping the three
  helpers Discover still uses.
- Removed `discToggleFullMarket`, `discoverSaveSelection`, `_discToggle`, `discToggleAmenity` and the
  amenity filter (0 of 2,763 cached entries carry an amenity), plus every reference to
  `#discRunBtn` / `#discFullMktBtn` / `#themeBtn`, none of which exist any more.
- **Nav items rendered every panel twice** — an inline `onclick` *and* an added listener. Analysis
  built and destroyed its six Chart.js charts on every single navigation.
- `toggleTheme()` did a full `location.reload()`, discarding loaded data, the selected property and
  the Discover map just to change two colours. It now re-renders.
- Deleted `_check-pooled-map.js` (stray dev script) and `data/discover-all-run.log` (stale copy);
  extended `.gitignore` for runtime artifacts.

**Completed rather than deleted:** the Discover availability filter. Its state, predicate and data
(131 entries flagged, 47 sold out) all existed but no chips rendered it. Added All / Available /
Sold Out chips, wired into both reset paths.

**Also:** `package.json` now exposes the whole command surface (`import`, `coords`, `prune`,
`discover:prices`, `pool:dry`, `verify`). `verify-dashboard.js` gained checks for markdown
artifacts, negative position scores, statistics over empty samples and forced scans — and its
long-standing `Infinity`-in-a-property-name false positive is fixed properly (`(?!\s+[A-Za-z])`),
unit-tested against 14 cases, because the sloppier version flagged the real listing
"…Luxury 5BR Villa - Infinity Pool & Sea View".

Files: `serve.js`, `dashboard/index.html`, `verify-dashboard.js`, `package.json`, `.gitignore`
(modified); `_check-pooled-map.js`, `data/discover-all-run.log` (deleted);
`_backup-pre-hardening-2026-08-12/` (pre-edit copies of the three big files).


## 2026-08-11

### 18:10 — Sold-out nights now carry an estimated price in the analysis, clearly marked
Requested: include sold-out dates in analysis, priced at that property's average available rate,
marked as estimated. This reverses the earlier rule that a sold-out night is never priced — the
user's version supplies the marking that was missing, so it was implemented.

`inferPrice()` was **left untouched**: the map pins, the calendar and the competitor-occupancy
analysis all need sold-out to stay distinguishable from priced, and the occupancy analysis *is* the
sold-out signal. The new path is `avgAvailablePrice()` + `priceOrEstimate()`, used by the Analysis
panel only. A `nodata` night stays null — a night nobody fetched is not evidence of anything. Each
competitor is estimated **from itself**, never from the market average, which would drag every
property toward one number and manufacture agreement that was never observed.

**Measured effect on the real portfolio, per metric:**
- **Averages/ADR — unchanged, always.** Filling with the mean cannot move the mean.
- **Comparisons genuinely improved.** Per-date market band, pricing mix, tonight's distribution and
  market position now cover the whole tracked set. Previously, on a busy weekend most competitors
  dropped out and the "market average" came only from whoever still had rooms — systematically the
  expensive ones.
- **Trend, weekend premium, volatility are flattened by construction.** Slope roughly halves
  (₹277→₹164/day); R² collapses (0.91→0.54, 0.85→0.31, 0.79→0.28); weekend premium roughly halves
  (7%→3%, 4%→1%) because **weekends sell out first**, so weekend nights are precisely the ones
  replaced by the flat average; volatility falls (15%→13%).

**Consequence flagged to the user:** R² dropping below the 0.35 confidence gate flips the Forward
Trend headline to **"Flat"** for properties whose observed rates rise strongly — property 2 reads
"Flat" against a measured **+58% (R² 0.85)**, property 3 "Flat" vs **+49%**, property 5 "Flat" vs
**+21%**. So the panel shows the **measured** figure beside the estimated one for those three shape
metrics and states the basis under the chart. Switching the headline back to measured is a one-line
change (`fitMeas` / `trendWindowPctMeasured` are already computed).

**Marking:** ✕ hollow markers and dashed segments on the trend chart, dashed outline + (brackets) in
the heatmap with a legend, `·Ne` beside a competitor's average, "(₹x) est" on the positioning pin,
"estimated (sold out)" in tooltips, an estimated-night count on the ADR card, and a note under the
chart naming the fill rate and what it does and does not affect.

- **Verified:** all 6 properties in a real browser, 0 console/page errors; ADR identical
  measured-vs-estimated on every property; estimated cell counts match each property's sold-out
  count (10/14/17/12/14/11); 73/73 tests still pass.
- **Files:** `dashboard/index.html` (modified).

### 17:20 — Analysis panel corrected, competitor occupancy added, market pooled per location
Four threads, all verified against real data.

**Trendline and the analysis maths.** Two systemic faults, both easy to reintroduce — recorded in
`memory/analysis-numbers-must-scale-and-admit-unknowns.md`.
- *Absolute thresholds across a 6x ADR spread.* Direction was `slope > 30 ? 'rising'`; at ₹30/day a
  ₹3,299 property drifts 27% across the window while a ₹19,456 one moves 4.6%. Property 5
  (0.74%/day, R² 0.43) and property 3 (1.69%/day, R² 0.79) fell on opposite sides for reasons
  unrelated to trend strength. Now expressed as % of that property's own ADR.
- *A slope with no fit is not a trend.* Added `trendR2`; a direction is claimed only at R² ≥ 0.35,
  ≥5 priced nights and ≥0.25%/day drift. Otherwise "Flat", with a distinct insight for
  drifts-but-noisy. New **Forward Trend** KPI showing window drift, ₹/day and R².
- *Unknowns rendered as confident zeros.* `estOcc` returned a hardcoded **0.72** for nights with no
  competitor rate and that fed the RevPAR headline; weekend premium printed **"+-5%"** for the two
  properties with genuinely negative premiums; Market Position keyed off `dates[0]` alone so it
  blanked for **4 of 6** properties (sold out tonight) under the false label "No competitors set";
  `getCompetitorSegment(null,…)` filed all 19 unpriced competitors into 'Mid-Market'. All now show
  "—" with the actual reason, and unpriced competitors get their own "No rate" bucket.
- Weekend premium was also read from `obs` (every date ever observed) rather than the forward 30, so
  it would silently describe a different period than the ADR beside it.

**New: competitor occupancy from observed sold-out nights.** The one occupancy figure here that is
measured rather than modelled. Occupancy proxy = `soldout / (soldout + available)`, with `nodata`
nights excluded from *both* sides, plus a `coverage` column so a property assessed on 6 nights is not
read like one assessed on 30. Shows own vs market, busiest/quietest competitor, the property's demand
rank, and a per-competitor comparison table. Feeds two insights, including the actionable case:
market more sold out than us *while* our ADR is above theirs.

**Market pooled per location** (user chose share-pool / rank-per-property). All six North Goa
properties now see one inventory — **1,011 unique listings** from 1,284 across the cluster. Property
4 went from 56 to 947 candidates on the map. Critically the union is computed **on read** in
`serve.js` and memoised: writing each property its own copy takes the cache from 2.3 MB to ~10 MB,
and it is `JSON.parse`'d whole by four scripts — the BUG-003 pattern. Distance is recomputed per
property so ranking stays local. `?scope=property` opts out. Pool key is `district, state` from
reverse-geocoded metadata, not Booking.com's `city` (which returns Marra/Vagator/Sinquerim/Arpora and
would split one market into four).

**Inventory correctness fix found by running it.** The first full 6-property scan reported **763
absent** for property 1 — not departures, but the regional set from an earlier text-search surge,
outside an area-only scan's reach (missed p50 8.1 km / max 67.9 km against a found p90 of 10.6 km).
The miss counter is now **scope-aware**: a property beyond the distance band a scan actually returned
does not accrue a miss. 316 inflated counters were corrected. Also capped probes per run
(`--max-checks`, default 150, longest-absent first) so one bad scan cannot queue hundreds of checks.

**`discover-all.js` could not do what was asked.** It skipped every property without `--force`, and
its per-child cap was **5 minutes** — under half of what a real scan needs (property 1's took ~10
min), and since `discover.js` writes its cache only at the end, a SIGKILL discarded the entire scan.
Default is now 20 minutes, configurable, and a timeout reports as a failure. Removed the dead
`force` variable in `discover.js` and corrected its usage header.

**Data loss, and the guard for it.** Properties 2 and 4 had `competitors[]` emptied (10 → 0, 15 → 0)
with 25 competitor records and their scraped rates pruned — the exact signature of
`POST /api/reset-competitors`. The user confirmed it was not them. Restored from the 09:55 copy
(targeted repair: only the emptied lists and pruned entries, keeping today's coordinates). Added:
`lib/json-store.js` optimistic-concurrency guards on the three long-window writers
(`sync-inventory.js`, `resolve-property-coords.js`, `discover.js` — they now **abort** rather than
clobber, exit 3), and an **audit trail** to `data/config-audit.json` recording caller, user-agent,
referer and before/after counts for `reset-competitors`, `discover/commit` and `add-competitor`, so a
third occurrence is attributable in one look.

Also fixed: `pkill -f "3199"` never matched anything (the port is an env var, not an argv entry), so
two "verified" checks had actually queried a stale server. Killing by PID now.

- **Verified:** 73/73 unit tests (11 new for the concurrency guard) · all 6 properties' analysis
  panels in a real browser, 0 console/page errors, every KPI reading correctly including negative
  weekend premiums and "—" for genuine unknowns · pooled map 913/947 markers, 0 errors · config
  validates, no dangling refs.
- **Files:** `dashboard/index.html`, `serve.js`, `discover.js`, `discover-all.js`,
  `sync-inventory.js`, `resolve-property-coords.js`, `package.json` (modified);
  `lib/json-store.js`, `lib/market-pool.js`, `pool-market.js`, `test/json-store.test.js` (created).

### 15:45 — Continuous inventory: auto-add new listings, confirm and deactivate delisted ones
New feature. Each scan now maintains the property inventory per location instead of only ever
accumulating.

**The load-bearing design decision: absence from a scan is not evidence of delisting.**
`discover.js` searches one night 7 days out, and Booking.com omits properties with no availability
for the probed dates — so a fully-booked property disappears for exactly the same reason a deleted
one does. Measured it: one scan of property 1 reported **12 of 24 absent**, and probing all 12
found **every one live (HTTP 200)**, including tracked competitors `kingsgate` and `Wildflower Goa`.
A naive rule would have dropped half the pool and lost price history that cannot be re-scraped.

The confirmation test, established empirically: a live listing returns **200** with a ~1.3 MB page
even when sold out for all 30 nights; a removed one returns **404** with 0 bytes; a merged one
returns **3xx** with a `Location`.

- **`discover.js`** now maintains `missedScans` / `status` / `relistedAt` per pool entry and reports
  `missingSince` and `relisted` alongside `newSince`. `lastScanFound` had been written since day one
  and never read by anything.
- **`lib/inventory.js`** — the state machine: `classifyProbe`, `delistCandidates`, `applyVerdict`,
  `reconcileTracked`, `purgeableIds`. Only an explicit 404/410 delists; 429/202/5xx/network errors
  keep the property *and* decay the miss counter, so repeated throttling can never accumulate into a
  delisting.
- **`sync-inventory.js`** — links new arrivals up to a target, probes candidates, deactivates
  confirmed departures, writes `data/inventory-log.json`. Deactivation keeps the pool entry, its
  config row and its price history; `--purge` is opt-in because there is no git history here.
  Flags: `--dry-run --property= --target= --miss-threshold= --no-confirm --purge`.
- **`test/inventory.test.js`** — 38 tests. `npm test` is now 62.
- **`scheduled-scan.js`** runs the sync after a successful scan (skipped if every scan failed, so a
  bad run cannot mass-delist). **`GET /api/inventory`** exposes per-property pool/active/delisted/
  tracked/missing counts plus the churn feed.
- **Two bugs caught by testing on real data**, both the project's recurring identity trap: the pool
  spells ids with hyphens (`antarim-resort`) while `config.competitors[]` uses underscores
  (`antarim_resort`). Uncanonicalised, `reconcileTracked` saw every already-linked competitor as a
  new arrival (it would have duplicated the whole tracked set), and `purgeableIds`' "still linked
  elsewhere" guard never fired while the config row it meant to delete survived. Both now
  canonicalise, with tests pinning each direction.
- **Verified:** 62/62 unit tests · the 12-false-alarm run above · a synthetic dead listing taken
  through the full path (404 → unlinked → backfilled to target → logged → `--purge` removing it from
  cache, config and dashboard) · real data restored and confirmed intact afterwards.

**Also, and separately — property 1 lost 10 linked competitors during this session.** Its
`competitors[]` went from 12 to exactly the 2 ids in `discovery-cache.json`'s `selected` list, the
signature of `/api/reset-competitors` followed by `/api/discover/commit`, while background scans and
browser-driven dashboard verification ran against a live server. The trigger was never pinned down.
Restored from a pre-session copy (union with the 2 → 14). Root hazard recorded in
`memory/config-writes-race-no-locking.md`: **five** things read-modify-write `config/properties.json`
with no locking, so any overlap silently loses one side's changes.

- **Files:** `discover.js`, `scheduled-scan.js`, `serve.js`, `package.json` (modified);
  `lib/inventory.js`, `sync-inventory.js`, `test/inventory.test.js` (created);
  `config/properties.json` (property 1 restored).

### 13:30 — Map pins no longer show "—" for properties that have a rate (BUG-008)
User-reported with a screenshot. Three separate causes, all in how the pin got its price:

- `inferPrice()` returns **null for a sold-out night deliberately** — inferring a night-type median
  for an unbookable night once put fabricated rates into the comparison tables and the occupancy
  simulator. Right for analytics, wrong for a pin: a property merely **full tonight** still has a
  real rate later in the window. That dashed 10 of 62 tracked competitors and the own-property pin
  for properties 2, 3, 5 and 6.
- Only the **primary room** was read, so a sold-out primary could mask an available second room.
- The Discover map used only `entry.price` (the search card), so an entry with 30 nights of scraped
  rates still showed a dash when its card had no price.

Added `mapPinPrice(entity, today, cardPrice)`: tonight across **all** rooms → next available night
→ search-card price, returning the basis used. `inferPrice()` untouched. Price format and currency
styling unchanged; the basis appears in the tooltip and popup ("from 19 Aug", "search rate") so a
later night is never presented as tonight's rate, and the cheaper/pricier colouring plus the
"vs yours" delta now apply **only** when both sides are tonight's rate.

Then ran `fetch-discover-prices.js --nights=30 --only-missing` across all 6 — the purpose-built
tool for the remaining gap (candidates never price-scraped whose card carried no price).

**Verified** in a real browser on all 6: **0 pins dashed despite a rate existing in any source**,
0 console/page errors. A dash now genuinely means no rate anywhere.

**Also found:** the whole `MAP VIEW` block (`renderMap()`, `placeMapMarkers()`,
`buildMapCompList()`) is **dead code** — never called, DOM targets absent. The live map is the
Discover panel's. Updated for consistency but left in place; deleting ~380 lines of a retired
feature needs the user's say-so in a project with no git history.

- **Files:** `dashboard/index.html` (modified), `data/discovery-cache.json` (prices filled)

### 12:50 — Backlog cleared: one CSV parser + tests, scheduled scraping, report de-fabricated
Closed every open task except the two that are product decisions (see TASKS.md). Verified with
`npm test` (24 pass), `node verify-dashboard.js` (6 properties × 7 panels, 0 errors), all six
reports rebuilt clean, and a full `scheduled-refresh.js` run.

- **T-010 — one CSV parser.** `prune-to-csv.js`, `resolve-property-coords.js` and
  `import-properties.js` now read the sheet through `lib/csv-properties.js`; `serve.js` already
  did. The copies had begun to disagree: `import-properties.js`'s slug regex was `[^.?/]+` where
  everyone else used `[^.?/#]+` (a `#fragment` leaked into the slug, so no stored record could
  match it again), and it preferred the legacy `Stayvista Property` column for display names
  while the dropdown preferred `Property`. `import-properties.js` keeps its own row-object layer
  and multi-unit grouping deliberately — `readProperties()` collapses repeated IDs, but the
  import must see every unit row for `pickBaseName()`.
- **Added `test/csv-properties.test.js`** — 24 tests via `node --test`, the project's first tests.
  Writing them immediately found a real bug: `parseCSVLine` flipped an in-quote flag on every `"`
  and so could not read the escaped-quote form (`""`) that `formatCSVLine` writes. Any property
  name containing a double quote lost its quotes on every `--write-csv` round-trip. Parser now
  follows RFC 4180.
- **T-005 — share links handled by a plain import.** Added `--links-only` to
  `resolve-property-coords.js` (stage 1 redirect-follow only, no browser, no coordinates).
  `import-properties.js` detects rows whose link yields no slug and delegates to it via
  `execFileSync` before parsing; `--check` stays read-only and instead reports the exact command.
  Verified by injecting a share link: detection fired, the resolver ran browserless, the dead link
  was reported honestly, and the sheet was left untouched.
- **T-009 — price scraping is scheduled.** Added `scheduled-refresh.js` (scrape → optional Sheets
  sync → `data/refresh-log.json`, last 30 runs, non-zero exit so Task Scheduler shows failure) and
  `setup-daily-refresh.bat` at 06:00, four hours after discovery. **Found the existing scan task
  was silently logging nothing:** `schtasks /TR` does not run through a shell, so the
  `>> log 2>&1` written into it was passed to `node.exe` as three extra argv entries. Both tasks
  now point at wrapper scripts (`run-scheduled-scan.cmd`, `run-scheduled-refresh.cmd`) that own the
  redirection and resolve node from PATH instead of a hardcoded Program Files path.
- **T-007 / BUG-003 — dropped the `allDiscovered` cache duplicate.** It was written as an
  "explicit alias" holding the same array as `fullMarket`, so every candidate was serialised
  twice; it was 21% of the file and byte-identical in all 6 entries. Both readers already fell
  back. A scan now also strips it from every other entry. Cache: 377 KB → 266 KB (30%).
- **BUG-006 — `build-price-report.js` refused to run, then fabricated findings.** Fixed both;
  see BUGS.md. It gated on a discovery search-card price that is `null` for every candidate the
  coordinate search returns, while ignoring the 30-night scraped curves it had already loaded.
  Underneath that, the report was bespoke to the hostel that used to be Property ID 1 and asserted
  its competitors, rates and premiums for any property.
- **BUG-007 — unknown `/api/*` paths returned the dashboard.** The static fallback answered any
  unmatched GET, so a mistyped or retired endpoint returned 644 KB of HTML with a 200 and the
  client reported "Unexpected token <" from whichever panel called it. Now a JSON 404.
- **`/api/history` no longer offers dataless snapshots.** The D-004 prune left 8 dated files
  holding nothing but their `meta`, and the History picker listed all 8 as selectable dates that
  could never produce a comparison. Filtered on `portfolio` being non-empty; the files stay on
  disk as the record of when a scan ran.
- **Config backups now rotate.** `import-properties.js` wrote a timestamped copy of the whole
  property set per run and never removed one; `config/` had reached 4 MB against the old
  737-property portfolio. Keeps the newest 5.
- **`serve.js --no-open` / `NO_OPEN=1`** so a scheduled, headless or verification run does not
  spawn a browser window nobody closes.
- **Promoted the throwaway harness** `_verify-all.js` to `verify-dashboard.js`: reads its property
  list from the CSV, fails on thin/suspect panels rather than only printing, supports
  `--port` / `--properties` / `--screenshots`, and exits non-zero. Wired up as
  `npm run verify:dashboard`.
- **Removed:** `_verify-all.js`, `discover-all.log`.
- **Files:** `lib/csv-properties.js`, `import-properties.js`, `prune-to-csv.js`,
  `resolve-property-coords.js`, `build-price-report.js`, `serve.js`, `discover.js`,
  `package.json`, `setup-daily-scan.bat` (modified); `test/csv-properties.test.js`,
  `scheduled-refresh.js`, `setup-daily-refresh.bat`, `run-scheduled-scan.cmd`,
  `run-scheduled-refresh.cmd`, `verify-dashboard.js` (created).

### 11:53 — Discovery scan: the Booking.com text search works after all
Ran `node discover.js --property=2 --force` to validate the cache write path. The **City stage
returned 24 properties** where every probe the day before returned 0 — same query, same client.
Merged with the Area stage's 23 for 84 unique candidates; property 2's cumulative pool went
22 → 95 (92 ranked, 73 new). So the `ss=` text search is **intermittent, not unavailable**, and
both earlier diagnoses of BUG-005 were wrong. The current design — probe once cheaply, fall back
to coordinate search, report clearly — is correct and unchanged. Recorded in
`memory/booking-text-search-is-flaky.md`; consequence: **pool sizes are not comparable between
scans**.

## 2026-08-10

### 16:30 - Accurate coordinates for every property; map crash fixed
- **What:** Wrote `resolve-property-coords.js`. It follows each sheet link's redirects to recover the
  canonical `/hotel/in/<slug>` URL, then loads that page in Chrome and reads latitude/longitude from
  the JSON-LD `geo` block. All 6 properties resolved with exact North Goa coordinates. Ran
  `--write-csv` to rewrite the sheet's share links to canonical URLs. Then ran `discover-all.js`:
  **142 competitor candidates, all 142 with coordinates.**
- **Also fixed the Discover panel crash** (`Cannot read properties of null (reading 'lat')`):
  `_discEnsureOwnMarker()` called `nominatimGeocode()` **without `await`**, so a Promise was written
  into the sessionStorage coordinate cache, serialised to `{}`, and handed to Leaflet - whose
  `L.latLng()` returns null for bad input rather than throwing, surfacing the error later from inside
  the library. Added the missing `await`, plus `validCoords()` / `readCoordCache()` /
  `writeCoordCache()` / `coordsOf()` so no unvalidated coordinate can reach Leaflet, and bumped the
  cache key to `sv_mapCoords_v5` to retire poisoned entries. The map now opens on the property when
  known and on an India-wide view when not (a wrong city reads as real data; an India view reads as
  "unknown"). A property without coordinates is listed but not plotted, with an explanatory note.
- **Why:** The prune left the 6 properties with no coordinates, which exposed both the crash and the
  fact that the sheet's share links made accurate geolocation impossible.
- **Sequencing note:** canonicalising the CSV was *required* for the map, not just cosmetic. The slug
  identity guard (D-003) could not confirm a share-link row, so it replaced each entry with a
  coordinate-less stub and the own-property pin never rendered (`ownPin=0`). Once the sheet carried
  canonical URLs the slugs matched, the coordinates survived, and `ownPin=1` for all six.
- **Files:** `resolve-property-coords.js` (created), `dashboard/index.html` (modified),
  `properties.csv` (links canonicalised), `config/properties.json`, `data/geo-cache.json`,
  `data/property-meta.json`, `data/discovery-cache.json` (all modified)
- **Verified in a real browser** (CDP Chrome, all 6 properties): no crash banner, 0 console errors,
  0 uncaught page errors, 22-24 competitors listed each, own-property pin present on every property.
- **Impact:** Unblocks BUG-001 - `import-properties.js` and `refresh.js` can both work on this sheet
  now. Prices are the only thing still missing.
- **Refs:** D-003, D-005, BUG-001, BUG-004, BUG-005, T-002, T-003, T-012

### 15:39 — Purge all data for properties absent from the sheet
- **What:** Wrote `prune-to-csv.js` and applied it. Removed **12,239 records**: 1,038 own +
  5,423 competitor entries from `config/properties.json`; 1,038 portfolio + 28 competitor entries
  from `data/latest.dashboard.json`; 1,044 scans from `data/discovery-cache.json`; 1,252 portfolio
  entries across 8 files in `data/history/`; 1,046 records from `data/property-meta.json`; 1,368
  coordinates from `data/geo-cache.json`; 2 folder sets from `data/discovery-folders.json`.
  `discovery-cache.json` went **253 MB → 2 bytes**. Config now holds 6 own entries, 0 competitors.
- **Why:** Filtering the dropdown alone left stale data live and reachable via other endpoints, the
  Sheets sync and reports. User required the sheet to be the single source of truth for what the
  system *contains*, not just what it displays.
- **How:** Rebuilds each file from the sheet, applying the D-003 identity rule uniformly — a record
  survives only when its Booking.com slug matches the sheet row's slug. Because all 6 rows carry
  share links (no slug), nothing could be confirmed, so all 6 are fresh stubs. Ran `--dry-run`
  first; the dry run caught an inconsistency where three caches were still filtering by ID alone
  and wrongly retaining 2 old Backspace/Boulevard records.
- **Files:** `prune-to-csv.js` (created), `config/properties.json`, `data/latest.dashboard.json`,
  `data/discovery-cache.json`, `data/history/*.dashboard.json`, `data/property-meta.json`,
  `data/geo-cache.json`, `data/discovery-folders.json` (all modified)
- **Backup:** `_backup-2026-08-10-15-39-41/` (249 MB, written automatically before any write)
- **Impact:** Every endpoint now serves exactly the 6 sheet properties. No property has price data
  yet — blocked on BUG-001. BUG-003 is dormant as a side effect.
- **Refs:** D-004, BUG-001, BUG-003

### 15:10 — Property dropdown driven exclusively by properties.csv
- **What:** Added `GET /api/csv-properties` to `serve.js`: a live, mtime-cached parse of
  `properties.csv` returning `{ id, name, url, slug }` per own row, in sheet order, with the same
  3-pass ID normalisation and UTF-8→Windows-1252 fallback as `import-properties.js`. Rebuilt the
  dashboard selector on top of it — `CSV_PROP_IDS/ORDER/NAMES/SLUGS`, `syncPortfolioToCsv()`,
  `watchCsvProperties()` (15 s poll), and an empty-state placeholder.
- **Why:** The dropdown was listing 307 properties that no longer existed in the CSV, because
  `config/properties.json` accumulates — `--property=` imports preserve every other entry. Then a
  new 6-row sheet exposed a second, worse problem: reused IDs 1 and 5 would have shown
  `Backspace Anjuna Beach` / `The Boulevard Villa` **and their old prices** under the new names.
- **Files:** `serve.js` (modified), `dashboard/index.html` (modified)
- **Impact:** Dropdown = exactly the sheet's rows, labelled from Column B, in sheet order,
  auto-refreshing. Empty sheet ⇒ empty dropdown. Stored data only attaches to a row when the
  Booking slug matches. Verified against the 737-row sheet (737 options, 651 keeping data), the
  6-row sheet (6 options, no leakage), and blank / competitor-only sheets (0 options).
- **Refs:** D-001, D-002, D-003, BUG-000, T-001

### 14:05 — Corrected a false security flag
- **What:** Retracted an earlier claim that the Apps Script shared secret was exposed.
- **Why:** Verified the actual layout: `config/sheets.json` and `config/Code.deploy.gs` (which holds
  the real secret) are both in `.gitignore`; the committed `apps-script/Code.gs` contains only the
  `CHANGE_ME_TO_A_LONG_RANDOM_STRING` placeholder. Nothing needed moving.
- **Impact:** No change made. Recorded so the next session doesn't "fix" a non-problem.

### 13:30 — Project Brain created and populated
- **What:** Ran `universal-project-brain\init-brain.ps1 -Target <project>`, then populated
  `CONTEXT.json`, `HANDOFF.md`, `ARCHITECTURE.md`, `CURRENT_STATE.md`, `DECISIONS.md`, `BUGS.md`,
  `CHANGELOG.md`, `TASKS.md`, `ROADMAP.md`, `PROJECT_OVERVIEW.md` and `memory/` from a full
  read of the codebase.
- **Why:** The project had no brain, so context was being rebuilt from source every session.
- **Files:** `project-brain/**` (created), `BRAIN_PROTOCOL.md` (created),
  `.claude/commands/brain.md` (created)
- **Impact:** Any model can now resume from `project-brain/HANDOFF.md` with no context loss.

<!-- template scaffold below -->

### <HH:MM> — <short title of the change>
- **What:** _<what changed>_
- **Why:** _<reason>_
- **Files:** `path/one`, `path/two` _(created / modified / deleted)_
- **Impact:** _<effect on the project — what now works / what this unblocks>_
- **Refs:** _<D-00X, T-00X, BUG-00X if relevant>_
