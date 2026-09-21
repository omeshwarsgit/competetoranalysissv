---
name: report-was-bespoke-to-one-hostel
description: build-price-report.js was written for the hostel that used to be ID 1 and asserted its competitors, rates and premiums for any property
metadata:
  type: project
---

`build-price-report.js` reads as a general report generator but was written against **one**
property: Backspace Anjuna Beach, the hostel that used to be Property ID 1. Because IDs are
reused between sheet revisions ([[booking-slug-is-identity]]), it kept emitting that hostel's
specifics while analysing an unrelated Candolim villa — and stated them as findings:

- Parity targets were three hardcoded hostels with hardcoded rates: "Craft Hostels" ₹599,
  "La GoYa at Anjuna Beachside" ₹620, "The Beachside Hostel" ₹502.
- "The dorm reaches **+87%** on its strongest night" — a literal constant.
- "No floor beneath the dorm … the nearest competitor is **₹502**" — also constant.
- "This property is **not** pricing flat" and "Dense band, minimal pricing power" were asserted
  unconditionally, the latter over a band of two competitors.
- A villa has one room, so the dorm track had no data: `mean(pS)/mean(dS)` rendered as
  **Infinity×**, chart markers drew at `null`, and one chart printed "own dorm +null% (p0)".
- Ranks printed as the impossible "ranked 3 of 2" — `rankOf` places the own rate *among* the
  band's competitors, so the total has to include the own property.

It also **refused to run at all** for the current portfolio: the fatal guard required a discovery
search-card price (`results[].price`), which is `null` for every candidate the coordinate search
returns, while 30-night scraped curves for those same peers sat unused in `latest.dashboard.json`.

All of the above is now data-driven: parity targets are the cheapest priced competitors above the
product's rate, premiums and floors are computed, the dorm track and its section are gated on
`hasDorm`, section numbers shift via `SN()`, and the lead-in rate falls back to the first
available night of the scraped curve (disclosed on the cover as "Lead-in source").

**Why it matters:** this is a document someone would price against. Wrong-but-confident prose is
worse than a missing section.

**How to apply:** when touching this file, assume nothing about the property's shape — a villa,
an apartment and a hostel all pass through it. Any sentence that names a competitor or states a
percentage must come from `priced` / `PRIMARY` / `maxPremium()`, never a literal. Verify by
building all six and grepping the HTML for `NaN`, `Infinity`, `null%`, `undefined` and
`ranked N of M` where N > M.

Related: [[booking-slug-is-identity]], [[csv-single-source-of-truth]].
