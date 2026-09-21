'use strict';
/**
 * discover.js — Full Market Scan for Booking.com
 *
 * Strategy:
 *  1. Fresh browser context (no stale tabs/cookies from existing Chrome session)
 *  2. City/destination search FIRST ("ss=Gurgaon, India") — how real users search,
 *     gets complete Booking.com inventory for that market with full pagination.
 *  3. Lat/lng search as supplement — catches nearby properties in adjacent areas.
 *  4. Response interception on both searches — exact coordinates from Booking.com's
 *     internal API, no Nominatim guessing.
 *  5. Full pagination on both searches — no page cap, runs until Booking.com has
 *     no more results.
 *  6. Retry mechanism — if a page returns 0 results, waits and retries up to 2×.
 *  7. Saves both ranked `results` and complete `fullMarket` for the map view.
 *
 * Usage:  node discover.js --property=PROP_ID [--max-dist=KM] [--rings=N] [--ring-km=KM]
 * Output: JSON lines to stdout (type: status|progress|done|error)
 *
 * NOTE: a run always re-scans — the cache is cumulative, so there is nothing to "force". `--force`
 * is accepted and ignored for backwards compatibility (scheduled-scan.js still passes it); it is
 * only meaningful on `discover-all.js`, where it overrides the skip-if-already-cached filter.
 */

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const { ensureChrome, CDP_URL }                               = require('./lib/chrome');
const { geocode, getCached, haversineDist }                   = require('./lib/geocode');
const { readTracked, writeIfUnchanged }                       = require('./lib/json-store');
const { rankCandidates, inferPropertyType, computeRelevance } = require('./lib/discovery-engine');

const DISC_FILE   = path.join(__dirname, 'data', 'discovery-cache.json');
const DASH_FILE   = path.join(__dirname, 'data', 'latest.dashboard.json');
const CONFIG_FILE = path.join(__dirname, 'config', 'properties.json');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);
const propId    = args.property;
const maxDistKm = parseInt(args['max-dist'] || '40', 10);

if (!propId) { emit({ type: 'error', message: '--property=ID required' }); process.exit(1); }

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── City extraction ───────────────────────────────────────────────────────────
const CITY_DEST_IDS = {
  'gurgaon': { dest_id: '-2096897', dest_type: 'city' },
  'nahan': { dest_id: '-2105151', dest_type: 'city' },
  'pune': { dest_id: '-2108253', dest_type: 'city' },
  'lonavala': { dest_id: '-2102553', dest_type: 'city' },
  'lansdowne': { dest_id: '-2102146', dest_type: 'city' },
  'varanasi': { dest_id: '-2113915', dest_type: 'city' },
  'jaipur': { dest_id: '-2098290', dest_type: 'city' },
  'karjat': { dest_id: '-2099953', dest_type: 'city' },
  'new delhi': { dest_id: '-2106102', dest_type: 'city' },
  'goa': { dest_id: '900039281', dest_type: 'region' },
  'alibaug': { dest_id: '-2088365', dest_type: 'city' },
  'visakhapatnam': { dest_id: '-2114679', dest_type: 'city' },
  'shimla': { dest_id: '-2110996', dest_type: 'city' },
  'srinagar': { dest_id: '-2111867', dest_type: 'city' },
  'bengaluru': { dest_id: '-2090443', dest_type: 'city' },
  'jodhpur': { dest_id: '-2098877', dest_type: 'city' },
  'wayanad': { dest_id: '900052735', dest_type: 'region' },
  'udaipur': { dest_id: '-2113524', dest_type: 'city' }
};

const CITY_ALIASES = {
  'cyber city':'Gurugram','dlf':'Gurugram','gurgaon':'Gurugram','gurugram':'Gurugram','baner':'Pune','balewadi':'Pune',
  'pawna':'Lonavala','morjim':'Goa','mandrem':'Goa','candolim':'Goa',
  'mashobra':'Shimla','fagu':'Shimla','lansdowne':'Lansdowne',
  'kuruva':'Wayanad','gudibanda':'Bengaluru','bagepalli':'Bengaluru',
  'gk-1':'New Delhi','gk1':'New Delhi','vizag':'Visakhapatnam',
  'alibaug':'Alibaug','alibag':'Alibaug','karjat':'Karjat',
  'amer':'Jaipur','nahan':'Nahan','sirmour':'Nahan',
  'varanasi':'Varanasi','srinagar':'Srinagar','jodhpur':'Jodhpur',
  'udaipur':'Udaipur','lonavala':'Lonavala','gurgaon':'Gurgaon',
};
const KNOWN_CITIES = [
  'Lonavala','Karjat','Jaipur','Udaipur','Jodhpur','Varanasi','Srinagar','Shimla',
  'Lansdowne','Alibaug','Gurgaon','Delhi','New Delhi','Bangalore','Bengaluru',
  'Visakhapatnam','Wayanad','Goa','Pune','Mashobra','Nahan','Mumbai','Hyderabad','Gurugram','Gurgaon',
  'Chennai','Kolkata','Ahmedabad','Coorg','Manali','Mussoorie','Ooty','Kodaikanal',
];

function extractCity(name, configCity, area) {
  const combined = `${configCity || ''} ${area || ''} ${name || ''}`.toLowerCase();
  for (const [alias, city] of Object.entries(CITY_ALIASES)) {
    if (combined.includes(alias.toLowerCase())) return city;
  }
  for (const city of KNOWN_CITIES) {
    if (combined.includes(city.toLowerCase())) return city;
  }
  const source = configCity || name || '';
  const parts = source.split(/[,\-]/).map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || source;
}

// ── Parse hotel data from any Booking.com JSON response ───────────────────────
function parseHotelsFromResponse(body, out) {
  if (!body || typeof body !== 'object') return;
  function tryArr(arr) {
    if (!Array.isArray(arr) || !arr.length) return;
    for (const item of arr) {
      const h = normaliseHotel(item);
      if (h && !out.has(h.id)) out.set(h.id, h);
    }
  }
  function dig(obj, depth) {
    if (depth > 6 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      const isHotelArr = obj.some(item => 
        item && typeof item === 'object' && 
        (item.hotel_id != null || item.latitude != null || item.lat != null || item.hotel_name != null ||
         item.__typename === 'SearchResultProperty' || item.basicPropertyData != null)
      );
      if (isHotelArr) {
        tryArr(obj); return;
      }
      obj.forEach(v => dig(v, depth + 1));
    } else {
      for (const key of ['hotels','results','hotel_list','properties','searchResults','hotelResults','items','availabilities']) {
        if (Array.isArray(obj[key])) tryArr(obj[key]);
      }
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] && typeof obj[key] === 'object') {
          if (key === 'extensions') continue;
          dig(obj[key], depth + 1);
        }
      }
    }
  }
  dig(body, 0);
}

