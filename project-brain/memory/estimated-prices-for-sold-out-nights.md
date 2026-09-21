---
name: estimated-prices-for-sold-out-nights
description: The Analysis panel fills sold-out nights with the property's own average available price, marked; it flattens trend/premium/volatility by construction so measured figures are shown alongside
metadata:
  type: feedback
---

The user asked (2026-08-11) for sold-out dates to be **included** in analysis, priced at that
property's **average available price**, clearly marked as estimated.

This reverses an earlier decision. `inferPrice()` refuses to price a sold-out night, and its comment
records why: inferring a rate for an unbookable night once put fabricated numbers into the
comparison tables, the analytics and the occupancy simulator. The user's version adds what was
missing — explicit marking — so it was implemented, but **`inferPrice()` was left untouched**. The
map pins, the calendar and the competitor-occupancy analysis all depend on sold-out staying
distinguishable from priced; the occupancy analysis *is* the sold-out signal.

## The mechanism

`avgAvailablePrice(room, dates)` and `priceOrEstimate(room, date, avg)` in `dashboard/index.html`.
A `nodata` night stays null — a night nobody fetched is not evidence of anything. Each competitor is
estimated **from itself**, never from the market average, or the fill would drag every property
toward one number and manufacture agreement that was never observed.

## What filling does to each metric — measured on the real portfolio

| metric | effect | why |
|---|---|---|
| **ADR / averages** | **unchanged, always** | filling with the mean cannot move the mean |
| **Per-date comparisons, market band, pricing mix, distribution** | **genuinely improved** | on a busy weekend most competitors drop out, so the old "market average" came only from whoever still had rooms — systematically the expensive ones |
| **Trend slope** | roughly halves (₹277 → ₹164/day) | a run of identical values has no slope |
| **Trend fit R²** | collapses (0.91 → 0.54, 0.85 → 0.31, 0.79 → 0.28) | constants are not explained by a sloped line |
| **Weekend premium** | roughly halves (7% → 3%, 4% → 1%) | **weekends sell out FIRST**, so weekend nights are the ones replaced by the flat overall average |
| **Volatility** | falls (15% → 13%) | constants carry no variance |

## The consequence to keep in view

R² collapsing below the 0.35 confidence gate flips the **Forward Trend headline to "Flat"** for
properties whose observed rates rise strongly. On 2026-08-11: property 2 read **"Flat"** while its
measured series rose **+58% (R² 0.85)**; property 3 "Flat" vs measured **+49% (R² 0.79)**; property 5
"Flat" vs **+21%**. Properties 1, 4 and 6 kept a direction but at roughly half the magnitude.

That is why the panel shows the **measured** figure beside the estimated one for trend, weekend
premium and volatility, and states the basis under the chart. Averages and comparisons use the
estimated series alone, because there it only helps.

**How to apply:** if the "Flat" headlines are judged misleading, switch the Forward Trend KPI to
`fitMeas` / `trendWindowPctMeasured` (already computed) and keep the estimated figure as the
secondary — a one-line change. A **night-type-aware** estimate (average of that night type's
available prices, rather than one flat average) would preserve the weekend premium and is the better
estimator; the flat average is what was specified.

Marking: ✕ hollow markers + dashed segments on the chart, dashed outline and (brackets) in the
heatmap, `·Ne` beside a competitor's average, "(₹x) est" on the positioning pin, "estimated (sold
out)" in tooltips, and a note under the trend chart.

Related: [[analysis-numbers-must-scale-and-admit-unknowns]], [[map-pins-need-their-own-price-rule]].
