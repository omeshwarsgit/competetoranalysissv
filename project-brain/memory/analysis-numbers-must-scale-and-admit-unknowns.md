---
name: analysis-numbers-must-scale-and-admit-unknowns
description: Analysis thresholds must be relative to the property's own ADR, and an unknown must render as "—" not 0 — both failed across the Analysis panel
metadata:
  type: feedback
---

Two failure modes ran through every part of the Analysis panel, and both are easy to reintroduce.

## 1. Absolute thresholds on a portfolio with a 6x price spread

The portfolio runs from ₹3,299 to ₹19,456 ADR. Any fixed rupee threshold means something different
at each end:

- The trend direction test was `slope > 30 ? 'rising'`. At ₹30/day a ₹3.3k property drifts **27%**
  across the 30-night window while a ₹19k one moves **4.6%** — same verdict, different realities.
  Property 5 (0.74%/day, R² 0.43) and property 3 (1.69%/day, R² 0.79) landed on opposite sides for
  reasons unrelated to trend strength.
- The weekend-premium advice said "test raising Fri–Sun rates by ₹300–600" for every property —
  2–3% for the ₹19k villa, 9–18% for the ₹3.3k apartment.

Everything is now expressed as a share of that property's own ADR (`trendPctPerDay`,
`trendWindowPct`, and an uplift range derived from ADR).

## 2. A slope with no goodness-of-fit is not a trend

The panel announced "Forward prices trending up ~₹X/day" from a bare least-squares slope. Weekday/
weekend oscillation alone produces a non-zero slope. `trendR2` is now computed and a direction is
only claimed when R² ≥ 0.35, ≥5 nights are priced, and the drift is ≥0.25%/day of ADR. Below that it
reads "Flat", and there is a distinct insight for "drifts but the fit is poor, so treat it as noise".

## 3. Unknown must not render as zero

`Math.round(null * 100)` is `0`, so every unmodelled value displayed as a confident zero:

- `estOcc` returned a hardcoded **0.72** for nights with no competitor rate, and that fed the
  RevPAR headline — a property with no competitor rates at all showed "72% / RevPAR ₹X" built from
  nothing. Now null, and the KPI shows "—" with the reason.
- Weekend premium rendered `+${pct}%`, so a negative premium printed **"+-5%"**. Two properties
  genuinely have negative weekend premiums.
- Market Position keyed off `dates[0]` only. Tonight is sold out for 4 of the 6 properties, so it
  blanked for all of them under the label **"No competitors set"** — which was false; the
  competitors existed. It now anchors on the first night the property is bookable and states the
  real reason when it cannot be computed.
- `getCompetitorSegment(null, …)` fell back to `'Mid-Market'`, filing all 19 unpriced competitors
  into a real segment. They now get a separate "No rate" bucket and are excluded from "All".

**How to apply:** when adding anything to this panel, ask (a) would this threshold mean the same
thing at ₹3k and ₹20k, and (b) what does it render when the input is null? Verify by driving all six
properties and grepping the panel text for `NaN`, `+-`, `null`, `undefined`, `Infinity` — that is
what `verify-dashboard.js` does.

Related: [[report-was-bespoke-to-one-hostel]], [[map-pins-need-their-own-price-rule]].
