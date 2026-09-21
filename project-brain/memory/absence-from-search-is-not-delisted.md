---
name: absence-from-search-is-not-delisted
description: A property missing from a discovery scan is usually just sold out for the probed night — never delist without confirming against its own page (404 vs 200)
metadata:
  type: project
---

The single most important rule in the inventory system. **Absence from a discovery scan says almost
nothing about whether a listing still exists.**

`discover.js` searches Booking.com for **one night, 7 days out**. Booking.com omits properties with
no availability for the probed dates, so a fully-booked property disappears from the results for
exactly the same reason a deleted one does. Layered on top, the `ss=` text-search stage is
intermittent ([[booking-text-search-is-flaky]]), which swings the candidate pool by an order of
magnitude between runs.

Measured on 2026-08-11, property 1: a single scan took the pool from 24 to 847 candidates and
reported **12 of the original 24 as absent**. All 12 were then probed directly — **every one
returned HTTP 200 and was live**, including tracked competitors `kingsgate`, `Wildflower Goa` and
`Beautiful Studio apartment near Candolim Beach`. A naive "absent ⇒ delisted" rule would have
dropped half the pool in one run and destroyed their price history.

**The confirmation test that does work** — fetch the property's own page:

| case | response |
|---|---|
| live listing, even sold out all 30 nights | HTTP **200**, ~1.3 MB, Hotel JSON-LD present |
| removed listing | HTTP **404**, 0 bytes |
| merged / renamed | **3xx** with a `Location` — still exists, new slug |
| throttled / bad moment | 429, 202, 5xx, network error |

So the pipeline is: absence increments `missedScans` → at `MISS_THRESHOLD` (3) it becomes a
*candidate* → `sync-inventory.js` probes the page → only an explicit 404/410 delists. Everything
ambiguous **keeps** the property, and `applyVerdict` actively decays the miss counter on an
indeterminate verdict so repeated throttling can never accumulate into a delisting.

The asymmetry is deliberate and must be preserved: leaving a dead listing in for another day costs
one wasted scrape; delisting a live competitor silently corrupts the market picture and loses
history that cannot be re-scraped (rates are only observable forward).

**How to apply:** never add a code path that drops a property based on scan absence alone. A
`--miss-threshold=1` run is the way to exercise the confirmation path on real data — it will
report a pile of "false alarm(s) kept", which is the system working, not a problem. Deleting is
opt-in (`--purge`) and non-default because there is no git history here.

Related: [[booking-text-search-is-flaky]], [[booking-slug-is-identity]],
[[config-writes-race-no-locking]].