function normaliseHotel(item) {
  if (!item || typeof item !== 'object') return null;
  
  let rawId, id, name, lat, lng, price, rating, reviews, type, cc, slug, url;
  
  if (item.__typename === 'SearchResultProperty' || item.basicPropertyData) {
    const bpd = item.basicPropertyData || {};
    const loc = bpd.location || {};
    const dispName = item.displayName || {};
    const priceInfo = item.priceDisplayInfoIrene || {};
    const displayPrice = priceInfo.displayPrice || {};
    const amountPerStay = displayPrice.amountPerStay || {};
    const rev = bpd.reviews || {};
    
    rawId = bpd.id || '';
    slug = bpd.pageName || '';
    id = slug || String(rawId).trim();
    name = String(dispName.text || '').trim();
    
    // Check direct item.location and fallback to basicPropertyData.location
    const directLoc = item.location || {};
    lat = parseFloat(directLoc.latitude ?? loc.latitude ?? '');
    lng = parseFloat(directLoc.longitude ?? loc.longitude ?? '');
    
    price = parseFloat(amountPerStay.amountUnformatted || '') || null;
    rating = parseFloat(rev.totalScore || '') || null;
    reviews = parseInt(rev.reviewsCount || '') || null;
    type = 'Property';
    cc = String(directLoc.countryCode ?? loc.countryCode ?? 'in').toLowerCase();
    url = slug ? `https://www.booking.com/hotel/${cc}/${slug}.html` : `https://www.booking.com/hotel/in/${rawId}.html`;
  } else {
    rawId = item.hotel_id ?? item.id ?? item.hotelId ?? item.url_name ?? item.slug ?? '';
    slug = String(item.url_name ?? item.slug ?? '');
    id = slug || String(rawId).trim();
    name = String(item.hotel_name ?? item.name ?? item.hotelName ?? '').trim();
    lat = parseFloat(item.latitude ?? item.lat ?? item.location?.latitude ?? '');
    lng = parseFloat(item.longitude ?? item.lng ?? item.lon ?? item.location?.longitude ?? '');
    price = parseFloat(item.min_total_price ?? item.price ?? item.minPrice ?? '') || null;
    rating = parseFloat(item.review_score ?? item.rating ?? item.score ?? '') || null;
    reviews = parseInt(item.review_count ?? item.reviewCount ?? item.reviews ?? '') || null;
    type = String(item.accommodation_type_name ?? item.propertyType ?? item.type ?? 'Property');
    cc = String(item.cc1 ?? item.countryCode ?? 'in').toLowerCase();
    url = slug ? `https://www.booking.com/hotel/${cc}/${slug}.html` : `https://www.booking.com/hotel/in/${id}.html`;
  }

  name = name.replace(/\s*Opens\s+in\s+new\s+(window|tab)\s*/gi, '').trim();
  if (!name) return null;
  
  const stableId = slug || id || name.toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,60);
  return { id:stableId, bookingHotelId:rawId ? String(rawId) : null, name, url,
    lat:isNaN(lat)?null:lat, lng:isNaN(lng)?null:lng,
    price, rating, reviews, type };
}

