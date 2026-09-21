# Decisions Log

> **Append-only.** Every meaningful technical/design decision, newest first. Never delete an
> entry — if a decision is reversed, add a *new* one that supersedes it. The **why** matters
> more than the what; it's what a future AI needs to avoid re-litigating settled choices.

### D-011 — Theme correctness is asserted on the tokens, not on the rendered page
- **Date:** 2026-08-13
- **Decision:** every colour in `dashboard/index.html` comes from a CSS custom property defined in
  **both** `:root` and `[data-theme="light"]` — including opaque overlay surfaces, which got four new
  tokens (`--popup-bg`, `--modal-bg`, `--overlay-veil`, `--chart-bg`) rather than a light-theme
  override per rule. `verify-dashboard.js` then checks contrast **at the token level**: every surface
  against `--text` (≥ 4.5:1) and `--text-muted` (≥ 3:1), translucent films composited over `--bg`
  first, for each theme.
- **Why tokens rather than `[data-theme="light"] .selector{}` overrides:** the light theme shipped
  with exactly three such overrides, and they covered only the surfaces that were obvious on screen.
  An override list is a list of the places someone *remembered*; a token is structural. The dark
  values were kept byte-identical to the literals they replaced, so adopting them cannot regress the
  dark theme — the diff is provably a no-op there.
- **Why the assertion is on tokens and not on rendered pixels:** this bug class is invisible to a
  rendering sweep. When the map popup was unreadable at 1.03:1 the DOM was perfect, the text was
  present and correct, and `verify-dashboard.js` reported **0 errors across 6 properties × 7 panels**
  — only the pixels were wrong. Worse, a Leaflet popup does not exist in the DOM until a pin is
  clicked, so no amount of panel-walking would have reached it. Checking the tokens tests the whole
  class at once, including surfaces that only appear on interaction.
- **Cost accepted:** this checks the *palette*, not every rendered pair, so it cannot catch a
  one-off inline `style="color:#333"` on a coloured badge. Judged the right trade: it is cheap,
  deterministic, has no false positives, and covers the failure that actually happened. Deliberate
  white-on-brand-colour text (map price pins on `#003580`, the purple folder button) is correctly
  out of scope, since neither colour comes from a theme.
- **Validated, not assumed:** the guard was proved non-vacuous by reinstating the `#1E2130` popup
  and confirming the suite failed with "theme light: --text on --popup-bg is 1.03:1 (needs 4.5:1)",
  then reverting. A check that has never been seen to fail is not yet a check.

### D-010 — Share the location's inventory, not its ranking; and union it on read
- **Date:** 2026-08-11
- **Decision:** properties in the same region share one discovered inventory — the union of
  everything any of them found. Each still ranks it by its **own** distances. The union is computed
  on read in `serve.js` and memoised against file mtimes; it is **not** written per property.
- **Why (sharing):** six properties 8 km apart in North Goa each kept a private pool, so each
  rediscovered the same market and each held a different view of it depending on whether its own scan
  caught the intermittent text-search stage — property 1 had 849 candidates and property 4 had 56, in
  the same week. Union gives 1,011 unique listings from 1,284, so 273 were pure duplication.
- **Why NOT sharing the ranking:** the properties are 8+ km apart across Candolim / Anjuna / Arpora /
  Saipem. A competitor next door to one is not a competitor to another. Sharing the inventory removes
  duplicate discovery; sharing a ranking would silently destroy the comparison the tool exists for.
- **Why on read:** `pool-market.js --dry-run` measured the alternative — writing each property its own
  rescoped copy takes `discovery-cache.json` from 2.3 MB to ~10 MB, because 1,011 listings get stored
  six times. That file is `JSON.parse`'d **whole** by four scripts plus every discovery endpoint,
  which is exactly the duplication BUG-003 was about. Even a 5 km radius nearly doubles it. On-read
  union costs one memoised pass per data change and zero storage.
- **Alternatives considered:** scan one representative per cluster and share the result (rejected — a
  coordinate search centred on Candolim does not enumerate Anjuna's neighbours, so this would lose
  coverage, not just duplication; every property still needs its own scan and the union is strictly
  better than any single one); identical tracked competitor lists for all six (offered to the user and
  declined, for the distance reason above).
- **Consequences:** pool key is `district, state` from the reverse-geocoded metadata, NOT Booking.com's
  `city`, which returns sub-localities (Marra, Vagator, Sinquerim, Arpora) and would split one market
  into four. `?scope=property` opts out. The Discover map now renders ~950 markers instead of ~60 —
  clustering copes but first paint is slower, and `verify-dashboard.js` needs >2 minutes for all six.
