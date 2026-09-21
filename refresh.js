'use strict';
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ensureChrome, CDP_URL } = require('./lib/chrome');

const META_PATH           = path.join(__dirname, 'data', 'latest.meta.json');
const DASHBOARD_DATA_PATH = path.join(__dirname, 'data', 'latest.dashboard.json');
const HISTORY_DIR         = path.join(__dirname, 'data', 'history');
const CONFIG_FILE         = path.join(__dirname, 'config', 'properties.json');

// ── Load property config from JSON (no more hardcoded SLUGS/META) ─────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`config/properties.json not found. Run: node import-properties.js`);
  }
  const { properties } = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

  const SLUGS = {};
  const META  = {};
  for (const p of properties) {
    SLUGS[p.id] = p.slug;
    META[p.id] = {
      type:    p.type,
      display: p.display,
      loc:     p.location || p.city || '',
      city:    p.city || '',
      match:   p.match || p.id.replace(/_/g, ' '),
      comps:   p.competitors || [],
      deal:    p.deal || 0,
      bed:     p.beds > 1 ? `${p.beds} beds` : '1 dbl',
      beds:    p.beds || 1,
      pax:     p.pax || 2,
      propertyType: p.propertyType || 'villa',
      lat:     p.lat || null,
      lng:     p.lng || null,
    };
  }
  return { SLUGS, META };
}

// ── Price extractor ───────────────────────────────────────────────────────────
function parsePrices(html) {
  const idx = html.indexOf('b_rooms_available_and_soldout');
  if (idx < 0) return null;
  let i = html.indexOf('[', idx);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  const start = i;
  for (; i < html.length; i++) {
    const c = html[i];
    if (esc)    { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
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
            let inv = null;
            for (const f of ['b_rooms_available', 'b_max_number_of_the_same_room_type',
                             'b_nr_remaining_rooms', 'b_number_of_the_same_type_in_a_row',
                             'b_max_rooms_in_reservation']) {
              const src = rm[f] != null ? rm[f] : (blk && blk[f] != null ? blk[f] : null);
              if (src != null) {
                const n = parseInt(src);
                if (!isNaN(n) && n > 0) { inv = n; break; }
              }
            }
            return { n: (rm.b_name || '').trim(), p: price, inv };
          });
        } catch (_) { return null; }
      }
    }
  }
  return null;
}

