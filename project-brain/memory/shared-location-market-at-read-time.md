---
name: shared-location-market-at-read-time
description: Properties in one region share the discovered inventory, unioned on READ in serve.js — never stored per property, which would 4x the cache
metadata:
  type: project
---

All six properties sit in North Goa but each kept a **private** candidate pool, so each rediscovered
the same market and each ended up with a different view of it depending on whether its own scan
caught the intermittent text-search stage. In the same week, property 1 held **849** candidates and
property 4 held **56** — one market, two pictures.

They now share one inventory: the union of everything any property in the region discovered
(**1,011** unique listings from 1,284 across the cluster, so 273 were duplicates).

## The important implementation choice: union on read, not on write

`pool-market.js` can write each property its own rescoped copy, and the dry-run shows why that is
the wrong default: the cache goes from **2.3 MB to ~10 MB**, because 1,011 shared listings get
stored six times. `data/discovery-cache.json` is `JSON.parse`'d **whole** by four scripts plus every
discovery endpoint — this is precisely the duplication BUG-003 was about. Even a 5 km radius nearly
doubles it.

So the union happens in `serve.js` (`sharedMarketFor`), memoised against the mtimes of the discovery
cache and config, and is served by `/api/discover/full-market` and `/api/discover/status`. Storage
growth: **zero**. `?scope=property` opts back out to a single property's own scan.

## What is shared and what is deliberately not

Shared: the **inventory** (which listings exist in this location).
Not shared: the **ranking**. `rescopeForProperty` recomputes `distance` from each property's own
coordinates, because the properties are 8+ km apart (Candolim / Anjuna / Arpora / Saipem) and a
competitor next door to one is not a competitor to another. Sharing the inventory removes duplicate
discovery; sharing a ranking would quietly destroy the comparison.

## What pooling does NOT do

It does not make one scan sufficient. A coordinate search centred on Candolim will not enumerate
Anjuna's neighbours, so **every property still needs its own scan** — the union is strictly better
coverage than any single scan. What pooling removes is the inconsistency between them, not the
scanning.

## Pool key

`district, state` from the reverse-geocoded `data/property-meta.json` ("north goa, goa"). NOT
Booking.com's `city`, which returns sub-localities — Marra, Vagator, Sinquerim, Arpora — and would
split one market into four. Falls back to proximity clustering (25 km) when no region is known.

**Cost to be aware of:** the Discover map now renders ~950 markers instead of ~60. Clustering copes,
but first paint is slower and `verify-dashboard.js` needs longer than 2 minutes for all six.

Related: [[booking-text-search-is-flaky]], [[absence-from-search-is-not-delisted]].
