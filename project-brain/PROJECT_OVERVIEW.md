# Project Overview

> The stable "why" of the project. Rarely changes. Set once, revisit only on a pivot.

## Objective

Give StayVista's revenue team a daily, evidence-based answer to *"are we priced right?"* — by
scraping Booking.com for each StayVista property and its real nearby competitors, then showing
30 nights of forward rates side by side.

## Problem it solves

StayVista rents villas and homestays across India. Competitor rates on Booking.com change daily,
and checking them by hand for hundreds of properties is impossible — so pricing decisions get made
blind. This automates the rate shop: it finds who the competitors actually *are* (not who someone
guessed), tracks their rates for the next 30 nights, and flags where StayVista sits above or below
its market.

## Success criteria

- For any tracked property, see its own rates against its competitors' for the next 30 nights
- Competitors are *comparable* — similar property type, capacity, price tier and location, not just
  "geographically near"
- Rates refresh without manual scraping work
- Sold-out nights are visible as sold out, never as missing data
- Output is usable by non-technical staff (a dashboard, a Google Sheet, a PDF)
- The property list is controlled by editing one spreadsheet

## Scope

**In scope:** Booking.com rate scraping; competitor discovery and relevance scoring; a local
dashboard; Google Sheets sync; PDF/HTML rate reports; long-weekend and night-type awareness for
Indian holidays; daily automation via Windows Task Scheduler.

**Out of scope:** other OTAs (Airbnb, Agoda, MakeMyTrip); automatic price *changes* — the system
recommends, humans decide; ratings/reviews/quality analysis (the report is deliberately
rates-only); any cloud deployment or multi-user auth beyond a single optional API key; a database.

## Users / stakeholders

StayVista's revenue / pricing team. Operated locally by one person on Windows — the same person
maintains `properties.csv`. Consumers of the output include anyone with access to the shared
Google Sheet.

## Constraints

- **Booking.com has no public pricing API** — everything is scraping, so it is inherently fragile
  and must be defensive (retries, adaptive throttling, sold-out detection)
- **Requires a logged-in Booking.com session**, so `refresh.js` needs a *visible* Chrome window
- Windows-only in practice (`.bat` / `.vbs` helpers, Task Scheduler, hardcoded Chrome paths in
  `fetch-meta.js`)
- Node ≥18 (uses global `fetch`), single dependency (Playwright), no build step
- Nominatim geocoding is rate-limited to ~1 req/s, so geocoding is capped and cached
- No database — everything is JSON on disk, which is why file size and accumulation matter

## Key assumptions

- A human keeps `properties.csv` correct; it is the contract between operator and system
- Booking.com's embedded `b_rooms_available_and_soldout` JSON blob stays stable
- The **Booking.com slug** is the durable identity of a listing; Property IDs are *not* (they get
  reused across sheet revisions)
- One operator, one machine — no concurrent writers to the JSON files

## Glossary

| Term | Meaning |
|---|---|
| **Own property** | A StayVista property being tracked (`type: 'own'` in config) |
| **Competitor / comp** | A Booking.com property tracked as a comparator (`type: 'comp'`) |
| **Property ID** | StayVista's internal system ID, column A of the CSV. **Reused across sheet revisions** |
| **Slug** | The Booking.com URL identifier, e.g. `stayvista-at-cedar-haven`. The real identity of a listing |
| **Lead-in rate** | The cheapest bookable room for a given night — the property's headline price |
| **Night type** | Weekday / Friday / Saturday / Sunday / Long weekend, used to compare like with like |
| **Discovery / market scan** | `discover.js` sweeping Booking.com for candidate competitors |
| **Full market** | Every property discovery has *ever* seen for a property (cumulative, never pruned) |
| **Relevance score** | 0–100 weighted competitor-fit score; ≥65 `high`, ≥45 `medium` confidence |
| **Unit** | A separately sellable part of one listing (`Amber @ Golden Triangle`); units collapse to one entry |
| **ADR** | Average Daily Rate |
