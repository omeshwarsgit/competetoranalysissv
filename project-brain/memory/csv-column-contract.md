---
name: csv-column-contract
description: properties.csv reuses the Location column for competitor names on rows with no Property ID
metadata:
  type: reference
---

`properties.csv` columns are `Property ID, Property, Booking.com Link, Location, Competitor Link`,
but two of them change meaning depending on the row:

| Column | Row **with** a Property ID | Row **without** one |
|---|---|---|
| `Location` | city/area used as the Booking.com search term | **the competitor's name** |
| `Competitor Link` | unused | the competitor's Booking.com URL |

So `,,,Craft Hostels,https://...` is a manual competitor belonging to whichever numbered property
appears **above** it -- row order is significant.

Other quirks: one config entry per Property ID; repeated IDs are separately sellable units of one
listing (`Amber @ Golden Triangle`) and collapse to a shared base name, with the unit names kept on
`units[]`. The file is exported from Excel as **Windows-1252, not UTF-8** -- decode strict UTF-8
first and fall back, or names become mojibake, and those names feed Booking.com search and
geocoding. Legacy headers (`Stayvista Property`, `Own Link`, `Sr.`) are still accepted.

**How to apply:** any new CSV reader must replicate the 3-pass parse, the ID normalisation
(`replace(/[^a-zA-Z0-9_-]/g, '_')`) and the encoding fallback. `serve.js`,
`import-properties.js`, `prune-to-csv.js` and `resolve-property-coords.js` each carry their own
copy -- consolidating them is task T-010.
