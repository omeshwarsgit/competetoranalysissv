/**
 * fetch-discover-prices.js
 *
 * Fills in the `price` field on discovered properties in data/discovery-cache.json.
 *
 * Why this exists: discover.js only learns a price when it manages to intercept
 * Booking.com's search API during a market scan. When the search page falls back to
 * DOM parsing (sign-in modal, layout change, rate limiting) every result comes back
 * with price:null, and the Discover tab has nothing to show. This scrapes each
 * discovered property's own page — the same endpoint refresh.js uses, which is far
 * more stable than the search page — and writes the real rate back into the cache.
 *
 * Usage:
 *   node fetch-discover-prices.js --property=<id>       one property's discoveries
 *   node fetch-discover-prices.js --property=<id> --nights=7
 *   node fetch-discover-prices.js --property=<id> --only-missing
 *
 * Options:
 *   --property=<id>   REQUIRED. Which property's discovery results to price.
 *   --nights=N        Nights to probe from today (default 7). The stored price is
 *                     the earliest night that has one, so a sold-out tonight still
 *                     yields the next available rate.
 *   --only-missing    Skip entries that already carry a price.
 *   --concurrency=N   Parallel fetches (default 40).
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ensureChrome, CDP_URL } = require('./lib/chrome');

const DISC_FILE = path.join(__dirname, 'data', 'discovery-cache.json');

// ── args ──────────────────────────────────────────────────────────────────────
const arg = n => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : null;
};
const PROP_ID      = arg('property');
const NIGHTS       = Math.max(1, parseInt(arg('nights') || '7', 10));
const CONCURRENCY  = Math.max(1, parseInt(arg('concurrency') || '40', 10));
const ONLY_MISSING = process.argv.includes('--only-missing');

if (!PROP_ID) {
  console.error('\n  --property=<id> is required.\n');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── price parsing — mirrors refresh.js parsePrices() ──────────────────────────
function parsePrices(html) {
  const idx = html.indexOf('b_rooms_available_and_soldout');
  if (idx < 0) return null;
  let i = html.indexOf('[', idx);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  const start = i;
  for (; i < html.length; i++) {
    const c = html[i];
    if (esc)        { esc = false; continue; }
    if (c === '\\') { esc = true;  continue; }
    if (c === '"')  { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)).map(rm => {
            const blk = (rm.b_blocks && rm.b_blocks[0]) || null;
            let price = null;
            if (blk && blk.b_price) {
              const d = String(blk.b_price).replace(/[^0-9]/g, '');
              if (d) price = parseInt(d, 10);
            }
            return { n: (rm.b_name || '').trim(), p: price };
          });
        } catch (_) { return null; }
      }
    }
  }
  return null;
}

function dateList(n) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(t.getTime() + i * 86400000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  });
}

async function fetchNight(slug, d, headers) {
  const nd = new Date(d + 'T00:00:00');
  nd.setDate(nd.getDate() + 1);
  const next = nd.getFullYear() + '-' + String(nd.getMonth() + 1).padStart(2, '0') + '-' +
               String(nd.getDate()).padStart(2, '0');
  const url = `https://www.booking.com/hotel/in/${slug}.en-gb.html`
            + `?checkin=${d}&checkout=${next}&group_adults=2&group_children=0&no_rooms=1`
            + `&selected_currency=INR`;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 429 || r.status === 202) {
        try { await r.body?.cancel?.(); } catch (_) {}
        if (attempt < 3) await sleep(1500 * Math.pow(2, attempt) + Math.random() * 800);
        continue;
      }
      const html = await r.text();
      // Page rendered but no room table => sold out / unavailable for this night
      if (!html.includes('b_rooms_available_and_soldout')) return { soldOut: true, price: null };
      const rooms = parsePrices(html);
      if (!rooms || !rooms.length) return { soldOut: true, price: null };
      const prices = rooms.map(x => x.p).filter(p => p != null && p > 0);
      if (!prices.length) return { soldOut: true, price: null };
      // Cheapest room is what Booking.com surfaces as the property's headline rate
      return { soldOut: false, price: Math.min(...prices) };
    } catch (_) {
      if (attempt < 3) await sleep(1000 * (attempt + 1));
    }
  }
  return null;   // could not determine
}

(async () => {
  if (!fs.existsSync(DISC_FILE)) {
    console.error('  data/discovery-cache.json not found.');
    process.exit(1);
  }
  const disc  = JSON.parse(fs.readFileSync(DISC_FILE, 'utf8'));
  const entry = disc[PROP_ID];
  if (!entry) {
    console.error(`  No discovery results cached for property "${PROP_ID}". Run discover.js first.`);
    process.exit(1);
  }

  // results and fullMarket hold the same objects by id — collect unique targets,
  // then write the resolved price back to every list the id appears in.
  const lists   = [entry.results || [], entry.fullMarket || []];
  const bySlug  = new Map();
  for (const list of lists) {
    for (const it of list) {
      const slug = it.slug || (it.url && (it.url.match(/\/hotel\/[a-z]{2}\/([^.?/#]+)/i) || [])[1]);
      if (!slug) continue;
      if (ONLY_MISSING && it.price != null && it.price > 0) continue;
      if (!bySlug.has(slug)) bySlug.set(slug, { slug, name: it.name || slug, items: [] });
      bySlug.get(slug).items.push(it);
    }
  }
  const targets = [...bySlug.values()];
  if (!targets.length) {
    console.log('\n  Nothing to price — every entry already has a rate.\n');
    process.exit(0);
  }

  const dates = dateList(NIGHTS);
  console.log(`\n  Pricing ${targets.length} discovered propert${targets.length === 1 ? 'y' : 'ies'} for "${PROP_ID}"`);
  console.log(`  Probing ${dates.length} night(s): ${dates[0]} → ${dates[dates.length - 1]}\n`);

  await ensureChrome();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const cookies = await ctx.cookies('https://www.booking.com');
  await browser.close();
  if (cookies.length < 3) {
    console.error('  Too few Booking.com cookies — open booking.com in Chrome and retry.');
    process.exit(1);
  }
  console.log(`  Got ${cookies.length} cookies. Fetching…`);

  const headers = {
    Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml',
  };

  let idx = 0, done = 0, priced = 0, soldOut = 0, failed = 0;
  const stamp = new Date().toISOString();

  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= targets.length) break;
      const t = targets[i];

      let price = null, sold = false, ok = false;
      // Walk forward until a night has a rate — the earliest available price
      for (const d of dates) {
        const res = await fetchNight(t.slug, d, headers);
        if (res == null) continue;
        ok = true;
        if (res.price != null) { price = res.price; sold = false; break; }
        sold = true;
      }

      for (const it of t.items) {
        if (price != null) {
          it.price = price;
          it.soldOut = false;
        } else if (ok && sold) {
          it.price = null;
          it.soldOut = true;
        }
        it.priceCheckedAt = stamp;
      }

      if (price != null) priced++; else if (ok) soldOut++; else failed++;
      done++;
      process.stdout.write(`  ${done}/${targets.length}  ${price != null ? ('₹' + price).padStart(8) : (ok ? 'sold out' : '   fail')}  ${t.name.slice(0, 44)}\n`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  entry.pricesUpdatedAt = stamp;
  const tmp = DISC_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(disc, null, 2));
  fs.renameSync(tmp, DISC_FILE);

  console.log(`\n  ✓ ${priced} priced · ${soldOut} sold out / no availability · ${failed} could not be fetched`);
  console.log(`  ✓ Written to data/discovery-cache.json\n`);
})().catch(e => { console.error('\n  FAILED:', e.message); process.exit(1); });