const SCRAPE_CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY || '80', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scrape(fetchHeaders, dates, META, SLUGS, filterKeys = null) {
  const all = {};
  const entries = filterKeys
    ? Object.entries(SLUGS).filter(([key]) => filterKeys.has(key))
    : Object.entries(SLUGS);
  // soldOut  — Booking.com rendered the page but offered no bookable room that night
  // noData   — every attempt failed, so availability is genuinely unknown
  // Keeping these apart matters: a sold-out night is a fact worth showing, an unknown one is not.
  for (const [key] of entries) all[key] = { rooms: {}, inv: {}, soldOut: new Set(), noData: new Set() };

  const tasks = [];
  for (const [key, slug] of entries)
    for (const d of dates)
      tasks.push({ key, slug, d });

  let idx = 0, done = 0, retries = 0, gaveUp = 0;
  const total = tasks.length;
  let limit = SCRAPE_CONCURRENCY;

  const fetchDate = async (slug, d) => {
    const nd = new Date(d + 'T00:00:00');
    nd.setDate(nd.getDate() + 1);
    const next = nd.getFullYear() + '-' +
      String(nd.getMonth() + 1).padStart(2, '0') + '-' +
      String(nd.getDate()).padStart(2, '0');
    const url = `https://www.booking.com/hotel/in/${slug}.en-gb.html?checkin=${d}&checkout=${next}&group_adults=2&group_children=0&no_rooms=1`;

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(url, { headers: fetchHeaders });
        if (r.status === 429 || r.status === 202) {
          try { await r.body?.cancel?.(); } catch (_) {}
          retries++;
          if (retries % 25 === 0 && limit > 15) {
            limit = Math.max(15, Math.floor(limit * 0.7));
            process.stdout.write(`\n  ⚠ Rate-limited — throttling to ${limit} concurrent\n`);
          }
          if (attempt < 3) await sleep(1500 * Math.pow(2, attempt) + Math.random() * 800);
          continue;
        }
        const html = await r.text();
        // The page rendered but carries no room table: nothing is bookable that night.
        // That is real availability information, not a failure — report it as such.
        if (!html.includes('b_rooms_available_and_soldout')) return { status: 'soldout' };
        const rooms = parsePrices(html);
        if (!rooms || !rooms.length) return { status: 'soldout' };
        return { status: 'ok', rooms };
      } catch (_) {
        if (attempt < 3) await sleep(1000 * (attempt + 1));
      }
    }
    gaveUp++;
    return { status: 'error' };
  };

  let active = 0;
  const worker = async () => {
    while (true) {
      while (active >= limit) await sleep(50);
      const i = idx++;
      if (i >= tasks.length) break;
      active++;
      const { key, slug, d } = tasks[i];
      const res = await fetchDate(slug, d);
      active--;
      if (res && res.status === 'ok') {
        const { rooms, inv: invMap } = all[key];
        const seen = new Set();
        for (const rm of res.rooms) {
          if (seen.has(rm.n)) continue;
          seen.add(rm.n);
          if (!rooms[rm.n]) rooms[rm.n] = {};
          // rm.p is null when that specific room is unavailable for the night, which the
          // dashboard reads as sold out for that room
          rooms[rm.n][d] = rm.p;
          if (d === dates[0] && rm.inv != null && !(rm.n in invMap)) invMap[rm.n] = rm.inv;
        }
      } else if (res && res.status === 'soldout') {
        all[key].soldOut.add(d);
      } else {
        all[key].noData.add(d);
      }
      done++;
      if (done % 200 === 0 || done === total)
        process.stdout.write(`  ${done}/${total} fetched (${Math.round(done / total * 100)}%)  \r`);
    }
  };

  await Promise.all(Array.from({ length: SCRAPE_CONCURRENCY }, worker));
  process.stdout.write('\n');
  if (retries > 0)
    console.log(`  ℹ ${retries} rate-limit hits retried${gaveUp ? `, ${gaveUp} gave up` : ''}`);
  for (const [key] of entries) {
    const a = all[key];
    const extra = [
      a.soldOut.size ? `${a.soldOut.size} night(s) sold out` : '',
      a.noData.size  ? `${a.noData.size} night(s) unfetched` : '',
    ].filter(Boolean).join(', ');
    console.log(`  ${key}: ${Object.keys(a.rooms).length} room type(s)${extra ? ' — ' + extra : ''}`);
  }
  return all;
}

// ── Room metadata inference ───────────────────────────────────────────────────
function inferBedType(roomName) {
  const n = (roomName || '').toLowerCase();
  if (/suite/.test(n))                          return 'suite';
  if (/\bking\b/.test(n))                       return 'king';
  if (/\bqueen\b/.test(n))                      return 'queen';
  if (/twin|2\s*single/.test(n))                return 'twin';
  if (/triple|3\s*bed/.test(n))                 return '3 beds';
  if (/quad|4\s*bed/.test(n))                   return '4 beds';
  const m = (roomName || '').match(/(\d+)\s*bed/i);
  if (m && parseInt(m[1]) > 1)                  return `${m[1]} beds`;
  if (/studio/.test(n))                         return 'studio';
  if (/dorm/.test(n))                           return 'dorm';
  return 'dbl';
}

function inferPax(roomName, fallback) {
  const n = (roomName || '').toLowerCase();
  const m = n.match(/(\d+)\s*(?:adult|guest|pax|person|people)/);
  if (m) return parseInt(m[1], 10);
  if (/triple|3\s*(bed|person|adult)/.test(n)) return 3;
  if (/quad|4\s*(bed|person|adult)/.test(n))   return 4;
  return fallback || 2;
}

