---
name: map-pins-need-their-own-price-rule
description: Map pins must use mapPinPrice(), not inferPrice() — inferPrice's null-on-sold-out is correct for analytics and wrong for a pin
metadata:
  type: project
---

`inferPrice(room, date)` returns **null for a sold-out night on purpose**. Its own comment records
why: inferring a night-type median for an unbookable night once made a plausible rate appear for a
night nobody could book, and that fabricated number then flowed into the comparison tables, the
analytics and the occupancy simulator. **Do not change that.**

But a map pin answers a different question — *"what does this property cost?"* — and a dash there
does not mean "no data", it means "we couldn't tell you", which was wrong for a property that is
merely **full tonight**. On 2026-08-11 that dashed 10 of 62 tracked competitors and 4 of the 6 own
properties, all of which had real rates later in the same 30-night window.

So pins go through **`mapPinPrice(entity, today, cardPrice)`**, which resolves in order:

1. tonight's rate, **across every room** (not just the primary — a sold-out primary must not mask
   an available room),
2. the **next available night** in the window,
3. the **discovery search-card** price,

and returns `{ price, basis: 'today'|'next'|'card'|null, date }`. The basis is not optional
decoration: it is what stops the pin implying a later night is tonight's price. It drives the
tooltip and popup suffix ("from 19 Aug", "search rate"), and it gates the cheaper/pricier colouring
and the "vs yours" delta — those apply **only** when both sides are `basis === 'today'`, or the pin
would assert a comparison between two different dates.

**A second, separate trap: markers go stale.** A pin's label is baked into its Leaflet **divIcon
HTML at creation**, and Discover entries are merged from several sources in sequence (cached
results → full market → rescan). Both merge sites fill in `entry.price` when a later source has
one, but only ever call `_discAddMarker` for entries with *no* marker yet — so a price arriving
after the marker was built was stored on the entry and never displayed. A divIcon's HTML cannot be
mutated in place, so `_discRebuildMarker()` replaces the marker; call it from anywhere that
changes an entry's price. This is invisible unless you compare `marker.options._price` against
`entry.price`, which is exactly what caught it.

**How to apply:** any new map/pin/marker surface uses `mapPinPrice()`; anything feeding a table,
an average, a suggestion or the simulator keeps using `inferPrice()`. If a pin still shows a dash,
that now genuinely means no rate in any source — the fix for those is data, not code:
`node fetch-discover-prices.js --property=<id> --nights=30 --only-missing` scrapes each discovered
property's own page (far more stable than the search page) and writes the rate into the cache. That
one pass took card-price coverage from 38% to 78% of candidates.

Also worth knowing: the big `MAP VIEW` block in `dashboard/index.html` (`renderMap()`,
`placeMapMarkers()`, `buildMapCompList()`) is **dead code** — never called, and its DOM targets
don't exist. The live map is the Discover panel's `_discMap2`. Don't spend time debugging the
wrong one.

Related: [[leaflet-null-latlng-trap]], [[report-was-bespoke-to-one-hostel]].
