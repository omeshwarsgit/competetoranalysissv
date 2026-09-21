# Bugs

> Track discovered and fixed bugs. Move entries from Open → Fixed as they're resolved (edit the
> status; don't delete). Every fix records the root cause so the same class of bug isn't reintroduced.

## 🔴 Open

_(none)_

---

## ✅ Fixed

### BUG-018 — Node.js TextDecoder('windows-1252') decoded bytes 0x80-0x9F as ISO-8859-1 code points
- **Severity:** medium
- **Discovered:** 2026-09-21 (running `npm test` on macOS / modern Node.js)
- **Symptom:** `npm test` failed on `readCSVText falls back to Windows-1252 rather than corrupting names`.
- **Root cause:** In Node.js environments without full ICU legacy single-byte table mappings, `new TextDecoder('windows-1252').decode(buf)` maps single-byte codes directly to ISO-8859-1 code points `U+0000 + byte`. For Windows-1252 characters in the 0x80–0x9F range (such as curly apostrophe `0x92` or em-dash `0x96`), byte `0x92` was returned as `U+0092` (control character) instead of `U+2019` (`’`).
- **Fix:** Added `decodeWindows1252(buf)` in `lib/csv-properties.js` with an explicit codepage lookup table for bytes 0x80–0x9F (`WIN1252_MAP`), ensuring cross-platform decoding correctness when falling back from UTF-8.
- **Class to avoid:** Do not rely on runtime `TextDecoder` supporting legacy single-byte codepage tables (like Windows-1252) consistently across platforms without verification or explicit fallback mapping.

### BUG-015 — The light theme made map popups and the confirm modal unreadable
- **Severity:** high (the confirm modal is the gate on the destructive "Reset Competitors")
- **Discovered:** 2026-08-13, auditing the light theme added late on 2026-08-12
- **Symptom:** in light theme the Leaflet map popups and the confirm dialog rendered near-black
  text on a near-black box — measured contrast **1.03:1**. The text was present and correct; it was
  simply invisible. Every panel still "rendered", and `verify-dashboard.js` passed clean.
- **Root cause:** the theme is driven by CSS custom properties, but four surfaces had been written
  as literal dark colours long before a second theme existed — `.leaflet-popup-content-wrapper`
  and its tip (`#1e2130`), `.map-loading-overlay` (`rgba(8,10,16,.82)`), `.chart-container`
  (`rgba(0,0,0,0.20)`) and the JS-built confirm modal (`#161924`). Their *content* correctly used
  `var(--text)`, so when `[data-theme="light"]` flipped `--text` to near-black, the foreground
  moved and the background stayed. The light theme shipped with only three overrides (`.topbar`,
  `.sidebar` and the token block), which covered the two surfaces that were easy to see.
- **Fix:** four new tokens — `--popup-bg`, `--modal-bg`, `--overlay-veil`, `--chart-bg` — defined in
  both themes, with the dark values kept byte-identical to the literals they replaced so the dark
  theme is provably unchanged. The confirm modal now reads `var(--modal-bg)` / `var(--text)` /
  `var(--text-muted)` / `var(--surface-2)` / `var(--border)` instead of six hardcoded colours.
- **Class to avoid:** *a themed app has no hardcoded surface colours.* Text and the surface behind
  it must come from the same theme, or one of them moves without the other. A rendering sweep
  cannot catch this — the DOM is perfect and the pixels are not — so the invariant is now asserted
  at the token level by `verify-dashboard.js` (every surface vs `--text` ≥ 4.5:1, vs `--text-muted`
  ≥ 3:1, translucent films composited over `--bg` first). Confirmed non-vacuous: reintroducing the
  `#1E2130` popup made the suite fail with "1.03:1 (needs 4.5:1)" while the panel sweep stayed green.

### BUG-016 — The sidebar read "Loading…" forever
- **Severity:** medium
- **Discovered:** 2026-08-13 (visible in the light-theme screenshots, and equally wrong in dark)
- **Symptom:** the status line above "Refresh Data" — the one place that reports how fresh the rates
  are — showed "Loading…" indefinitely on a dashboard that had finished loading. It only ever
  corrected itself if the user triggered a refresh.
- **Root cause:** `#lastUpdated` shipped with the literal text `Loading…` and the *only* writer was
  `connectRefreshSSE()`, which fires exclusively during a refresh run. The normal load path
  (`loadApiData()` → `applyDashboardData()`) set the topbar's `#scannedAt` and never touched it.
  Both of `loadApiData()`'s failure exits (`!res.ok`, and the `catch`) also returned silently.
