---
name: leaflet-null-latlng-trap
description: Leaflet turns any malformed coordinate into a null latLng, then throws "Cannot read properties of null (reading 'lat')" from deep inside the library
metadata:
  type: project
---

`L.latLng(x)` returns **null** rather than throwing when `x` isn't a usable coordinate. The error
only surfaces later, inside Leaflet, as:

```
Cannot read properties of null (reading 'lat')
```

with a stack that points into the library and tells you nothing about the bad input.

**How it happened here:** `_discEnsureOwnMarker()` called `nominatimGeocode(...)` **without
`await`** (its sibling `_discInitMap()` did await it). The returned Promise was truthy, so it was
written into the `sessionStorage` coordinate cache, `JSON.stringify`'d to `{}`, and later handed to
`L.marker()` / `setView()`. It stayed invisible for as long as every property had `lat`/`lng` in
config, and only appeared once properties existed without coordinates.

**How to apply:** never pass a coordinate to Leaflet without validating it. `dashboard/index.html`
has `validCoords()`, `readCoordCache()`, `writeCoordCache()` and `coordsOf()` for this — reads drop
malformed entries, writes refuse them. The cache key is versioned (`sv_mapCoords_v5`) so poisoned
entries from an earlier session are retired rather than re-read. Also reject `[0,0]`: "null island"
is missing data, not a location off West Africa.
