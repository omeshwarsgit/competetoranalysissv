# Roadmap

> The forward view: milestones, sequencing, and the recommended next steps. Update as priorities shift.

## Milestones

| Milestone | Goal | Target | Status |
|-----------|------|--------|--------|
| M1 | Working scrape → dashboard pipeline for a portfolio | — | ✅ done |
| M2 | Competitor discovery with multi-factor relevance scoring | — | ✅ done |
| M3 | Google Sheets sync + PDF rate reports | — | ✅ done |
| M4 | `properties.csv` as the single source of truth (display **and** data) | 2026-08-10 | ✅ done |
| M5 | New 6-property Goa set fully priced end-to-end | — | 🔵 in progress — blocked on BUG-001 |
| M6 | Reliable daily automation (scrape as well as discovery) | — | ⬜ not started |
| M7 | Scale hygiene — cache size, single CSV parser, competitor `beds` | — | ⬜ not started |

## Next recommended steps (short horizon)

1. **Get full Booking.com hotel URLs for the 6 properties** (T-002). Share links carry no slug, so
   the importer rejects them and the scraper can't build a URL. Either paste canonical
   `/hotel/in/<slug>.html` URLs into the sheet, or implement T-005.
2. **`node import-properties.js`** (T-003) — a full import populates slug, city, coordinates and
   discovers competitors for the 6.
3. **`node refresh.js`** (T-004) — scrape 30 nights and confirm the dashboard populates.
4. **Update `config/sheets.json`** (T-008) — it still scopes the sync to `"properties": ["1"]`,
   which now refers to a different property than when it was set.
5. **Add a scheduled price scrape** (T-009) — only discovery is scheduled today.

## Later / stretch

- Per-property discovery cache files so the 253 MB monolith can't come back (T-007)
- Extract `lib/csv-properties.js` so `serve.js` and `import-properties.js` share one CSV parser (T-010)
- Populate competitor `beds` during discovery so the capacity factor actually discriminates
- Extend the forward window beyond 30 nights
- Rate-move alerting

## Deferred / parked

- **A second OTA source** — deliberately parked; Booking.com alone is enough signal for now and each
  new source multiplies the scraping-fragility surface.
- **Automatic repricing** — out of scope by design; the system recommends, humans decide.
- **Cloud deployment** — parked; the tool needs a logged-in browser session and one operator, so
  local is the right shape.
- **Ratings/reviews/quality analysis in the report** — deliberately excluded to keep the report
  strictly about rates.

## Timeline (chronological)

- **2026-05** — Initial build: hardcoded property constants, basic scrape + dashboard
- **2026-05-28** — Relevance scoring replaced by the weighted 8-factor discovery engine
- **2026-06–07** — Discover tab, Leaflet map, cumulative market cache, history snapshots
- **2026-08-05** — `data/latest.csv` retired; dashboard reads `latest.dashboard.json`
- **2026-08-06–08** — Google Sheets sync (Apps Script transport, daily-grid mode); PDF reports
- **2026-08-10** — Project Brain created. `properties.csv` promoted to single source of truth for
  display and data; 12,239 stale records purged; portfolio re-pointed at 6 Goa properties
- **Next** — resolve the share-link blocker, then price the new set end-to-end
