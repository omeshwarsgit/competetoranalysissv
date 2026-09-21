---
name: share-links-break-pipeline
description: booking.com/Share-xxxx URLs carry no slug, but they DO resolve to canonical hotel URLs via a plain redirect follow
metadata:
  type: project
---

Booking.com **share links** (`https://www.booking.com/Share-gB1PDI`) are redirect stubs containing no
hotel slug. Both consumers extract the slug with `/booking\.com\/hotel\/[a-z]{2}\/([^.?/]+)/i`, so:

- `import-properties.js` fails the row with *"Cannot parse Booking.com slug from …"* and exits 1
- `refresh.js` builds `https://www.booking.com/hotel/in/<slug>.en-gb.html?checkin=…` and has nothing
  to fetch
- the map has no location to plot

**The fix that works:** a plain `fetch(url, { redirect: 'follow' })` resolves a share link to its
canonical `/hotel/in/<slug>` URL — verified on all 6 rows. `resolve-property-coords.js` does this,
then reads accurate coordinates off the property page.

**Coordinates need the browser, not fetch.** A bare `fetch` of a hotel page returns a ~4 KB HTTP 202
bot-check stub with no JSON-LD and no `data-atlas-latlng`. Load the page in Chrome via
`lib/chrome.js` + Playwright (which carries cookies) and the JSON-LD `geo` block is there.

**How to apply:** run `node resolve-property-coords.js` after any sheet change that adds share
links; add `--write-csv` to canonicalise the sheet's links too (fails harmlessly if Excel has the
file open — see [[excel-locks-properties-csv]]). Related: [[booking-slug-is-identity]].
