---
name: playwright-only-for-cookies
description: refresh.js uses Playwright only to harvest logged-in cookies, then scrapes with raw fetch at high concurrency
metadata:
  type: project
---

`refresh.js` opens Chrome over CDP **only to obtain logged-in Booking.com cookies**, then closes the
browser and scrapes with raw `fetch()` at 80-way concurrency (`SCRAPE_CONCURRENCY`). Prices come
from the `b_rooms_available_and_soldout` JSON blob embedded in each hotel page, extracted with a
hand-written brace matcher rather than a regex. On repeated 429/202 it retries with exponential
backoff and cuts concurrency 30% every 25 hits (floor 15).

`lib/chrome.js` deliberately runs **headful for `refresh.js`** (the user may need to log in) and
headless for everything else, kills only the process listening on the CDP port -- never the user's
personal Chrome -- and uses a temp profile directory.

**Important limit:** a bare `fetch` works for *price* pages but NOT for a cold property page --
Booking.com answers unauthenticated requests with a ~4 KB HTTP 202 bot-check stub. Anything that
needs page metadata (coordinates, JSON-LD) must go through the browser. See
[[share-links-break-pipeline]].

**How to apply:** keep the browser off the hot path. If a new scrape target needs auth, harvest
cookies once and fetch. Never make `refresh.js` headless -- it would break interactive login.