- **Fix:** `updateSidebarStatus()` runs at the end of `applyDashboardData()` and renders
  "Updated 11h ago" with the exact timestamp as a tooltip; it distinguishes "no scrape recorded
  yet" from still-loading, and an unparseable timestamp from a missing one. The two failure exits
  now say "Server unreachable" / "No data (server said 503)" rather than leaving the spinner label.
- **Class to avoid:** *a placeholder needs an owner on every path that can reach it.* "Loading…"
  written in markup is a promise that some code will overwrite it — including on the error paths,
  which are exactly the ones where a stale "Loading…" is most misleading. `verify-dashboard.js` now
  fails if the status still matches `/^loading/i` once the page has settled.

### BUG-017 — A chart border was set to a CSS variable the canvas cannot resolve
- **Severity:** low
- **Discovered:** 2026-08-13
- **Symptom:** the Competitor Pricing Distribution bars had no gold border.
- **Root cause:** `borderColor: 'var(--gold)'` in the Chart.js dataset. Chart.js paints to a
  `<canvas>`, where assigning an invalid colour string to `strokeStyle` is *silently ignored* and
  the previous value stands — CSS custom properties are resolved by the CSS engine, which the
  canvas never consults. The four sibling charts in the same function already used the JS-side
  palette object, so this one line was the odd one out.
- **Fix:** `borderColor: C.gold`, matching every other dataset in the file.
- **Class to avoid:** *`var()` only works where CSS is parsed.* Canvas, and anything handed to a
  drawing API, needs a resolved literal — or `getComputedStyle(el).getPropertyValue('--gold')`.

### BUG-009 — The Long Weekends panel priced dates that were never scraped
- **Severity:** high
- **Discovered:** 2026-08-12 (review pass; `/api/holidays` returns 8 long weekends, the scraper
  covers 30 nights)
- **Symptom:** the panel showed complete rate tables, Suggested prices and Raise/Lower actions for
  Diwali, Christmas, New Year and Makar Sankranti — months outside the scraped window. The numbers
  looked exactly like observed rates.
- **Root cause:** `inferPrice(room, date)` is a deliberate *inference* function: for a date not in
  `room.observed` it returns the median of that night type's observed prices. That is right for its
  original purpose and wrong as a data source for a panel whose dates can sit outside the window
  entirely. `getUpcomingLongWeekends(today, 8)` looks ~5 months ahead; `refresh.js` fetches 30
  nights. Nothing in between checked whether a date had ever been fetched.
- **Fix:** the panel reads through a local `observedPrice()` (a value only when
  `availabilityOf() === 'available'`), and `inWindow()` decides whether a date was fetched at all.
  Out-of-window rows render "Not scraped yet" across the price columns with a per-section coverage
  note; the demand scorecard shows "—". Added `SCRAPE_NIGHTS = 30` as the single shared constant
  for the window, since three panels had it hardcoded.
- **Class to avoid:** *never treat `inferPrice()` as evidence a night exists.* It answers "what
  would this night plausibly cost", not "what did Booking.com quote". Any panel that can display a
  date beyond the forward window must gate on `availabilityOf()` first.

### BUG-010 — Opening the Discover tab started a forced Booking.com crawl
- **Severity:** high
- **Discovered:** 2026-08-12 (two live `discover.js --property=N --force` processes were found
  running after a `verify-dashboard.js` run that should have been read-only)
- **Symptom:** switching properties on the Discover tab silently launched a full market scan per
  property. While each ran, that property's Discover panel showed only its linked competitors
  (~1.3 KB of cards instead of ~164 KB), because the "running" branch returned before loading
  results.
- **Root cause:** `_updateDiscCachedInfo()` called `_discAutoRefresh()` — which posts
  `force: true` — whenever the cache was more than 24h old. Since a scan rewrites
  `data/discovery-cache.json` and `config/properties.json`, merely *viewing* the tab mutated the
  data store, and the pool sizes it produced then differed run to run (the `ss=` text search is
  intermittent — see `memory/booking-text-search-is-flaky.md`).
- **Fix:** removed `_discAutoRefresh()`. A stale cache surfaces the existing "↻ Scan again" link
  (now passing `force: true` explicitly). First-time discovery for a property with no cache at all
  still runs automatically, without `--force`, because there is nothing to display otherwise.
  `verify-dashboard.js` now watches outgoing requests and fails on any forced scan triggered by
  browsing.
