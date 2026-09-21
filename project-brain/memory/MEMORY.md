# Memory Index — competitor-pricing-monitor

> Project-scoped memory. Load ONLY when working in this project. Never read another project's
> memory, and never copy anything from here into the global store.
>
> Each memory is one file in this folder with frontmatter:
> `name`, `description`, `metadata.type` (user | feedback | project | reference).
> Add a one-line pointer here per memory: `- [Title](file.md) — hook`.

- [CSV is the single source of truth](csv-single-source-of-truth.md) — `config/properties.json` only ever accumulates; always reconcile against `properties.csv`
- [Booking slug is the real identity](booking-slug-is-identity.md) — Property IDs get reused between sheet revisions; only the slug identifies a listing
- [CSV column contract](csv-column-contract.md) — the `Location` column means two different things depending on whether the row has a Property ID
- [One CSV parser, locked by tests](one-csv-parser-with-tests.md) — all four scripts read the sheet through `lib/csv-properties.js`; `npm test` pins the quirks. Never re-implement it
- [Share links: no slug, but resolvable](share-links-break-pipeline.md) — `booking.com/Share-xxxx` blocks import/scrape, but a redirect-follow recovers the real hotel URL
- [Booking text search is flaky, not broken](booking-text-search-is-flaky.md) — the `ss=` City stage returned 0 one day and 24 the next; coordinate search is the dependable floor, so pool sizes aren't comparable between scans
- [Absence from a scan is NOT delisted](absence-from-search-is-not-delisted.md) — the scan probes one night, so a sold-out property vanishes like a deleted one; 12 of 24 "missing" were all live. Only a 404 on the property page delists
- [Config writes race with no locking](config-writes-race-no-locking.md) — five things read-modify-write `config/properties.json`; guarded now via `lib/json-store.js`, and `/api/reset-competitors` is audited to `data/config-audit.json` after it destroyed data twice
- [Shared location market, unioned on read](shared-location-market-at-read-time.md) — all North Goa properties see one 1,011-listing inventory; computed in `serve.js`, never stored per property (that would take the cache 2.3 MB → 10 MB)
- [Analysis numbers must scale and admit unknowns](analysis-numbers-must-scale-and-admit-unknowns.md) — fixed ₹ thresholds break across a 6x ADR spread, and `Math.round(null*100)` renders unknowns as a confident 0
- [Estimated prices for sold-out nights](estimated-prices-for-sold-out-nights.md) — sold-out dates are filled with the property own average available rate and marked; averages unaffected, but trend/premium/volatility are flattened by construction so measured figures show alongside
- [The report was bespoke to one hostel](report-was-bespoke-to-one-hostel.md) — `build-price-report.js` hardcoded a former ID 1's competitors, rates and premiums and asserted them for any property
- [Map pins need their own price rule](map-pins-need-their-own-price-rule.md) — pins use `mapPinPrice()` (tonight → next available → card), never `inferPrice()`, whose null-on-sold-out is right for analytics and wrong for a pin. Also: the `MAP VIEW` block is dead code
- [Dashboard is token-themed (dark + light)](dashboard-is-token-themed.md) — a hardcoded surface colour is a bug: four of them rendered map popups and the confirm modal at 1.03:1 in light theme. Contrast is asserted on the tokens, because a render sweep cannot see it
- [Leaflet's null latLng trap](leaflet-null-latlng-trap.md) — a bad coordinate becomes a null latLng and throws "reading 'lat'" from inside the library
- [Excel locks properties.csv](excel-locks-properties-csv.md) — writes from Node fail with EBUSY while the sheet is open
- [Playwright only for cookies](playwright-only-for-cookies.md) — the hot scrape path is raw fetch(); the browser exists to obtain a logged-in session
- [Sheets secret layout is correct](sheets-secret-layout.md) — don't "fix" it; the real secret is already confined to gitignored files
- [User wants strict CSV scoping](user-wants-strict-csv-scoping.md) — repeatedly asked for the sheet to govern both display and stored data