- **Status:** active
- **Supersedes / superseded by:** relates to BUG-003, T-015

### D-008 — Delisting requires page-level confirmation; absence from a scan is only a candidate
- **Date:** 2026-08-11
- **Decision:** a property is removed from the tracked inventory only after (a) it is absent from
  `MISS_THRESHOLD` consecutive scans **and** (b) a fetch of its own Booking.com page returns 404 or
  410. Every other outcome — 200, 3xx, 429, 5xx, network error — keeps the property, and an
  indeterminate verdict *decreases* its miss counter. Removal deactivates (`status:'delisted'`,
  unlinked) rather than deletes; `--purge` is opt-in.
- **Why:** `discover.js` searches a single night 7 days out, and Booking.com omits properties with
  no availability for the probed dates, so a fully-booked listing is absent for exactly the same
  reason a deleted one is. The text-search stage is also intermittent (D-005 era finding), swinging
  the pool by an order of magnitude. Measured: one scan of property 1 reported 12 of 24 absent and
  **all 12 were live** on direct probe. The page check separates the cases cleanly — a live listing
  returns 200 with a ~1.3 MB page even when sold out for all 30 nights; a removed one returns 404
  with 0 bytes.
- **Alternatives considered:** delist on first absence (rejected — would have dropped half of
  property 1's pool in a single run); delist after N absences with no confirmation (rejected — a
  property sold out for a fortnight would still be dropped, and 19 of 62 competitors are currently
  sold out across all 30 nights); require a human to approve every departure (rejected — the user
  asked for this to be automatic, and the page check makes it safe enough to be).
- **Consequences:** the errors are deliberately asymmetric. Keeping a dead listing one more day
  costs one wasted scrape; delisting a live competitor silently corrupts the market picture and
  loses history that can never be re-scraped, because rates are only observable forward. Cost is a
  handful of page fetches per run, only for candidates. `--miss-threshold=1` is the way to exercise
  the path on real data; a large "false alarm(s) kept" count is the system working.
- **Status:** active
- **Supersedes / superseded by:** n/a

### D-009 — The inventory holds everything; the tracked set stays the size the user chose
- **Date:** 2026-08-11
- **Decision:** the discovery cache is the inventory and always absorbs every new listing.
  `config.competitors[]` — the set that actually gets priced — is filled only up to a target, which
  defaults to **each property's current linked count**. Departures are backfilled from the ranked
  pool; the number left unlinked is reported every run.
- **Why:** the user asked for new listings to be added automatically, but every linked competitor
  costs 30 nights of scraping per refresh and `refresh.js` only scrapes what is linked. A scan can
  swing a pool from 24 to 847 (property 1 did exactly that), so "link everything new" would silently
  turn a 4-minute refresh into an hours-long one and change the cost profile without anyone
  deciding to. Keeping the target at the chosen size satisfies the request — the inventory *is*
  current, churn *is* replaced — while leaving the coverage question (T-015) an explicit choice via
  `--target`.
- **Alternatives considered:** link every new arrival (rejected as above); link nothing
  automatically and only report (rejected — the user explicitly asked for automatic addition).
- **Consequences:** after a big scan the run prints e.g. "771 further candidate(s) available — raise
  --target to track them", which is the prompt to make that decision deliberately.
- **Status:** active
- **Supersedes / superseded by:** relates to T-015

### D-006 — One CSV parser in lib/, pinned by tests; the import keeps its own row layer
- **Date:** 2026-08-11
- **Decision:** all four scripts that read `properties.csv` (`serve.js`, `import-properties.js`,
  `prune-to-csv.js`, `resolve-property-coords.js`) go through `lib/csv-properties.js`, and
  `test/csv-properties.test.js` pins the contract. `import-properties.js` keeps its own row-object
  view and multi-unit grouping on top of the shared primitives rather than adopting
  `readProperties()` wholesale.
- **Why:** four copies had already drifted. The import's slug regex was `[^.?/]+` where the others
  used `[^.?/#]+`, so a `#fragment` leaked into the slug and no stored record could match it again
  — the same failure mode as BUG-001. It also preferred the legacy `Stayvista Property` column for
  display names while the dropdown preferred `Property`, so on a sheet carrying both, the importer
  and the UI would label the same row differently. That is BUG-000's class of bug. The import keeps
  its own layer because `readProperties()` collapses repeated Property IDs to one row **by design**,
  whereas the import must see every unit row to derive a shared base name via `pickBaseName()` —
  forcing it onto the collapsed view would have destroyed working logic.
