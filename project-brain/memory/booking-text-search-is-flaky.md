---
name: booking-text-search-is-flaky
description: Booking.com's ss= text search is intermittent from this client, not broken; the coordinate search is what discovery can rely on
metadata:
  type: project
---

`discover.js` has two search stages: a **City** stage using a text query (`ss=`) and an **Area**
stage using `latitude`/`longitude`. The City stage's reliability has been misdiagnosed twice —
record the corrected picture here.

| date | City stage result |
|---|---|
| 2026-08-10 | 0 cards for every probe: `ss=Goa`, `ss=Goa`+`dest_type=region`, `ss=Candolim`, `ss=Candolim, Goa, India`, `ss=Arpora`. Every one landed on a bare `/searchresults.html` shell with no `<h1>`. |
| 2026-08-11 | **24 cards** for the same Goa query, plus 25 API interceptions. Merged with the Area stage's 23 to give 84 unique candidates — property 2's pool went 22 → 95. |

So the two earlier theories were both wrong:

1. **Not** a region-vs-city layout problem (the original BUG-005 theory) — city-level queries
   returned 0 too.
2. **Not** permanently unavailable from this client either (the correction to BUG-005) — the
   identical query returned cards the next day.

It is **intermittent**, most likely bot-scoring / session state on Booking.com's side.

**How to apply:** the current design is right and needs no change — probe the text route once,
cheaply, and carry on with the coordinate search when it yields nothing, reporting
"text search unavailable" so a thin scan is never mistaken for a full-market sweep. Do not build
elaborate workarounds for it, and do not delete it as dead code: it works often enough to roughly
quadruple the candidate pool when it does. Coordinate search is the dependable floor.

Consequence worth knowing: because the City stage is intermittent, **pool sizes are not
comparable between scans**. A property showing 24 candidates and another showing 95 may differ
only in which stage happened to fire, not in market density. `--rings=4 [--ring-km=4]` is the
deliberate lever for breadth; it is off by default because at 4 km around a Candolim property it
took the pool from 24 to 689 by hitting one dense corridor.

Related: [[playwright-only-for-cookies]], [[csv-single-source-of-truth]].
