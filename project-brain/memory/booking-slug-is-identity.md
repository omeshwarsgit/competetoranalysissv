---
name: booking-slug-is-identity
description: Property IDs are reused across CSV revisions; only the Booking.com slug identifies a listing
metadata:
  type: project
---

**Property IDs are reused between sheet revisions.** When the sheet was replaced with 6 Goa
properties numbered 1–6, IDs 1 and 5 collided with the previous `Backspace Anjuna Beach` and
`The Boulevard Villa`. Matching on ID alone would have shown those old display names — and their old
30-night price series — under the new property names.

The **Booking.com slug** (e.g. `stayvista-at-cedar-haven`, from `booking.com/hotel/in/<slug>.html`)
is the only durable identity for a listing.

**Why:** silently wrong prices are far more dangerous than missing prices — rate accuracy is the
entire point of the tool.

**How to apply:** whenever data is carried across a sheet change, require the stored entry's slug to
equal the sheet row's slug. If the row's link yields no slug, identity is *unverifiable* and nothing
should carry over. Implemented as `syncPortfolioToCsv()` in `dashboard/index.html` and as
`confirmedIds` in `prune-to-csv.js`. Related: [[share-links-break-pipeline]],
[[csv-single-source-of-truth]].