// ── Dashboard data builder ────────────────────────────────────────────────────
function buildDashboardData(all, dates, META) {
  const today = dates[0];
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');

  function buildRoom(pid, name, obs, inv, isPrimary, soldOut) {
    const m = META[pid];
    // An explicit null means "known unavailable". Nights where the whole property was sold out are
    // written onto every room, so the dashboard can say "Sold Out" instead of guessing a price from
    // neighbouring nights — a fabricated rate for an unbookable night is worse than no rate.
    // Nights we simply could not fetch stay ABSENT, so unknown never masquerades as sold out.
    const observed = { ...obs };
    for (const d of soldOut) {
      if (observed[d] === undefined) observed[d] = null;
    }
    const room = {
      name,
      pax:  inferPax(name, m.pax),
      bed:  inferBedType(name),
      deal: m.deal || 0,
      observed,
    };
    if (isPrimary) room.primary = true;
    if (inv != null) room.inv = inv;
    return room;
  }

  const ownIds  = Object.keys(META).filter(k => META[k].type === 'own');
  const compIds = Object.keys(META).filter(k => META[k].type === 'comp');

  const portfolio   = {};
  const competitors = {};

  for (const pid of ownIds) {
    const m = META[pid];
    const { rooms, inv: invMap, soldOut, noData } = all[pid] || { rooms: {}, inv: {}, soldOut: new Set(), noData: new Set() };
    const names = Object.keys(rooms);
    portfolio[pid] = {
      id: pid,
      name: m.display,
      location: m.loc,
      city: m.city,
      propertyType: m.propertyType,
      beds: m.beds,
      pax: m.pax,
      bookingMatch: m.match,
      competitors: m.comps,
      rooms: {},
      lat: m.lat,
      lng: m.lng,
      soldOutDates: [...(soldOut || [])].sort(),
      noDataDates:  [...(noData  || [])].sort(),
    };
    names.forEach((n, i) => {
      portfolio[pid].rooms[slug(n)] = buildRoom(pid, n, rooms[n], invMap[n] ?? null, i === 0, soldOut || new Set());
    });
  }

  for (const pid of compIds) {
    const m = META[pid];
    const { rooms, inv: invMap, soldOut, noData } = all[pid] || { rooms: {}, inv: {}, soldOut: new Set(), noData: new Set() };
    const names = Object.keys(rooms);
    competitors[pid] = {
      name: m.display,
      location: m.loc,
      city: m.city,
      propertyType: m.propertyType,
      beds: m.beds,
      pax: m.pax,
      bookingMatch: m.match,
      rooms: {},
      lat: m.lat,
      lng: m.lng,
      soldOutDates: [...(soldOut || [])].sort(),
      noDataDates:  [...(noData  || [])].sort(),
    };
    names.forEach((n, i) => {
      competitors[pid].rooms[slug(n)] = buildRoom(pid, n, rooms[n], invMap[n] ?? null, i === 0, soldOut || new Set());
    });
  }

  return {
    meta: {
      today,
      scrapedAt: new Date().toISOString(),
      nights: dates.length,
      source: 'booking.com',
    },
    portfolio,
    competitors,
  };
}

function writeDashboardData(data) {
  fs.mkdirSync(path.dirname(DASHBOARD_DATA_PATH), { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(DASHBOARD_DATA_PATH, json);
  fs.writeFileSync(path.join(HISTORY_DIR, `${data.meta.today}.dashboard.json`), json);
  // Cleanup history older than 90 days
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const f of fs.readdirSync(HISTORY_DIR)) {
      if (f < cutoffStr + '.') {
        fs.unlinkSync(path.join(HISTORY_DIR, f));
      }
    }
  } catch (_) {}
}

// ── Main ──────────────────────────────────────────────────────────────────────
const propArg      = process.argv.find(a => a.startsWith('--property='));
const targetPropId = propArg ? propArg.replace('--property=', '') : null;