// ── DOM card + globals extractor (runs inside page context) ───────────────────
const extractCards = (ownName) => {
  const results = [];
  const seen = new Set();
  const ownLow = (ownName||'').toLowerCase();
  const cleanStr = (s) => (s || '').replace(/\s*Opens\s+in\s+new\s+(window|tab)\s*/gi, '').trim();

  // Helper to recursively find objects with lat/lng in JSON
  function digJson(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      const isHotelArr = obj.some(item => 
        item && typeof item === 'object' && 
        (item.hotel_id != null || item.hotel_name != null || item.latitude != null || item.lat != null ||
         item.__typename === 'SearchResultProperty' || item.basicPropertyData != null)
      );
      if (isHotelArr) {
        obj.forEach(item => {
          if (!item || typeof item !== 'object') return;
          
          let rawId, id, name, lat, lng, price, rating, reviews, type, cc, slug, url;
          if (item.__typename === 'SearchResultProperty' || item.basicPropertyData) {
            const bpd = item.basicPropertyData || {};
            const loc = bpd.location || {};
            const dispName = item.displayName || {};
            const priceInfo = item.priceDisplayInfoIrene || {};
            const displayPrice = priceInfo.displayPrice || {};
            const amountPerStay = displayPrice.amountPerStay || {};
            const rev = bpd.reviews || {};
            
            rawId = bpd.id || '';
            slug = bpd.pageName || '';
            id = slug || String(rawId).trim();
            name = String(dispName.text || '').trim();
            
            // Check direct item.location and fallback to basicPropertyData.location
            const directLoc = item.location || {};
            lat = parseFloat(directLoc.latitude ?? loc.latitude ?? '');
            lng = parseFloat(directLoc.longitude ?? loc.longitude ?? '');
            
            price = parseFloat(amountPerStay.amountUnformatted || '') || null;
            rating = parseFloat(rev.totalScore || '') || null;
            reviews = parseInt(rev.reviewsCount || '') || null;
            type = 'Property';
            cc = String(directLoc.countryCode ?? loc.countryCode ?? 'in').toLowerCase();
            url = slug ? `https://www.booking.com/hotel/${cc}/${slug}.html` : `https://www.booking.com/hotel/in/${rawId}.html`;
          } else {
            rawId = item.hotel_id ?? item.id ?? item.hotelId ?? item.url_name ?? item.slug ?? '';
            slug = String(item.url_name ?? item.slug ?? '');
            id = slug || String(rawId).trim();
            name = String(item.hotel_name ?? item.name ?? item.hotelName ?? '').trim();
            lat = parseFloat(item.latitude ?? item.lat ?? item.location?.latitude ?? '');
            lng = parseFloat(item.longitude ?? item.lng ?? item.lon ?? item.location?.longitude ?? '');
            price = parseFloat(item.min_total_price ?? item.price ?? item.minPrice ?? '') || null;
            rating = parseFloat(item.review_score ?? item.rating ?? item.score ?? '') || null;
            reviews = parseInt(item.review_count ?? item.reviewCount ?? item.reviews ?? '') || null;
            type = String(item.accommodation_type_name ?? item.propertyType ?? item.type ?? 'Property');
            cc = String(item.cc1 ?? item.countryCode ?? 'in').toLowerCase();
            url = slug ? `https://www.booking.com/hotel/${cc}/${slug}.html` : `https://www.booking.com/hotel/in/${id}.html`;
          }

          if (!id) return;
          name = cleanStr(name);
          if (!name) return;
          if (name.toLowerCase().startsWith(ownLow.split(/\s/)[0])) return;
          
                    if (!isNaN(lat) && !isNaN(lng) && !seen.has(id)) {
            seen.add(id);
            results.push({
              id, slug, bookingHotelId: rawId ? String(rawId) : null,
              name, url, price, rating, reviews, type,
              image: item.image ?? item.max_photo_url ?? null,
              lat, lng
            });
          }
        });
      } else {
        obj.forEach(digJson);
      }
    } else {
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'object') {
          digJson(obj[k]);
        }
      }
    }
  }

  // 1. Pull from all JSON script tags on the page (highly reliable for modern Booking.com)
  try {
    document.querySelectorAll('script').forEach(s => {
      try {
        const text = s.textContent || '';
        if (text.length < 200) return;
        if (s.type === 'application/json' || s.type === 'application/ld+json') {
          const j = JSON.parse(text);
          digJson(j);
        } else if (text.includes('latitude') && text.includes('longitude')) {
          // Check for JSON-like blocks inside javascript scripts
          const matches = text.match(/\{"[\s\S]+"\}/g);
          if (matches) {
            matches.forEach(m => {
              try { const j = JSON.parse(m); digJson(j); } catch(_) {}
            });
          }
        }
      } catch(_) {}
    });
  } catch(_) {}

  // 2. Pull from DOM cards (visual fallback)
  const cardSelectors = [
    '[data-testid="property-card"]',
    '[data-testid="hotel-card"]',
    '[data-testid="listing-card"]',
    '.sr_property_block',
    '[data-hotelid]',
    '[data-hotel-id]',
    '[data-testid="card-container"]',
  ].join(',');

  document.querySelectorAll(cardSelectors).forEach(card => {
    try {
      const nameEl = card.querySelector(
        '[data-testid="title"],[data-testid="property-card-title"],' +
        '[data-testid="listing-name"],.sr-hotel__name,h3,[class*="title"],[class*="Name"]'
      );
      let name = nameEl?.textContent?.trim() || card.querySelector('a[href*="/hotel/"]')?.textContent?.trim() || '';
      name = cleanStr(name);
      if (!name || name.toLowerCase() === ownLow) return;
      if (name.toLowerCase().startsWith(ownLow.split(/\s/)[0])) return;

      const linkEl = card.querySelector(
        'a[data-testid="title-link"],a[data-testid="property-card-link"],a[href*="/hotel/"]'
      );
      const href   = linkEl?.getAttribute('href') || '';
      const rawUrl = href.startsWith('http') ? href : (href ? 'https://www.booking.com' + href : '');
      const url    = rawUrl.split('?')[0];
      const slugM  = url.match(/\/hotel\/[a-z]{2}\/([^.?/#]+)/i);
      const slug   = slugM?.[1] || '';
      const hotelId= card.dataset.hotelid || card.dataset.hotelId || card.getAttribute('data-hotel-id') || '';
      const id     = slug || hotelId || name.toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,60);
      
      if (!id || seen.has(id)) return;
      seen.add(id);

      // Attempt to extract lat/lng from data attributes
      let lat = parseFloat(
        card.dataset.latitude || card.dataset.lat ||
        card.getAttribute('data-latitude') || card.getAttribute('data-lat') || ''
      ) || null;
      let lng = parseFloat(
        card.dataset.longitude || card.dataset.lon || card.dataset.lng ||
        card.getAttribute('data-longitude') || card.getAttribute('data-lon') || ''
      ) || null;

      // Fallback: search in links for lat/lng parameters inside this card
      if (!lat || !lng) {
        card.querySelectorAll('a[href]').forEach(a => {
          try {
            const linkHref = a.getAttribute('href') || '';
            const latM = linkHref.match(/[?&;](latitude|lat)=([-+]?\d+\.\d+)/i);
            const lngM = linkHref.match(/[?&;](longitude|lng|lon)=([-+]?\d+\.\d+)/i);
            if (latM && latM[2]) lat = parseFloat(latM[2]);
            if (lngM && lngM[2]) lng = parseFloat(lngM[2]);
          } catch(_) {}
        });
      }

      const priceEl = card.querySelector(
        '[data-testid="price-and-discounted-price"],[data-testid="price"],' +
        '[data-testid="current-price"],.fcf371ac98 .f19ed4bbe1,.prco-valign-middle-helper,' +
        '[class*="price"],[class*="Price"]'
      );
      const priceText = (priceEl?.textContent||'').replace(/[₹,\s€$£]/g,'');
      const priceMatch = priceText.match(/\d{3,7}/);
      const price = priceMatch ? parseInt(priceMatch[0]) : null;

      const scoreEl = card.querySelector(
        '[data-testid="review-score"] .a3b8729ab1,' +
        '[data-testid="review-score"] [class*="score"],' +
        '[data-testid="review-score-circle"],.bui-review-score__badge,' +
        '[class*="reviewScore"],[aria-label*="Scored"]'
      );
      const rating = parseFloat(scoreEl?.textContent?.trim() || '') || null;
      const revText  = card.querySelector('[data-testid="review-score"]')?.textContent || '';
      const revM     = revText.match(/([\d,]+)\s*review/i);
      const reviews  = revM ? parseInt(revM[1].replace(/,/g,'')) : null;

      const typeEl = card.querySelector(
        '[data-testid="property-type-badge"],[data-testid="accommodation-type"],' +
        '.a5a5a75131,[class*="PropertyType"],[class*="propertyType"]'
      );
      const type = typeEl?.textContent?.trim() || 'Property';

      const imgEl = card.querySelector('[data-testid="image"],img[src*="bstatic"],img[src*="booking"]');
      const image = imgEl?.src || imgEl?.getAttribute('data-src') || null;

      results.push({ id, slug, bookingHotelId:hotelId||null, name, url, price, rating, reviews, type, image, lat, lng });
    } catch(_) {}
  });

  // 3. Also pull from Booking.com window globals (legacy fallback)
  try {
    const globals = [
      window.__data,
      window.booking?.searchresults,
      window.__NEXT_DATA__?.props?.initialState?.searchResults,
      window.__NEXT_DATA__?.props?.pageProps?.initialState?.searchResults,
    ];
    for (const g of globals) {
      const arr = g?.hotels || g?.results || g?.hotelList || [];
      if (!Array.isArray(arr)) continue;
      arr.forEach(h => {
        const rawId = String(h.hotel_id ?? h.id ?? '');
        if (!rawId || seen.has(rawId)) return;
        const name = h.hotel_name || h.name || ''; if (!name) return;
        if (name.toLowerCase().startsWith(ownLow.split(/\s/)[0])) return;
        seen.add(rawId);
        const cc = (h.cc1||'in').toLowerCase();
        const slug = h.url_name || '';
        const url = slug ? `https://www.booking.com/hotel/${cc}/${slug}.html` : '';
        results.push({ id:slug||rawId, slug, bookingHotelId:rawId, name: cleanStr(name), url,
          price:h.min_total_price??null, rating:h.review_score??null,
          reviews:h.review_count??null, type:h.accommodation_type_name||'Property',
          image:null,
          lat:parseFloat(h.latitude??'')||null, lng:parseFloat(h.longitude??'')||null });
      });
    }
  } catch(_) {}

  return results;
};

// ── Dismiss cookie banners & Genius sign-in/overlay modals on Booking.com ─────
async function dismissBannersAndModals(page) {
  // 1. Dismiss cookie/GDPR banners
  await page.evaluate(() => {
    const selectors = [
      '#onetrust-accept-btn-handler',
      '[data-testid="accept-all-cookies"]',
      '[data-testid="accept-cookies"]',
      'button[id*="accept"]',
      '.cookie-banner button',
      '[aria-label*="Accept"]',
      '[class*="cookie"] button',
    ];
    for (const sel of selectors) {
      try { const el = document.querySelector(sel); if (el) { el.click(); return true; } } catch(_) {}
    }
    return false;
  }).catch(() => {});

  // 2. Dismiss sign-in popups and other overlay modals
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const selectors = [
        'button[aria-label="Dismiss sign-in info."]',
        'button[aria-label*="Dismiss sign-in"]',
        'button[aria-label*="Close"]',
        '.modal-mask button',
        '[class*="modal"] button[class*="close"]',
        '[class*="modal"] svg[class*="close"]',
        '[class*="Modal"] button[class*="Close"]',
        '[data-testid="signin-modal"] [aria-label*="Dismiss"]',
      ];
      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            el.click();
          }
        } catch (_) {}
      }
    });
  } catch (_) {}
}