- **Alternatives considered:** rewriting the import's 3-pass grouping onto `readProperties()`
  (rejected — high risk to proven multi-unit logic for no gain, since the drift risk lives in the
  primitives, not the grouping); leaving the copies with a warning comment (rejected — they had
  already diverged silently, which is exactly what a comment does not prevent).
- **Consequences:** the contract now has one implementation and 24 tests (`npm test`). Writing
  those tests immediately surfaced a real defect: `parseCSVLine` flipped an in-quote flag on every
  `"` and so could not read the escaped-quote form (`""`) that `formatCSVLine` writes, making a
  read-modify-write of the sheet lossy for any name containing a double quote — which is precisely
  what `resolve-property-coords.js --write-csv` does. Now follows RFC 4180.
- **Status:** active
- **Supersedes / superseded by:** closes the consequence noted under D-001; n/a

### D-007 — Report claims must be computed, never asserted
- **Date:** 2026-08-11
- **Decision:** `build-price-report.js` may not contain a literal competitor name, rate or
  percentage. Every sentence naming a competitor or stating a number derives from `priced` /
  `PRIMARY` / `maxPremium()`, and a section that depends on a product the property does not sell is
  omitted rather than rendered empty.
- **Why:** the report was written for the hostel that used to be Property ID 1 and, because IDs are
  reused between sheet revisions (D-003), kept emitting that hostel's competitors — "Craft Hostels"
  at ₹599, "La GoYa at Anjuna Beachside" at ₹620, "The Beachside Hostel" at ₹502 — plus a hardcoded
  "+87%" peak premium and an unconditional "this property is not pricing flat", all for an
  unrelated Candolim villa. This is a document someone prices against; confidently wrong prose is
  worse than a missing section.
- **Alternatives considered:** failing fast when the property does not match the report's
  assumptions (rejected — the data supports a genuine report, so refusing would be giving up on
  work that can be done); a full rewrite into a generic generator (rejected as out of scope — the
  fabrications were localised, and the underlying analysis is sound once its inputs are honest).
- **Consequences:** the lead-in rate now falls back to the first available night of the scraped
  curve when the discovery card carries no price, and that basis is disclosed on the cover
  ("Lead-in source: N from search cards, M from scraped curves") so the reader is never misled
  about provenance. Verify any change by building all six properties and grepping the HTML for
  `NaN`, `Infinity`, `null%`, `undefined` and `ranked N of M` where N > M.
- **Status:** active
- **Supersedes / superseded by:** depends on D-003; n/a

### D-005 - Resolve share links by redirect; take coordinates from the Booking.com page
- **Date:** 2026-08-10
- **Decision:** `resolve-property-coords.js` follows a share link's redirects to recover the canonical
  `/hotel/in/<slug>` URL, then loads that page in Chrome and reads lat/lng from its JSON-LD `geo`
  block. `--write-csv` rewrites the sheet's links to the canonical form.
- **Why:** One redirect-follow unblocks import, scraping *and* the slug identity check at once.
  Coordinates then come from the listing itself rather than a Nominatim guess on a name like
  "Studio 109 Apartment by tisyastays", which would be unreliable. Canonicalising the sheet is not
  cosmetic: the D-003 identity guard cannot confirm a slug-less row, so it replaced each property with
  a coordinate-less stub and the own-property map pin never rendered.
- **Alternatives considered:** Nominatim geocoding by name (rejected - inaccurate for apartment units
  inside shared buildings); asking the user to paste canonical URLs by hand (rejected - the redirect
  makes it unnecessary); a bare `fetch` of the property page (impossible - Booking.com returns a ~4 KB
  HTTP 202 bot-check stub with no coordinates, so a real browser is required).
- **Consequences:** Adds a network+browser step after any sheet change that introduces share links.
  Whether this folds into `import-properties.js` is still open (T-005).
- **Status:** active
- **Supersedes / superseded by:** depends on D-003; n/a

---

### D-004 — `properties.csv` is the source of truth for DATA, not just display
- **Date:** 2026-08-10
- **Decision:** Purge every property, record and reference not present in the sheet from all
  data files, via a repeatable `prune-to-csv.js` script. Removed 12,239 records: 1,038 own +
  5,423 competitor config entries, 1,038 portfolio + 28 competitor dashboard entries, 1,044
  discovery scans, 1,252 history portfolio entries across 8 snapshots, 1,046 metadata records,
  1,368 cached coordinates, 2 folder sets.