(async () => {
  const { SLUGS, META } = loadConfig();

  if (targetPropId && !META[targetPropId]) {
    console.error(`Unknown property ID: "${targetPropId}"`);
    console.error('Valid IDs:', Object.keys(META).filter(k => META[k].type === 'own').join(', '));
    process.exit(1);
  }

  await ensureChrome();

  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];

  let page = ctx.pages().find(p => /booking\.com/.test(p.url()));
  if (!page) page = await ctx.newPage();
  await page.goto('https://www.booking.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const isLoggedIn = await page.evaluate(() => {
    return !(/sign\s*in/i.test(
      document.querySelector('[data-testid="header-sign-in-button"]')?.textContent || ''
    )) && (
      document.body.innerHTML.includes('bui-avatar') ||
      document.body.innerHTML.includes('account-menu') ||
      !document.querySelector('[data-testid="header-sign-in-button"]')
    );
  }).catch(() => false);

  if (!isLoggedIn) {
    console.log('\n ⚠  Not logged in to Booking.com.');
    console.log(' Please log in in the Chrome window, then wait…\n');
    let loggedIn = false;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      loggedIn = await page.evaluate(() =>
        !document.querySelector('[data-testid="header-sign-in-button"]')
      ).catch(() => false);
      if (loggedIn) { console.log(' Logged in! Proceeding…\n'); break; }
      if (i % 15 === 14) console.log(` Still waiting for login… (${120 - i - 1}s remaining)`);
    }
    if (!loggedIn) {
      console.error('Login timeout. Please log in to Booking.com and retry.');
      process.exit(1);
    }
  } else {
    console.log('Booking.com: logged in.');
  }

  const cookies = await ctx.cookies('https://www.booking.com');
  await browser.close();
  if (cookies.length < 3) {
    console.error('Too few cookies — something went wrong.');
    process.exit(1);
  }
  console.log(`Got ${cookies.length} cookies. Scraping…`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today.getTime() + i * 86400000);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  });

  const fetchHeaders = {
    Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.9',
    Referer: 'https://www.booking.com/',
    'Upgrade-Insecure-Requests': '1',
  };

  const t0 = Date.now();
  const targetComps = targetPropId ? (META[targetPropId].comps || []) : [];
  if (targetPropId) {
    console.log(`Fetching: ${META[targetPropId].display} + ${targetComps.length} competitor(s)`);
  }
  const filterKeys = targetPropId ? new Set([targetPropId, ...targetComps]) : null;
  const all = await scrape(fetchHeaders, dates, META, SLUGS, filterKeys);

  const totalRows = Object.values(all).reduce((s, { rooms }) => s + Object.keys(rooms).length, 0);
  if (totalRows === 0) {
    console.error('No data — cookies may be stale. Visit booking.com in Chrome and retry.');
    process.exit(1);
  }

  // (data/latest.csv removed — it was written but never read; pricing now goes to
  //  Google Sheets via sync-sheets.js, and the dashboard reads latest.dashboard.json)

  const dashboardData = buildDashboardData(all, dates, META);
  fs.writeFileSync(META_PATH, JSON.stringify(dashboardData.meta, null, 2));

  if (targetPropId) {
    let existing = { portfolio: {}, competitors: {} };
    try { existing = JSON.parse(fs.readFileSync(DASHBOARD_DATA_PATH, 'utf8')); } catch (_) {}
    existing.portfolio[targetPropId] = dashboardData.portfolio[targetPropId] || existing.portfolio[targetPropId];
    for (const compId of META[targetPropId].comps || []) {
      if (dashboardData.competitors[compId]) existing.competitors[compId] = dashboardData.competitors[compId];
    }
    // Take the fresh run's meta wholesale, not just scrapedAt. Bumping scrapedAt alone left
    // `today` and `nights` frozen at whatever the last FULL refresh wrote — the file ended up
    // claiming today was 2026-07-02 while scrapedAt said 2026-08-08. The dashboard papered over
    // it by using the browser clock, but the Sheets sync and the report builder both read
    // meta.today, so it has to be right here.
    existing.meta = { ...(existing.meta || {}), ...dashboardData.meta };
    fs.mkdirSync(path.dirname(DASHBOARD_DATA_PATH), { recursive: true });
    fs.writeFileSync(DASHBOARD_DATA_PATH, JSON.stringify(existing));
    console.log(`\n  ✓ Updated ${META[targetPropId].display}`);
  } else {
    writeDashboardData(dashboardData);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  Done in ${elapsed}s — ${totalRows} room types across ${Object.keys(all).length} properties.\n`);
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