// ── Automate Search Input Typing to Bypassing Redirect Blocks ─────────────────
async function automateSearch(page, query, emit, sleep) {
  emit({ type: 'status', message: `[City] Searching for "${query}"…` });
  try {
    emit({ type: 'status', message: '[City] Navigating to Booking.com homepage...' });
    await page.goto('https://www.booking.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissBannersAndModals(page);
    await sleep(1000);

    const searchInputSel = 'input[name="ss"], input[placeholder*="Where"], input[placeholder*="going"], input[type="search"]';
    emit({ type: 'status', message: '[City] Waiting for search input...' });
    await page.waitForSelector(searchInputSel, { timeout: 12000 });

    emit({ type: 'status', message: `[City] Typing query "${query}"...` });
    await page.click(searchInputSel);
    await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, searchInputSel);
    await page.type(searchInputSel, query, { delay: 100 });
    await sleep(2000);

    const dropdownOptionSel = '[data-testid="autocomplete-result"], [role="option"], ul li[class*="autocomplete"]';
    try {
      emit({ type: 'status', message: '[City] Checking for auto-complete dropdown...' });
      await page.waitForSelector(dropdownOptionSel, { timeout: 6000 });
      emit({ type: 'status', message: '[City] Dropdown found. Clicking option...' });
      await page.click(dropdownOptionSel);
    } catch (_) {
      emit({ type: 'status', message: '[City] Dropdown not found. Pressing Enter to search...' });
      await page.press(searchInputSel, 'Enter');
    }
    await sleep(2000);

    emit({ type: 'status', message: '[City] Triggering search...' });
    const searchBtnSel = 'button[type="submit"], [class*="searchbox-button"]';
    try {
      const btn = await page.$(searchBtnSel);
      if (btn) {
        await btn.click();
        emit({ type: 'status', message: '[City] Clicked search button.' });
      } else {
        await page.press(searchInputSel, 'Enter');
        emit({ type: 'status', message: '[City] Search button not found. Pressed Enter.' });
      }
    } catch (_) {
      await page.press(searchInputSel, 'Enter');
    }

    emit({ type: 'status', message: '[City] Waiting for navigation...' });
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
      emit({ type: 'status', message: `[City] Navigation wait finished (timed out or completed): ${e.message}` });
    });
    await sleep(5000);

    emit({ type: 'status', message: `[City] Checking for property cards on url: ${page.url()}` });
    const hasCards = await page.waitForSelector('[data-testid="property-card"],.sr_property_block', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    emit({ type: 'status', message: `[City] Property cards visible: ${hasCards}` });
    return hasCards;
  } catch (e) {
    emit({ type: 'status', message: `[City] Automation error: ${e.message}` });
    return false;
  }
}