- **Class to avoid:** rendering a panel must never start a scraping job. Discovery is expensive,
  externally rate-limited, and destructive to the caches other panels read.

### BUG-011 — Sold-out long-weekend nights were labelled "Hold"
- **Severity:** medium
- **Discovered:** 2026-08-12
- **Symptom:** a night the property cannot sell displayed the "Hold" action badge — i.e. an
  endorsement of the current rate — on the Long Weekends panel. `renderCalendar()` had been fixed
  for this; the LW panel had not.
- **Root cause:** `action` was set to `'soldout'` and counted into `soldOutCount`, but `actHtml`
  had branches only for `lower`/`raise` and an unconditional else returning "Hold". `soldOutCount`
  was never rendered.
- **Fix:** explicit `soldout` branch, a distinct "—" badge for "no rate or no comparison", and the
  sold-out tally added to the summary bar. Own and competitor cells now render "Sold Out"/"—" by
  availability instead of a bare dash.

### BUG-012 — Statistics reported over an empty sample
- **Severity:** medium
- **Discovered:** 2026-08-12 (surfaced by a new `verify-dashboard.js` rule)
- **Symptom:** "Most Stable Competitor — *X* (volatility ₹0 over 0 snapshots)", and a Position
  Score of "-11%".
- **Root cause:** two instances of the same shape — a function that returns 0 for "nothing to
  measure", consumed as though 0 were a measurement. `calcStdDev([])` returns 0, and the stability
  ranking sorts ascending by std-dev, so the competitor with *no* history sorted first. Separately
  `positioningScore` computed `(myRank - 1) / (total - 1)` with `myRank` null.
- **Fix:** stability ranking considers only competitors with ≥ 2 snapshots (and says so when none
  qualify); the per-competitor table shows "—" rather than 0. `positioningScore` is null when there
  is no own rate. The simulator's baseline occupancy is null instead of falling back to 0.72.
- **Class to avoid:** this is the same failure the 2026-08-11 analysis pass fixed elsewhere
  (`memory/analysis-numbers-must-scale-and-admit-unknowns.md`) — it had simply not been applied to
  the history panel or the simulator. **A zero from an empty input is not a measurement.**

### BUG-013 — Two server crash paths from child-process events
- **Severity:** high (takes the whole dashboard down)
- **Discovered:** 2026-08-12 (code review)
- **Symptom:** none observed in the wild, but both are reachable in one click.
- **Root cause:** `discoverJobs[propId]` is deleted 5 seconds after a job reports `done`, while the
  child may still write to stderr; the stderr handler did `discoverJobs[propId].log.push(...)`
  outside any try/catch, so a late line threw `Cannot read properties of undefined` from an event
  handler — uncaught, process exits. The same shape existed for `scanAllJob`, which
  `/api/discover/scan-all/stop` sets to null while the child is still being SIGTERM'd.
- **Fix:** both handlers close over the job object and null-check; added `uncaughtException` and
  `unhandledRejection` guards so no future instance of this class kills the server silently.

### BUG-014 — CSV writers corrupted the sheet on a quoted name
- **Severity:** high (data loss in the source of truth)
- **Discovered:** 2026-08-12 (code review)
- **Symptom:** latent. A competitor whose Booking.com name contains a `"` would break its own row
  and every row after it, because the unbalanced quote leaves the parser in quoted state.
- **Root cause:** three endpoints (`/api/add-competitor`, `/api/discover/commit`,
  `/api/discover/add-manual-url`) had each grown their own CSV-append code. One wrapped the name in
  quotes without doubling embedded quotes (and had two identical ternary branches, so the
  "escaping" decision did nothing); one split on `\n` without stripping `\r`, mixing line endings on
  a file Excel writes as CRLF; all three re-joined an array whose last element was `''`, adding one
  blank line per call.
- **Fix:** one implementation — `csvCell()` (RFC-style quote doubling), `csvCompetitorRow()`,
  `readCsvLines()` (CR-stripping, trailing-blank-trimming) and `writeCsvLines()` (write-then-rename).
- **Class to avoid:** the same lesson as D-006 for *reading* the CSV, now applied to writing it.
  There is one parser and, from here, one writer.

