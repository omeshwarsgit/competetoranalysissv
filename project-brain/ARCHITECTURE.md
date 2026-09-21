# Architecture

> How the system is built. Update when structure, stack, or dependencies change.

## Stack

- **Language(s):** JavaScript, Node.js ≥18, CommonJS (`'use strict'`, no build step, no transpile)
- **Framework(s):** none. Raw `http` server; the dashboard is one hand-written HTML file.
- **Data store:** JSON files on disk under `data/` and `config/`. No database.
- **Infra / hosting:** none — runs locally on Windows. Windows Task Scheduler for automation.

## High-level shape

A four-stage batch pipeline where each stage's output file is the next stage's input.
`properties.csv` is the human-maintained source of truth; everything else is derived.

```
properties.csv                         ← operator edits this (Excel)
    │  node import-properties.js
    ▼
config/properties.json                 ← own properties + competitor links
    │  node discover.js --property=<id>        (auto-invoked by import)
    ▼
data/discovery-cache.json              ← cumulative Booking.com market per property
    │  node refresh.js
    ▼
data/latest.dashboard.json  +  data/history/<date>.dashboard.json
    │
    ├──▶ node serve.js               → dashboard on :3000  (+ /api/*, SSE)
    ├──▶ node sync-sheets.js         → Google Sheet
    └──▶ node build-price-report.js  → reports/*.html + *.pdf
```

`serve.js` is also the orchestrator: the dashboard's buttons `spawn()` the other scripts as child
processes and stream their stdout back to the browser over Server-Sent Events.

## Entry points

- `serve.js` — HTTP server + dashboard (port 3000, `PORT` env to override)
- `refresh.js` — price scraper
- `import-properties.js` — CSV → config
- `discover.js` — per-property market scan
- `discover-all.js` / `scheduled-scan.js` — batch discovery wrappers
- `open-dashboard.vbs` — desktop launcher (starts `serve.js` if `:3000` is free, else just opens it)

## Key modules

| Module | Path | Purpose |
|--------|------|---------|
| Price scraper | `refresh.js` | Playwright harvests logged-in Booking.com cookies, then **raw `fetch()` at 80-way concurrency** scrapes 30 nights × property × room. Adaptive throttle: on repeated 429/202 it cuts concurrency 30% (floor 15). Prices parsed from the `b_rooms_available_and_soldout` JSON blob via a hand-written brace matcher. |
| CSV importer | `import-properties.js` | 3-pass CSV parse (group own rows by ID → collapse multi-unit rows → attach orphan competitor rows). Merges with existing config, preserves enriched fields, write-then-rename, auto-backup, dangling-reference report. |
| Market discovery | `discover.js` | City-name search + lat/lng search on Booking.com, full pagination, **intercepts the internal JSON API** for exact coordinates (DOM cards as fallback). Cumulative save — never loses a previously seen property. Self-corrects own coords when it finds itself in results. |
| HTTP server | `serve.js` | ~30 JSON endpoints, mtime-keyed in-memory JSON cache, gzip over 2 KB, two SSE channels (refresh, scan-all), optional `API_KEY` auth, spawns child processes. |
| Relevance scoring | `lib/discovery-engine.js` | Weighted 8-factor competitor score (0–100) + hard rejection rules. Type-compatibility matrix (villa↔hotel etc.). |
| Sheets payload | `lib/pricing-rows.js` | Single source of truth for sheet column order, row building, summary stats, and the SHA-256 change hash. Both transports import it so they cannot drift. |
| Sheets transports | `lib/sheets-appscript.js`, `lib/sheets-service-account.js`, `lib/google-sheets.js` | Apps Script Web App (default) or service-account JWT. Zero-dependency Sheets v4 client. |
| Chrome control | `lib/chrome.js` | Cross-platform Chrome/Edge discovery, CDP launch on 9222, temp profile so the user's own Chrome is untouched. Headless **except** `refresh.js`, which needs a visible login window. |
| Holidays | `lib/holidays.js` | Fixed + lunar Indian holidays 2025–2028, long-weekend derivation. Drives "night type" (Weekday / Fri / Sat / Sun / Long weekend). |
| Geocoding | `lib/geocode.js` | Nominatim at 1 req/s with a persistent `data/geo-cache.json`, plus haversine distance. |
| Dashboard | `dashboard/index.html` | 7,300-line single-file SPA. Panels: Overview, Daily Calendar, Long Weekends, Analysis, Suggestions, Discover (Leaflet map), History. |
| Report builder | `build-price-report.js` | Rates-only analysis with hand-written SVG charts → HTML, then PDF via headless Chrome. Measures against the **discovery market**, not the curated competitor list. |