// ── Scrape one search URL with full pagination + retry ────────────────────────
async function scrapeSearch(browser, searchUrl, label, ownName, intercepted, emit, sleep) {
  const scraped = new Map();
  const alreadyIntercepted = new Set(intercepted.keys());

  // Use the existing Chrome context (it has Booking.com cookies → no consent banners, no CAPTCHA)
  // A new page within the existing context is clean (no cross-tab contamination) but keeps cookies.
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  // Initialize session (skip for City search as it will navigate itself, and Area search as City already warmed it)
  if (label !== 'Area' && label !== 'City') {
    try {
      await page.goto('https://www.booking.com/', { waitUntil:'domcontentloaded', timeout:20000 });
      await dismissBannersAndModals(page);
      await sleep(500);
    } catch(e) {
      emit({ type:'status', message:`[${label}] Session init warning: ${e.message}` });
    }
  }

  // Response interceptor — captures Booking.com's internal hotel data API
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.includes('booking.com')) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const body = await response.json().catch(()=>null);
      if (body) parseHotelsFromResponse(body, intercepted);
    } catch(_) {}
  });

  // Extract rows-per-page from URL (defaults to 25 for Booking.com)
  const rowsMatch = searchUrl.match(/[?&]rows=(\d+)/);
  const rowsPerPage = rowsMatch ? parseInt(rowsMatch[1]) : 25;

  // 50 pages × 25 = 1,250 results — covers cities like Gurgaon (1,076 properties)
  const MAX_PAGES = label === 'City' ? 50 : 20;

  let resolvedSearchUrl = searchUrl;
  let loaded = false;

  const mergeUrlParams = (source, target) => {
    try {
      const sUrl = new URL(source);
      const tUrl = new URL(target);
      const keys = ['checkin', 'checkout', 'group_adults', 'no_rooms', 'selected_currency', 'group_children', 'order', 'dest_id', 'dest_type'];
      for (const k of keys) {
        const vals = sUrl.searchParams.getAll(k);
        if (vals.length > 0) {
          tUrl.searchParams.delete(k);
          vals.forEach(v => tUrl.searchParams.append(k, v));
        }
      }
      
      // Fallback for dest_id/dest_type if missing in target
      if (!tUrl.searchParams.has('dest_id')) {
        const cityMatch = source.match(/[?&]ss=([^&]+)/i);
        const city = cityMatch ? decodeURIComponent(cityMatch[1]).split(',')[0].trim().toLowerCase() : '';
        const fallback = CITY_DEST_IDS[city];
        if (fallback) {
          tUrl.searchParams.set('dest_id', fallback.dest_id);
          tUrl.searchParams.set('dest_type', fallback.dest_type);
        }
      }
      return tUrl.toString();
    } catch (_) {
      return target;
    }
  };

  if (label === 'City') {
    const cityQuery = searchUrl.match(/[?&]ss=([^&]+)/i)?.[1] ? decodeURIComponent(searchUrl.match(/[?&]ss=([^&]+)/i)[1]) : ownName.split(/\s/)[0];
    const ok = await automateSearch(page, cityQuery, emit, sleep);
    if (ok) {
      let resolved = page.url();
      resolved = resolved.replace(/[?&]offset=\d+/g, '').replace(/[?&]rows=\d+/g, '');
      resolved += (resolved.includes('?') ? '&' : '?') + `rows=${rowsPerPage}`;
      resolvedSearchUrl = mergeUrlParams(searchUrl, resolved);
      emit({ type:'status', message:`[${label}] Base URL resolved with dates: ${resolvedSearchUrl.slice(0, 90)}…` });
      
      // Navigate to the resolved search URL with checkin/checkout dates to bypass sticky modal overlays!
      try {
        await page.goto(resolvedSearchUrl, { waitUntil:'domcontentloaded', timeout:30000 });
        await dismissBannersAndModals(page);
        await sleep(600);
        
        const hasCards = await page.waitForSelector('[data-testid="property-card"],.sr_property_block', { timeout: 12000 })
          .then(() => true)
          .catch(() => false);
        
        if (hasCards) {
          loaded = true;
        } else {
          emit({ type:'status', message:`[${label}] No cards visible on resolved URL.` });
        }
      } catch (e) {
        emit({ type:'status', message:`[${label}] Navigation to resolved URL failed: ${e.message}` });
      }
    }

    // Direct-URL fallback: one attempt, then move on.
    //
    // Booking.com does not render server-side property cards for a text (`ss=`) search from this
    // client — verified against "Goa", "Candolim, Goa, India" and "Arpora", with and without a
    // dest_id: every one lands on a bare /searchresults.html shell with zero cards and no <h1>.
    // It is NOT specific to region destinations, which was the earlier theory. The lat/lng search
    // does work, so it carries discovery; this stays as a cheap single probe in case the text
    // route starts working again, and reports clearly when it does not so a scan is never
    // mistaken for a full-market sweep.
    if (!loaded) {
      const directUrl = mergeUrlParams(searchUrl, searchUrl);
      emit({ type:'status', message:`[${label}] Autocomplete route gave no cards — probing searchresults directly…` });
      try {
        await page.goto(directUrl, { waitUntil:'domcontentloaded', timeout:30000 });
        await dismissBannersAndModals(page);
        await sleep(600);
        const hasCards = await page.waitForSelector('[data-testid="property-card"],.sr_property_block', { timeout: 8000 })
          .then(() => true)
          .catch(() => false);
        const title = await page.title().catch(() => '');
        if (hasCards && !/captcha|robot|challenge|just a moment|verify|access denied/i.test(title)) {
          resolvedSearchUrl = directUrl;
          loaded = true;
          emit({ type:'status', message:`[${label}] Direct searchresults URL worked.` });
        } else {
          emit({ type:'status', message:`[${label}] Text search unavailable (Booking.com serves no cards for ss= queries) — relying on the coordinate search.` });
        }
      } catch (e) {
        emit({ type:'status', message:`[${label}] Direct URL nav error: ${e.message}` });
      }
    }
  } else {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(searchUrl, { waitUntil:'domcontentloaded', timeout:30000 });
        await dismissBannersAndModals(page);
        await sleep(400);

        const hasCards = await page.waitForSelector('[data-testid="property-card"],.sr_property_block', { timeout: 6000 })
          .then(() => true)
          .catch(() => false);

        const title = await page.title().catch(() => '');
        const isBlocked = /captcha|robot|challenge|just a moment|verify|access denied/i.test(title);
        const isHome = title.includes('Official site') || title.includes('The best hotels') || title === 'Booking.com';

        if (hasCards && !isBlocked && !isHome) {
          loaded = true;
          break;
        }

        emit({ type:'status', message:`[${label}] Redirect/blocked (attempt ${attempt}/2) — waiting 8s…` });
        await sleep(8000);
      } catch (e) {
        emit({ type:'status', message:`[${label}] Nav error: ${e.message}. Waiting 8s…` });
        await sleep(8000);
      }
    }
  }

  if (!loaded) {
    emit({ type:'status', message:`[${label}] Initial page load failed, stopping.` });
    await page.close();
    return scraped;
  }

  let pageNum = 0;
  let consecutiveEmpty = 0;

  while (pageNum < MAX_PAGES) {
    pageNum++;
    emit({ type:'status', message:`[${label}] Iteration ${pageNum} on URL: ${page.url()}` });

    // Scroll to trigger lazy loading
    for (let s = 0; s < 2; s++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(250);
    }
    await sleep(500);

    // Extract cards currently in DOM
    const cards = await page.evaluate(extractCards, ownName).catch(()=>[]);
    let added = 0;
    for (const c of cards) {
      if (!scraped.has(c.id)) {
        scraped.set(c.id, c);
        if (!alreadyIntercepted.has(c.id)) {
          added++;
        }
      }
      else if (c.lat && c.lng && !scraped.get(c.id).lat) {
        scraped.set(c.id, { ...scraped.get(c.id), lat:c.lat, lng:c.lng });
      }
    }

    emit({ type:'status', message:`[${label}] Loaded ${pageNum}: +${added} new → ${scraped.size} total (${intercepted.size} API)` });

    if (added === 0) {
      consecutiveEmpty++;
    } else {
      consecutiveEmpty = 0;
    }

    // Check if there is a next/load-more button
    const paginationControls = await page.evaluate(() => {
      const loadMoreBtn = Array.from(document.querySelectorAll('button, a')).find(b => {
        const txt = b.textContent.toLowerCase();
        return txt.includes('load more') || txt.includes('show more');
      });
      const nextBtn = document.querySelector(
        '[data-testid="pagination-next"]:not([disabled]),' +
        '.bui-pagination__next-arrow:not([disabled]),' +
        'a[aria-label="Next page"]:not([aria-disabled="true"]),' +
        'button[aria-label="Next page"]:not([disabled])'
      );
      return {
        hasLoadMore: !!loadMoreBtn,
        hasStandardNext: !!nextBtn
      };
    });

    if (paginationControls.hasLoadMore) {
      emit({ type:'status', message:`[${label}] Clicking "Load more results" button…` });
      const btnLocator = page.locator('button:has-text("Load more results"), button:has-text("Show more results"), a:has-text("Load more results"), a:has-text("Show more results")').first();
      await btnLocator.click().catch(() => {});
      await sleep(2000);
    } else if (paginationControls.hasStandardNext) {
      emit({ type:'status', message:`[${label}] Clicking standard next page button…` });
      const nextLocator = page.locator('[data-testid="pagination-next"], .bui-pagination__next-arrow, a[aria-label="Next page"], button[aria-label="Next page"]').first();
      await nextLocator.click().catch(() => {});
      await sleep(3000);
    } else {
      // Double check scroll
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1000);
      const retryLoadMore = await page.evaluate(() => {
        const loadMoreBtn = Array.from(document.querySelectorAll('button, a')).find(b => b.textContent.toLowerCase().includes('load more') || b.textContent.toLowerCase().includes('show more'));
        return !!loadMoreBtn;
      });
      if (retryLoadMore) {
        emit({ type:'status', message:`[${label}] "Load more results" visible after scrolling. Clicking…` });
        const btnLocator = page.locator('button:has-text("Load more results"), button:has-text("Show more results"), a:has-text("Load more results"), a:has-text("Show more results")').first();
        await btnLocator.click().catch(() => {});
        await sleep(2000);
      } else {
        emit({ type:'status', message:`[${label}] No more results controls found. Stopping loop.` });
        break;
      }
    }

    if (consecutiveEmpty >= 3) {
      emit({ type:'status', message:`[${label}] No new results found for 3 iterations. Stopping.` });
      break;
    }
  }

  await page.close(); // close the page only — don't close the shared context
  return scraped;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(CONFIG_FILE)) {
    emit({ type:'error', message:'config/properties.json not found.' }); process.exit(1);
  }
  let configProps = [];
  try { configProps = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')).properties || []; }
  catch(e) { emit({ type:'error', message:`Cannot read config: ${e.message}` }); process.exit(1); }

  const configProp = configProps.find(p => p.id === propId && p.type === 'own');
  if (!configProp) {
    const valid = configProps.filter(p=>p.type==='own').map(p=>p.id).join(', ');
    emit({ type:'error', message:`Property "${propId}" not found. Valid: ${valid}` }); process.exit(1);
  }

  // Own average price for scoring
  let ownAvgPrice = null;
  if (fs.existsSync(DASH_FILE)) {
    try {
      const dp = JSON.parse(fs.readFileSync(DASH_FILE,'utf8')).portfolio?.[propId];
      if (dp) {
        const rooms = Object.values(dp.rooms||{});
        const prim  = rooms.find(r=>r.primary)||rooms[0];
        if (prim?.observed) {
          const px = Object.values(prim.observed).filter(v=>v!=null);
          if (px.length) ownAvgPrice = Math.round(px.reduce((a,b)=>a+b,0)/px.length);
        }
      }
    } catch(_) {}
  }

  const propName = configProp.display;
  
  // Load area from property-meta.json
  const PROP_META_FILE = path.join(__dirname, 'data', 'property-meta.json');
  let area = '';
  try {
    const meta = JSON.parse(fs.readFileSync(PROP_META_FILE, 'utf8'))[propId];
    if (meta) area = meta.area || '';
  } catch (_) {}

  const city     = extractCity(propName, configProp.city, area);

  emit({ type:'status', message:`Full Market Scan: ${propName} (${city})` });

  // Own property coordinates
  let ownGeo = getCached(propId);
  if (!ownGeo && configProp.lat && configProp.lng) {
    ownGeo = { lat: configProp.lat, lng: configProp.lng };
  }
  if (!ownGeo) {
    emit({ type:'status', message:`Geocoding own property…` });
    ownGeo = await geocode(propId, `${propName}, India`);
  }
  const origin = ownGeo || { lat:20.5937, lng:78.9629 };
  emit({ type:'status', message:`Own coords: ${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)} | City: ${city}` });

  // Checkin/checkout dates (7 days out, 1 night stay)
  const ci = new Date(); ci.setDate(ci.getDate()+7);
  const co = new Date(ci); co.setDate(co.getDate()+1);
  const checkin  = ci.toISOString().slice(0,10);
  const checkout = co.toISOString().slice(0,10);
  const dateParams = `checkin=${checkin}&checkout=${checkout}&group_adults=2&no_rooms=1&selected_currency=INR`;

  // ── Search URLs ────────────────────────────────────────────────────────────
  // Booking.com reliably returns 25 per page regardless of rows= param
  const ROWS_PER_PAGE = 25;

  // Primary: city/destination name search — gets the complete market inventory
  const citySearchUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city)}&${dateParams}&rows=${ROWS_PER_PAGE}&order=popularity`;

  // Secondary: lat/lng search — catches nearby properties outside the city boundary
  const latLngSearchUrl = ownGeo
    ? `https://www.booking.com/searchresults.html?latitude=${origin.lat}&longitude=${origin.lng}&${dateParams}&rows=${ROWS_PER_PAGE}`
    : null;

  // ── Browser setup ──────────────────────────────────────────────────────────
  await ensureChrome();
  const browser = await chromium.connectOverCDP(CDP_URL);

  // Shared intercepted map (both searches feed into this)
  const intercepted = new Map();

  // ── Run searches ───────────────────────────────────────────────────────────
  emit({ type:'status', message:`Starting city search: "${city}, India"…` });
  const cityResults = await scrapeSearch(browser, citySearchUrl, 'City', propName, intercepted, emit, sleep);
  emit({ type:'status', message:`City search complete: ${cityResults.size} properties. API intercepted: ${intercepted.size}` });

  let latLngResults = new Map();
  if (latLngSearchUrl) {
    emit({ type:'status', message:`Starting lat/lng search near ${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)}…` });
    latLngResults = await scrapeSearch(browser, latLngSearchUrl, 'Area', propName, intercepted, emit, sleep);
    emit({ type:'status', message:`Lat/lng search complete: ${latLngResults.size} properties.` });

    // Optional: widen the net with offset coordinate probes. OFF by default.
    //
    // With text search unavailable (see the City stage), this is the only lever for breadth. But
    // it is a blunt one: probing 4 km around a Candolim property pulled the pool from 24 to 689
    // because one offset landed in a dense corridor and paginated 20 pages. That is not a
    // "nearby competitor" set — it is the regional market, it takes ~5x longer, and it puts
    // hundreds of pins on the map. The tight default is the right answer for dense leisure
    // markets, where the true substitutes genuinely are within a kilometre.
    // Enable deliberately when you want market breadth: --rings=4 [--ring-km=4]
    const OFFSET_KM = parseFloat(args['ring-km'] || '4');
    const RINGS     = parseInt(args.rings || '0', 10);
    if (RINGS > 0 && OFFSET_KM > 0) {
      const dLat = OFFSET_KM / 111;                                              // km per degree latitude
      const dLng = OFFSET_KM / (111 * Math.cos(origin.lat * Math.PI / 180));     // shrinks with latitude
      const points = [
        { lat: origin.lat + dLat, lng: origin.lng,        label: 'N' },
        { lat: origin.lat - dLat, lng: origin.lng,        label: 'S' },
        { lat: origin.lat,        lng: origin.lng + dLng, label: 'E' },
        { lat: origin.lat,        lng: origin.lng - dLng, label: 'W' },
      ].slice(0, RINGS);

      for (const pt of points) {
        const url = `https://www.booking.com/searchresults.html?latitude=${pt.lat}&longitude=${pt.lng}&${dateParams}&rows=${ROWS_PER_PAGE}`;
        const before = intercepted.size;
        try {
          const r = await scrapeSearch(browser, url, 'Area', propName, intercepted, emit, sleep);
          for (const [id, card] of r) if (!latLngResults.has(id)) latLngResults.set(id, card);
          emit({ type:'status', message:`  ${OFFSET_KM}km ${pt.label}: +${intercepted.size - before} via API, pool now ${latLngResults.size}` });
        } catch (e) {
          emit({ type:'status', message:`  ${OFFSET_KM}km ${pt.label} probe failed: ${e.message}` });
        }
      }
    }
  }

  // ── Merge all sources ──────────────────────────────────────────────────────
  const merged = new Map(intercepted); // API data has exact coords — use as base

  const mergeDom = (domMap) => {
    for (const [id, card] of domMap) {
      if (merged.has(id)) {
        const ex = merged.get(id);
        if (!ex.lat && card.lat)     ex.lat   = card.lat;
        if (!ex.lng && card.lng)     ex.lng   = card.lng;
        if (!ex.price && card.price) ex.price = card.price;
        if (!ex.url   && card.url)   ex.url   = card.url;
        if (!ex.rating && card.rating) ex.rating = card.rating;
      } else {
        merged.set(id, card);
      }
    }
  };
  mergeDom(cityResults);
  mergeDom(latLngResults);

  // Filter out the property being scanned, and tag any OTHER property from our own portfolio.
  //
  // Nearby portfolio properties legitimately show up in the search — properties 5 and 6 sit in the
  // same complex — and scoring them as competitors corrupts the analysis: a property ends up
  // rate-shopped against itself, skewing price index, rank and the suggestions engine. They stay in
  // fullMarket (useful map context) but are tagged so they can be excluded from the ranked
  // competitor list. Matching is by slug, the only reliable identity for a listing.
  const ownSlugs = new Map();                     // slug -> own property id
  for (const p of configProps) {
    if (p.type === 'own' && p.slug) ownSlugs.set(String(p.slug).toLowerCase(), p.id);
  }
  const slugOfCandidate = h => {
    const fromUrl = h.url && (String(h.url).match(/\/hotel\/[a-z]{2}\/([^.?/#]+)/i) || [])[1];
    return String(fromUrl || h.slug || '').toLowerCase();
  };

  const ownFirstWord = propName.toLowerCase().split(/[\s,\-]/)[0];
  const allRaw = [];
  let ownPortfolioSeen = 0;
  for (const h of merged.values()) {
    if (!h.name) continue;
    const s = slugOfCandidate(h);
    // The property being scanned: drop entirely
    if (s && s === String(configProp.slug || '').toLowerCase()) continue;
    if (!s && h.name.toLowerCase().startsWith(ownFirstWord)) continue;
    if (s && ownSlugs.has(s)) {
      allRaw.push({ ...h, isOwnPortfolio: true, ownPortfolioId: ownSlugs.get(s) });
      ownPortfolioSeen++;
      continue;
    }
    allRaw.push(h);
  }
  if (ownPortfolioSeen) {
    emit({ type: 'status', message: `${ownPortfolioSeen} nearby property(ies) from our own portfolio tagged and excluded from competitor ranking` });
  }

  emit({ type:'status', message:`Merged: ${allRaw.length} unique properties. Validating locations…` });

  // ── Score and rank setup ───────────────────────────────────────────────────
  const own = {
    propertyType: configProp.propertyType || 'property',
    beds:         configProp.beds   || null,
    rating:       configProp.rating || null,
    avgPrice:     ownAvgPrice       || null,
  };

  // ── Validate and geocode ───────────────────────────────────────────────────
  const validated  = [];
  const needGeocode = [];
  let geocodedCount = 0;

  const geocodeCandidates = [];

  for (const p of allRaw) {
    let { lat, lng } = p;
    if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
      const d = haversineDist(origin, { lat, lng });
      validated.push({ ...p, distance:parseFloat(d.toFixed(1)), geocoded:true, approximate:false });
      geocodedCount++;
      continue;
    }

    // Check if the property is a potential competitor candidate before Nominatim geocoding.
    // We mock its location as geocoded/approximate with no distance.
    const inferredType = inferPropertyType(p.type, p.name);
    const mockCandidate = { ...p, type: inferredType, geocoded: false, approximate: true, distance: null };
    const { score, reject } = computeRelevance(own, mockCandidate);

    // Only add to potential geocode candidates if not rejected and has medium/high score
    if (!reject && score >= 45) {
      geocodeCandidates.push({ p, score });
    } else {
      validated.push({ ...p, lat:null, lng:null, distance:null, geocoded:false, approximate:true });
    }
  }

  // Sort geocode candidates by preliminary score descending and cap at 40
  geocodeCandidates.sort((a, b) => b.score - a.score);
  const toGeocode = geocodeCandidates.slice(0, 40);
  const skipped = geocodeCandidates.slice(40);

  for (const item of toGeocode) {
    needGeocode.push(item.p);
  }
  for (const item of skipped) {
    validated.push({ ...item.p, lat:null, lng:null, distance:null, geocoded:false, approximate:true });
  }

  emit({ type:'status', message:`${validated.length} with Booking.com coords. Geocoding top ${needGeocode.length} potential competitors via cache/Nominatim…` });

  for (let i=0; i<needGeocode.length; i++) {
    const p = needGeocode[i];
    emit({ type:'progress', current:i+1, total:needGeocode.length, name:p.name });
    const cached = getCached(p.id);
    if (cached && !cached.approximate) {
      validated.push({ ...p, lat:cached.lat, lng:cached.lng, distance:parseFloat(haversineDist(origin,cached).toFixed(1)), geocoded:true, approximate:false });
      geocodedCount++;
      continue;
    }
    const geo = await geocode(p.id, `${p.name}, ${city}, India`, { rateLimitMs:1100 });
    if (geo) {
      const d = haversineDist(origin, geo);
      validated.push({ ...p, lat:geo.lat, lng:geo.lng, distance:parseFloat(d.toFixed(1)), geocoded:true, approximate:true });
      geocodedCount++;
    } else {
      // Keep even without coords — will show in list with warning
      validated.push({ ...p, lat:null, lng:null, distance:null, geocoded:false, approximate:true });
    }
  }

  emit({ type:'status', message:`Scoring ${validated.length} candidates…` });

  const enriched = validated.map(c => ({
    ...c, type:inferPropertyType(c.type, c.name), beds:null,
  }));

  // fullMarket = all candidates with scores (distance filter is generous for city search)
  const fullMarket = enriched.map(c => {
    const { score, confidence } = computeRelevance(own, { ...c, _maxDistKm:maxDistKm });
    return { ...c, relevanceScore:score, confidence };
  });

  // ranked results = competitor candidates (tighter filter)
  const ranked = rankCandidates(configProp, ownAvgPrice, enriched, maxDistKm);

  // ── Save — cumulative merge (never lose previously discovered properties) ──
  let disc = {};
  if (fs.existsSync(DISC_FILE)) {
    try { disc = JSON.parse(fs.readFileSync(DISC_FILE,'utf8')); } catch(_) {}
  }

  const now          = new Date().toISOString();
  
  // Look for own property's slug in this scan's fullMarket to find ground-truth Booking.com coordinates
  const ownSlug = configProp.slug;
  const ownInMarket = fullMarket.find(p => p.slug === ownSlug || (p.url && p.url.includes(ownSlug)));
  if (ownInMarket && ownInMarket.lat && ownInMarket.lng) {
    emit({ type:'status', message:`[Alignment] Found own property ground-truth coordinates: ${ownInMarket.lat.toFixed(6)}, ${ownInMarket.lng.toFixed(6)}` });
    origin.lat = ownInMarket.lat;
    origin.lng = ownInMarket.lng;
    
    // Update geo-cache so getCached returns the aligned coords next time
    try {
      const geoCacheFile = path.join(__dirname, 'data', 'geo-cache.json');
      if (fs.existsSync(geoCacheFile)) {
        const gc = JSON.parse(fs.readFileSync(geoCacheFile, 'utf8'));
        gc[propId] = { lat: origin.lat, lng: origin.lng, approximate: false, source: 'booking_results' };
        fs.writeFileSync(geoCacheFile, JSON.stringify(gc, null, 2));
      }
    } catch (_) {}
    
    // Update config/properties.json directly as well.
    //
    // Tracked read/write: this rewrites the WHOLE file to change two numbers, so if anything else
    // (a dashboard action, another script) wrote config between the read and the write, those
    // changes would be silently discarded. The window is short but a scan runs for minutes while a
    // live dashboard is often open beside it. On a conflict the coordinates are skipped rather than
    // clobbering someone's edit — they are re-derived on the next scan anyway.
    try {
      const cpT = readTracked(CONFIG_FILE);
      const cpProp = cpT.data?.properties?.find(p => p.id === propId && p.type === 'own');
      if (cpProp) {
        cpProp.lat = origin.lat;
        cpProp.lng = origin.lng;
        try { writeIfUnchanged(cpT, cpT.data); }
        catch (e) {
          if (e.code === 'ESTALE') emit({ type:'status', message:'config changed elsewhere — skipped writing coordinates (no data overwritten)' });
          else throw e;
        }
      }
    } catch (_) {}
  }

  const existingEntry = disc[propId] || {};

  // Build the persistent map from the previous cumulative pool. `fullMarket` is the canonical
  // key; `allDiscovered` is only read here so caches written before it was dropped still load.
  //
  // LIFECYCLE COUNTERS — `missedScans` is incremented for every known property this scan did NOT
  // return, and reset to 0 for those it did. It is a *candidate* signal for delisting and nothing
  // more: this scan probes a single night 7 days out, and Booking.com's search omits properties
  // with no availability for the probed dates, so a sold-out property is absent for exactly the
  // same reason a delisted one is. (19 of 62 tracked competitors are sold out across all 30
  // nights right now — a naive "absent means gone" rule would delist most of them.) The text
  // search stage is also intermittent, which swings the pool by 4x on its own. Confirmation is
  // therefore done by sync-inventory.js, which fetches the property's own page: a live listing
  // returns HTTP 200 even when fully sold out, a removed one returns 404.
  //
  // SCOPE MATTERS AS MUCH AS ABSENCE. A scan's reach varies enormously run to run: when the text
  // stage fires it sweeps the whole region, when it doesn't the coordinate search covers only the
  // immediate area. Property 1 went 24 → 847 on a regional sweep and then reported **763 absent**
  // on the very next area-only scan — those 763 were not gone, they were simply outside what this
  // scan looked at (missed p50 8.1 km / max 67.9 km, against a found p90 of 10.6 km). Counting
  // those as misses would march hundreds of live listings toward a delist check every run.
  //
  // So a miss is only counted for properties this scan could plausibly have seen: within the
  // distance band it actually returned. Anything beyond that is out of scope and its counter is
  // left untouched. Property 3 shows the other side — all 12 of its misses sit at 0.0 km, well
  // in scope, and are real candidates (co-located units that were sold out).
  const foundDists = fullMarket.map(p => p.distance).filter(x => x != null).sort((a,b) => a-b);
  const scanReachKm = foundDists.length
    ? Math.max(2, foundDists[Math.floor(foundDists.length * 0.9)])   // p90, with a 2 km floor
    : Infinity;                                                       // no distances: treat all as in scope

  const cumulativeMap = {};
  let outOfScopeCount = 0;
  for (const p of existingEntry.fullMarket || existingEntry.allDiscovered || []) {
    // distance unknown ⇒ assume in scope; it will be confirmed against its own page if it persists.
    const inScope = p.distance == null || p.distance <= scanReachKm;
    if (!inScope) outOfScopeCount++;
    cumulativeMap[p.id] = {
      ...p,
      lastScanFound: false,
      lastScanInScope: inScope,
      missedScans: inScope ? (p.missedScans || 0) + 1 : (p.missedScans || 0),
      status: p.status || 'active',
    };
  }

  // Merge this scan's fullMarket into the cumulative map
  for (const p of fullMarket) {
    if (!cumulativeMap[p.id]) {
      // New property — never seen before
      cumulativeMap[p.id] = {
        ...p, firstSeenAt: now, lastSeenAt: now, lastScanFound: true,
        missedScans: 0, status: 'active',
      };
    } else {
      // Already known — update with fresher/better data, keep firstSeenAt
      const ex = cumulativeMap[p.id];
      cumulativeMap[p.id] = {
        ...ex,
        // Prefer exact coords over approximate
        lat:          (p.lat  && !p.approximate) ? p.lat  : (ex.lat  || p.lat),
        lng:          (p.lng  && !p.approximate) ? p.lng  : (ex.lng  || p.lng),
        approximate:  (p.lat  && !p.approximate) ? false  : ex.approximate,
        geocoded:     p.geocoded || ex.geocoded,
        distance:     p.distance ?? ex.distance,
        // Keep best available metadata
        price:        p.price   || ex.price,
        rating:       p.rating  || ex.rating,
        reviews:      Math.max(p.reviews || 0, ex.reviews || 0) || null,
        type:         p.type    || ex.type,
        url:          p.url     || ex.url,
        relevanceScore: p.relevanceScore ?? ex.relevanceScore,
        confidence:   p.confidence || ex.confidence,
        lastSeenAt:   now,
        lastScanFound: true,
        lastScanInScope: true,
        // Seen again: the absence streak is broken. A property that had been confirmed delisted
        // and has genuinely come back is relisted rather than left in a contradictory state.
        missedScans:  0,
        status:       'active',
        relistedAt:   ex.status === 'delisted' ? now : ex.relistedAt,
        delistedAt:   ex.status === 'delisted' ? null : ex.delistedAt,
      };
    }
  }

  const cumulativeAll = Object.values(cumulativeMap);

  // Properties added in this scan
  const newSince = cumulativeAll.filter(p => p.firstSeenAt === now).map(p => p.id);
  // Absent this scan — reported so a scan's output shows churn in both directions, not just
  // arrivals. These are candidates for delisting, NOT confirmed departures: see the note above.
  // Only in-scope absences are reported: an out-of-scope property was never looked for.
  const missingSince = cumulativeAll
    .filter(p => !p.lastScanFound && p.lastScanInScope !== false && p.status === 'active')
    .map(p => ({ id: p.id, name: p.name, missedScans: p.missedScans, lastSeenAt: p.lastSeenAt }));
  const relisted = cumulativeAll.filter(p => p.relistedAt === now).map(p => p.id);

  // Re-rank the full cumulative list so the results panel reflects everything
  const cumulativeEnriched = cumulativeAll.map(c => ({
    ...c, type: inferPropertyType(c.type, c.name), beds: c.beds || null,
  }));
  const cumulativeRanked = rankCandidates(configProp, ownAvgPrice, cumulativeEnriched, maxDistKm);

  // NOTE: no `allDiscovered` key. It used to be written as an "explicit alias" holding the
  // very same array as `fullMarket`, so every candidate was serialised twice — 21% of a cache
  // that had reached 253 MB and is JSON.parse'd whole by four scripts. Both readers
  // (the merge above, and /api/discover/status) already fall back, so it is simply gone.
  disc[propId] = {
    fetchedAt:     now,
    propName, city, ownCoords: origin, maxDistKm, ownAvgPrice,
    results:       cumulativeRanked,   // ranked from cumulative pool
    fullMarket:    cumulativeAll,      // ALL ever discovered (cumulative)
    newSince,                          // IDs added this scan
    missingSince,                      // absent this scan — delist CANDIDATES, not departures
    relisted,                          // previously-delisted IDs that reappeared
    selected:      existingEntry.selected || [],
    scanCount:     (existingEntry.scanCount || 0) + 1,
    firstScanAt:   existingEntry.firstScanAt || now,
  };
  // Retire the alias from every other entry too, so one scan shrinks the whole file instead
  // of leaving the duplicate behind on properties that happen not to be re-scanned.
  for (const e of Object.values(disc)) delete e.allDiscovered;
  fs.mkdirSync(path.dirname(DISC_FILE), { recursive:true });
  fs.writeFileSync(DISC_FILE, JSON.stringify(disc, null, 2));

  const hC = cumulativeRanked.filter(r=>r.confidence==='high').length;
  const mC = cumulativeRanked.filter(r=>r.confidence==='medium').length;
  const gone = missingSince.length;
  const reach = Number.isFinite(scanReachKm) ? scanReachKm.toFixed(1) + 'km' : 'unbounded';
  const msg = `${cumulativeRanked.length} competitors (${hC} high, ${mC} med) · ${cumulativeAll.length} total `
            + `(${newSince.length} new, ${gone} absent in-scope`
            + `${outOfScopeCount ? ', ' + outOfScopeCount + ' out of scope (>' + reach + ')' : ''}`
            + `${relisted.length ? ', ' + relisted.length + ' relisted' : ''} this scan)`;
  emit({ type:'done', count:cumulativeRanked.length, total:cumulativeAll.length,
         newCount:newSince.length, missingCount:gone, outOfScopeCount,
         scanReachKm: Number.isFinite(scanReachKm) ? +scanReachKm.toFixed(2) : null,
         relistedCount:relisted.length,
         geocoded:geocodedCount, message:msg });
  process.exit(0);
}

main().catch(e => {
  emit({ type:'error', message:e.message + '\n' + (e.stack||'') });
  process.exit(1);
});