### BUG-008 — Map pins showed "—" for properties that did have a rate
- **Severity:** medium
- **Discovered:** 2026-08-11 (reported by the user with a screenshot of the Discover map)
- **Symptom:** many pins on the map rendered a dimmed em dash instead of a price, including the
  own-property pin for properties 2, 3, 5 and 6.
- **Root cause:** the pin price came from `inferPrice(primaryRoom, today)`, which fails in three
  separate ways for this purpose:
  1. **`inferPrice()` returns null for a sold-out night *on purpose*** — its own comment explains
     that inferring a night-type median for an unbookable night once put fabricated rates into the
     comparison tables and the occupancy simulator. Correct there, wrong on a pin: a property that
     is merely **full tonight** still has a real rate later in the 30-night window. 10 of 62
     tracked competitors, and 4 of the 6 own properties, were dashed for exactly this reason.
  2. **Only the *primary* room was read**, so a sold-out primary would mask an available second
     room. No property hit this today, but it was one dataset away.
  3. **The Discover map used only `entry.price`**, the search-card price, which is absent for most
     candidates — so an entry we hold 30 nights of scraped rates for still showed a dash.
- **Fix:** added `mapPinPrice(entity, today, cardPrice)` — tonight's rate across **all** rooms,
  else the **next available night**, else the **search-card** price — returning the basis used.
  `inferPrice()` is untouched, so the analytics keep their deliberate nulls. Pin labels keep the
  existing `₹x,xxx` format; the basis is disclosed in the hover tooltip and the popup ("from
  19 Aug" / "search rate") so a later night is never presented as tonight's price. The
  cheaper/pricier colouring and the "vs yours" delta now apply **only** when both sides are
  tonight's rate — otherwise the pin would assert a comparison between two different dates.
- **Fourth cause, found by the verification itself — stale markers.** With the above fixed, one pin
  (`vintage_2bhk_…mangrove_views` on property 3) still showed a dash while its entry held ₹8,044.
  A pin's label is baked into its Leaflet **divIcon HTML at creation**, and Discover entries are
  merged from several sources in sequence (cached results → full market → rescan). A price arriving
  in a *later* pass than the one that created the marker was assigned to the entry and then
  silently ignored, because both merge sites only ever call `_discAddMarker` for entries that have
  no marker yet. Added `_discRebuildMarker()` (a divIcon's HTML cannot be mutated in place, so the
  marker is replaced) and called it from both sites when a price is filled in.
- **Also:** ran `fetch-discover-prices.js --nights=30 --only-missing` for all 6 properties, which
  is the purpose-built tool for the remaining gap — discovered candidates that were never
  price-scraped and whose search card carried no price. Card-price coverage went **38% → 78%**
  (81/212 → 165/212 candidates).
- **Verified:** all 6 properties in a real browser — **0 pins dashed despite a rate existing in
  any source**, 0 console/page errors, and 169 priced pins vs 46 dashed (was ~100 priced). A
  remaining dash now means genuinely no rate anywhere: sold out across the whole probe window.
- **Fixed:** 2026-08-11

### Note — the main "MAP VIEW" block is dead code
`renderMap()` (dashboard/index.html, the `MAP VIEW` section) is **never called**, and its DOM
targets (`#compMap`, `#mapCompList`, `#mapCompCount`) do not exist in the markup. The live map is
the Discover panel's (`_discMap2`). The block was updated alongside BUG-008 so it stays consistent
if reinstated, but **it renders nothing today**. Left in place deliberately: deleting ~380 lines of
a retired feature is not reversible in a project with no git history — confirm with the user first.

### BUG-007 — Unknown `/api/*` paths returned the dashboard HTML with a 200
- **Severity:** medium
- **Discovered:** 2026-08-11
- **Symptom:** `GET /api/nope` returned **644 KB of `text/html`** and status 200.
- **Root cause:** the static-file fallback in `serve.js` answered *any* unmatched GET, and it sat
  below every API route. A mistyped, renamed or retired endpoint therefore looked like a success
  to the client, which then `JSON.parse`d an HTML page and reported "Unexpected token <" from
  whichever panel happened to call it — with nothing pointing at the real cause.
- **Fix:** a JSON 404 for any unmatched path starting `/api/`, placed before the static fallback.
  Non-API paths still fall through to the dashboard, so deep links keep working.
- **Verified:** `/api/nope` and `/api/discover/typo` → 404 `application/json`; `/notapage` → 200 HTML.
- **Fixed:** 2026-08-11

### BUG-006 — The rate report refused to run, then asserted another property's findings
- **Severity:** high
- **Discovered:** 2026-08-11
- **Symptom:** `node build-price-report.js --property=1` exited 1 with *"No competitor rates
  available — run fetch-discover-prices.js first."* Forcing it past that produced a report
  containing **"Infinity×"**, a chart labelled **"own dorm +null% (p0)"**, the impossible
  **"ranked 3 of 2"**, and confident prose about *"the dorm"*, *"Craft Hostels"*, *"La GoYa at
  Anjuna Beachside"* and *"The Beachside Hostel"* — none of which relate to a Candolim villa.
- **Root cause:** two compounding issues.
  1. **The wrong price source gated everything.** The fatal check required `results[].price`, the
     price on a discovery search-result *card*. The coordinate search returns cards with no price
     (`price: null` for all 142 candidates), so the check always failed — while 30-night curves
     scraped by `refresh.js` for those same peers sat unused in `latest.dashboard.json`.
  2. **The report was bespoke to the property that used to be ID 1** (Backspace Anjuna Beach, a
     hostel). Competitor names, their rates (₹502 / ₹599 / ₹620), a "+87%" peak premium and a
     "no floor beneath the dorm" verdict were **hardcoded**, and the dorm/private two-product
     structure was assumed. Because Property IDs are reused between sheet revisions
     ([[booking-slug-is-identity]]), all of it was re-emitted for an unrelated villa. A villa has
     one room, so `mean(pS)/mean(dS)` divided by zero and null ADRs matched band 0 via `null >= 0`.
- **Fix:** lead-in rate falls back to the first available night of the scraped curve when the card
  carries no price, disclosed on the cover as "Lead-in source". Parity targets are now the cheapest
  priced competitors *above* the product's rate; floors, peak premiums and density verdicts are
  computed; the dorm track, its section and its chart series are gated on `hasDorm`; section
  numbers shift via `SN()`; rank is reported out of `rankTotal` (band + own property); null ADRs
  can no longer place a chart marker.
- **Verified:** all 6 reports rebuilt — 0 occurrences of `NaN`, `undefined`, `Infinity`, `null%`,
  `[object Object]`, any hardcoded hostel name, or `ranked N of M` with N > M.
- **Fixed:** 2026-08-11 · see `memory/report-was-bespoke-to-one-hostel.md`

### BUG-005 — `discover.js` City (text) search returns no properties
- **Severity:** low (was medium)
- **Discovered:** 2026-08-10 · **Closed:** 2026-08-11
- **Symptom:** every 2026-08-10 scan logged `City search complete: 0 properties`, so all results
  came from the lat/lng fallback.
- **Two wrong diagnoses, both recorded here so they aren't repeated:**
  1. *"Goa resolves to a region page, so the card selectors never match."* Wrong — `ss=Candolim`
     and `ss=Arpora` (city-level) also returned 0.
  2. *"Booking.com serves no cards for any `ss=` query from this client."* Also wrong — on
     2026-08-11 the identical Goa query returned **24 cards and 25 API interceptions**, taking
     property 2's pool from 22 to 95.
- **Actual behaviour:** the text search is **intermittent**, most likely bot-scoring / session
  state on Booking.com's side. Coordinate search is the dependable floor.
- **Resolution:** closed as *not a defect*. The existing design is correct — one cheap probe, fall
  back to the coordinate search, and report "text search unavailable" so a thin scan is never
  mistaken for a full-market sweep. **Consequence to remember: pool sizes are not comparable
  between scans.** See `memory/booking-text-search-is-flaky.md`.

### BUG-003 — `discovery-cache.json` was 253 MB and fully parsed by four scripts
- **Severity:** medium
- **Discovered:** 2026-08-10
- **Root cause:** the cache stored `allDiscovered` as an "explicit alias" holding the *same array*
  as `fullMarket`, so every candidate was serialised twice. It was byte-identical in all 6 entries
  and accounted for 21% of the file. On top of that, `results` is a re-ranked copy of the same
  pool, so each candidate was effectively stored three times.
- **Fix:** stopped writing `allDiscovered`; a scan now also deletes it from every *other* entry, so
  one scan shrinks the whole file. Both readers (the cumulative merge in `discover.js`,
  `/api/discover/status`) already fell back to `fullMarket`, which is now canonical — the alias is
  still *read* so pre-existing caches load. `fullMarket` was deliberately kept rather than derived
  from `results`, because `rankCandidates` filters by distance (property 2: 95 in `fullMarket`,
  92 in `results`).
- **Verified:** 377.6 KB → 265.8 KB (30%); a real `discover.js --property=2 --force` run confirmed
  the alias does not return and `fullMarket` still merges cumulatively.
- **Fixed:** 2026-08-11 · refs T-007

### BUG-002 — `meta.today` went stale on the per-property merge path
- **Severity:** low
- **Discovered:** 2026-08-10
- **Symptom:** `data/latest.dashboard.json` carried `meta.today: "2026-07-02"` while
  `meta.scrapedAt` was `2026-08-08`.
- **Root cause:** the `--property=` merge branch did `existing.meta = { ...existing.meta,
  scrapedAt: ... }`, deliberately preserving the old meta and bumping only `scrapedAt`, so `today`
  and `nights` never refreshed. The dashboard papered over it by using the browser clock, but
  `sync-sheets.js` and `build-price-report.js` both read `meta.today`.
- **Fix:** the merge takes the fresh run's meta wholesale.
- **Fixed:** 2026-08-11 · refs T-006

### BUG-001 — Booking.com share links could not be imported or scraped
- **Severity:** high
- **Discovered:** 2026-08-10
- **Root cause:** both `import-properties.js` and `refresh.js` extracted the slug with a regex that
  only matches canonical hotel URLs. A `booking.com/Share-xxxx` link is a redirect stub carrying
  no slug, so the row failed with *"Cannot parse Booking.com slug from …"* and could never receive
  price data.
- **Fix:** `resolve-property-coords.js` follows the redirect to recover the canonical URL and slug;
  `--write-csv` rewrites the sheet. As of 2026-08-11 a plain `import-properties.js` detects
  slug-less rows and delegates to `--links-only` automatically (T-005).
- **Status:** FIXED 2026-08-10 · refs D-005

### BUG-004 — Discover panel crashed on any property without coordinates
- **Severity:** high
- **Root cause:** `_discEnsureOwnMarker()` called `nominatimGeocode()` **without `await`** (its
  sibling `_discInitMap()` did await it). The returned Promise was truthy, so it was written into
  the sessionStorage coordinate cache, `JSON.stringify`-ed to `{}`, and later passed to
  `L.marker()` / `setView()`. `L.latLng()` returns **null** for malformed input instead of
  throwing, so the failure surfaced later from inside Leaflet as `Cannot read properties of null
  (reading 'lat')` with a useless stack. It stayed hidden while every property had coordinates in
  config, and appeared the moment properties existed without them.
- **Fix:** added the missing `await`; introduced `validCoords()`, `readCoordCache()`,
  `writeCoordCache()` and `coordsOf()` so reads drop malformed entries and writes refuse them;
  rejected `[0,0]` as missing data; bumped the cache key to `sv_mapCoords_v5`; a property without
  coordinates is listed but not plotted, with an explanatory note.
- **Verified:** real-browser run across all 6 properties — no crash banner, 0 console errors,
  0 uncaught page errors, own-property pin present on every property. Re-confirmed 2026-08-11 by
  `verify-dashboard.js`.
- **Fixed:** 2026-08-10 · **Refs:** D-005, T-012

### BUG-000 — Property dropdown showed 307 properties absent from the CSV, and would mislabel reused IDs
- **Severity:** high
- **Root cause:** two compounding issues. (1) `config/properties.json` is a derived cache that
  accumulates — `import-properties.js --property=<id>` preserves every other entry, so IDs deleted
  from the CSV survived in config and in `latest.dashboard.json` forever; the dropdown was built
  from that. (2) Property IDs are reused between sheet revisions, so filtering by ID alone would
  have shown old display names *and old prices* under new property names.
- **Fix:** added `GET /api/csv-properties` (live mtime-cached CSV parse returning id, Column B
  name, url and Booking slug). Rebuilt the selector to render from that list in sheet order, with
  Column B as the authoritative label and a slug-match guard in `syncPortfolioToCsv()` before any
  stored data is associated with a row. Empty sheet ⇒ empty dropdown. Client re-polls every 15 s.
- **Verified:** 737-row CSV → 737 options, 0 phantoms, 651 retaining price data (all slugs
  matched); 6-row CSV → exactly 6 options with Column B names, no old names or prices leaking;
  blank and competitor-only CSVs → 0 options.
- **Fixed:** 2026-08-10 · **Refs:** D-001, D-002, D-003, D-004, T-001