## Data model

Core entities, all keyed by **Property ID** (a StayVista system ID from the CSV):

- **Own property** — `{ id, slug, type:'own', display, location, city, propertyType, beds, pax, competitors[], lat, lng, units[] }`
- **Competitor** — same shape with `type:'comp'`; referenced by ID from an own property's `competitors[]`
- **Room** — `{ name, pax, bed, deal, primary, inv, observed: { 'YYYY-MM-DD': price } }`
- **Discovery entry** (per own property) — `{ fetchedAt, city, ownCoords, results[], fullMarket[], allDiscovered[], newSince[], selected[], scanCount, firstScanAt }`

**Identity caveat:** Property IDs are *reused* across CSV revisions. The **Booking.com slug** is the
only stable identity for a listing. Anything that carries data forward across a CSV change must
compare slugs, not IDs.

### The CSV contract

| Column | On a row **with** a Property ID | On a row **without** one |
|---|---|---|
| `Property ID` | StayVista system ID | blank |
| `Property` | your property's display name | blank |
| `Booking.com Link` | your property's Booking.com URL | blank |
| `Location` | city/area used as the search term | **the competitor's name** |
| `Competitor Link` | — | the competitor's Booking.com URL |

So `,,,Craft Hostels,https://…` is a manual competitor attached to whichever numbered property
appears above it. One config entry per Property ID; repeated IDs are sellable units of one listing
and collapse to a shared base name (unit names kept on `units[]`).

## External integrations

- **Booking.com** — scraped, not an API. Property pages for prices; search pages + intercepted
  internal JSON for discovery. Requires logged-in cookies.
- **Nominatim (OpenStreetMap)** — geocoding fallback, 1 req/s, cached.
- **Google Sheets** — via a bound Apps Script Web App (shared-secret auth) or a service-account JWT.
- **Leaflet + OpenStreetMap tiles** — the Discover map in the dashboard.

## Dependencies

| Package | Version | Why it's here |
|---------|---------|---------------|
| `playwright` | ^1.45.0 | Drive Chrome over CDP for cookie harvesting and search-page scraping; also renders report PDFs. The **only** dependency. |

## Architectural conventions

- **`properties.csv` is authoritative; `config/properties.json` is a derived cache.** Config
  accumulates and must be reconciled against the CSV (see `D-001`).
- **Playwright only for what needs a browser.** Cookies and JS-rendered search pages use the
  browser; the high-volume price path is raw `fetch()`.
- **Write-then-rename** for config writes, so an interrupted run can't truncate.
- **Cumulative discovery** — a property once discovered is never dropped from the cache.
- **Non-destructive Sheets sync** — keyed upsert, never deletes rows, so history survives.
- **Encoding defence** — every CSV read tries strict UTF-8, then Windows-1252.
- **ID validation on every endpoint** — `/^[a-z0-9_]{1,100}$/` before touching the filesystem.
- Section headers use `// ── Title ────` banners throughout.

## Evolution log

> How the architecture changed over time (newest first). Big shifts only.

- **2026-08-10** — `properties.csv` promoted to the authoritative property list for the UI. Added
  `GET /api/csv-properties` (live, mtime-cached parse returning id / Column B name / url / slug) and
  rebuilt the dashboard selector on top of it with a slug-based identity guard. See `D-001`–`D-003`.
- **2026-08-08** — Google Sheets sync reworked: `daily-grid` mode added alongside `detailed`, both
  fed by `lib/pricing-rows.js`; Apps Script became the default transport.
- **2026-08-05** — `data/latest.csv` export removed (written but never read); the dashboard reads
  `latest.dashboard.json` and pricing goes to Google Sheets instead.
- **2026-05-28** — Single-dimension distance+rating relevance replaced by the weighted 8-factor
  `lib/discovery-engine.js`.
- **2026-05** — Hardcoded `SLUGS`/`META` constants in `refresh.js` replaced by
  `config/properties.json` generated from the CSV.