- **Why:** Filtering only the dropdown left the underlying data intact, so stale records were
  still reachable through other endpoints, the Sheets sync, and reports. The user required the
  sheet to be the single source of truth for what the system *contains*, not merely what it shows.
- **Alternatives considered:** (a) Display-only filtering — rejected, leaves stale data live in
  every other consumer. (b) A full `import-properties.js` run — rejected, it rebuilds config but
  touches none of `discovery-cache`, `history`, `property-meta`, `geo-cache` or `discovery-folders`,
  and it cannot even parse the current share links.
- **Consequences:** `discovery-cache.json` went 253 MB → 2 bytes, which also neutralises BUG-003
  for now. All history price series are gone from the live tree (preserved in the backup). The
  script is re-runnable after any sheet change. A timestamped backup is written by default.
- **Status:** active
- **Supersedes / superseded by:** builds on D-001; n/a

---

### D-003 — Column B is the authoritative label; data carries over only on a slug match
- **Date:** 2026-08-10
- **Decision:** The dropdown label always comes from the CSV's `Property` column (Column B).
  Config/pricing data is only associated with a CSV row when the row's Booking.com slug matches
  the stored entry's slug; otherwise the row is treated as a brand-new property with no data.
- **Why:** Property IDs are **reused** across sheet revisions. The new sheet numbers its rows 1–6,
  colliding with old IDs 1 (`Backspace Anjuna Beach`) and 5 (`The Boulevard Villa`). Without this,
  the dashboard showed the old names, and worse, the *old prices*, under the new property names —
  silently wrong data, which is more dangerous than missing data.
- **Alternatives considered:** Trust the ID (rejected — demonstrably wrong here); require a manual
  mapping table (rejected — the slug already encodes identity for free).
- **Consequences:** A sheet row whose link yields no slug (share links, blank cells) can never
  confirm identity and so always starts empty. Implemented in `syncPortfolioToCsv()` in
  `dashboard/index.html` and in `prune-to-csv.js`.
- **Status:** active
- **Supersedes / superseded by:** n/a

---

### D-002 — An empty CSV means zero properties, not "unknown"
- **Date:** 2026-08-10
- **Decision:** Clearing `properties.csv` blanks the dropdown. Only an unreachable server or a
  malformed reply falls back to showing the configured list. Tracked with an explicit
  `CSV_LOADED` flag rather than inferring intent from set size.
- **Why:** The first implementation treated an empty list as "unknown" and failed open, so an
  emptied sheet showed all 1,044 configured properties — the opposite of what the operator meant.
  The user explicitly required a blank sheet to produce a blank dropdown.
- **Alternatives considered:** Fail open on empty (rejected — contradicts the requirement); always
  fail closed including on network errors (rejected — a transient outage would blank the UI with
  no explanation).
- **Consequences:** The selector renders a disabled `No properties in properties.csv` placeholder
  and clears `state.selectedPropId` when the sheet is empty.
- **Status:** active
- **Supersedes / superseded by:** n/a

---

### D-001 — `properties.csv` drives the dashboard property list, not `config/properties.json`
- **Date:** 2026-08-10
- **Decision:** Added `GET /api/csv-properties` to `serve.js` — a live, mtime-cached parse of
  `properties.csv` returning `{ id, name, url, slug }` per row — and rebuilt the dashboard's
  property selector on top of it. The client polls it every 15 s so sheet edits appear without a
  reload.
- **Why:** `config/properties.json` is a *derived cache that accumulates*. `import-properties.js
  --property=<id>` preserves every other entry by design, so IDs removed from the CSV survive in
  config and in `latest.dashboard.json` indefinitely. The dropdown was listing 307 such phantom
  properties.
- **Alternatives considered:** (a) Re-run a full import to prune config — helps config but doesn't
  fix `latest.dashboard.json`, and needs a manual step every time the sheet changes. (b) Filter
  client-side against `/api/config` — impossible, config is exactly the polluted source.
- **Consequences:** The CSV becomes a hard runtime dependency of the dashboard. `serve.js` now
  duplicates the CSV parser and the UTF-8→Windows-1252 fallback from `import-properties.js`; if
  the CSV contract changes, both must change.
- **Status:** active
- **Supersedes / superseded by:** extended by D-004

---

<!-- Template — copy above this line for each new decision -->
