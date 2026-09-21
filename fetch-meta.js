/**
 * fetch-meta.js
 * Scrapes Booking.com property pages to extract metadata:
 * star rating, property type, city, area, coordinates.
 * Saves to data/property-meta.json.
 *
 * Usage:
 *   node fetch-meta.js                     — scrape all properties
 *   node fetch-meta.js --property=<id>     — scrape one property
 *   node fetch-meta.js --url=<booking-url> — scrape any URL and return JSON
 */
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');

const CDP_URL        = 'http://127.0.0.1:9222';
const CHROME         = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const META_OUT       = path.join(__dirname, 'data', 'property-meta.json');

// ── Parse args ────────────────────────────────────────────────────────────────
const propArg = process.argv.find(a => a.startsWith('--property='));
const urlArg  = process.argv.find(a => a.startsWith('--url='));
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const targetPropId = propArg ? propArg.replace('--property=', '') : null;
const targetUrl    = urlArg  ? urlArg.replace('--url=', '')  : null;
const targetLimit = limitArg ? parseInt(limitArg.replace('--limit=', '')) : null;

// ── Extract slug from Booking.com URL ────────────────────────────────────────
function extractSlug(url) {
  const m = url.match(/booking\.com\/hotel\/[a-z]{2}\/([^.?/]+)/i);
  return m ? m[1] : null;
}
function toKey(slug) { return slug.replace(/-/g, '_'); }

// ── Load all known slugs from config/properties.json ────────────────────────
function loadSlugs() {
  try {
    const cfgPath = path.join(__dirname, 'config', 'properties.json');
    const { properties } = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const slugs = {};
    for (const p of properties) {
      if (p.type === 'own') {
        slugs[p.id] = p.slug;
      }
    }
    return slugs;
  } catch (err) {
    console.error('Failed to load config/properties.json:', err.message);
    return {};
  }
}


// ── Parse metadata from Booking.com property page HTML ──────────────────────
function parseMeta(html, slug) {
  const result = { stars: null, type: null, city: null, area: null, lat: null, lon: null };

  // 1. JSON-LD block — most reliable source
  const jldMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, json] of jldMatches) {
    try {
      const obj = JSON.parse(json);
      const items = Array.isArray(obj) ? obj : [obj];
      for (const item of items) {
        if (item['@type'] === 'Hotel' || item['@type'] === 'LodgingBusiness' || item['@type'] === 'Resort') {
          if (item.starRating?.ratingValue) result.stars = parseFloat(item.starRating.ratingValue);
          result.type = item['@type'];
          if (item.address) {
            result.city = item.address.addressLocality || item.address.addressRegion || null;
            result.area = item.address.streetAddress || null;
          }
          if (item.geo) { result.lat = item.geo.latitude; result.lon = item.geo.longitude; }
        }
      }
    } catch (_) {}
  }

  // 2. Star rating from HTML elements if JSON-LD missed it
  if (!result.stars) {
    const starM = html.match(/class="[^"]*b-star[^"]*"[^>]*data-rating="(\d+)"/i)
      || html.match(/"starRating"\s*:\s*(\d+)/i)
      || html.match(/(\d)\s*stars?\s*out\s*of\s*5/i)
      || html.match(/aria-label="(\d)\s*out\s*of\s*5\s*stars?"/i);
    if (starM) result.stars = parseInt(starM[1]);
  }

  // 3. Property type from page content
  if (!result.type) {
    if (/\bvilla\b/i.test(html))      result.type = 'Villa';
    else if (/\bapartment\b/i.test(html)) result.type = 'Apartment';
    else if (/\bresort\b/i.test(html))    result.type = 'Resort';
    else if (/\bhomestay\b/i.test(html))  result.type = 'Homestay';
    else if (/\bcottage\b/i.test(html))   result.type = 'Cottage';
    else if (/\bhouseboat\b/i.test(html)) result.type = 'Houseboat';
    else if (/\bhotel\b/i.test(html))     result.type = 'Hotel';
    else result.type = 'Property';
  }

  // 4. City from breadcrumb or meta tags
  if (!result.city) {
    const bcrumb = html.match(/breadcrumb[^>]*>[\s\S]{0,2000}?<\/[^>]+>/i)?.[0] || '';
    const cityM = bcrumb.match(/>([A-Z][a-zA-Z\s]+)<\/a>\s*<\/li>\s*<li[^>]*>\s*<a/);
    if (cityM) result.city = cityM[1].trim();
  }
  if (!result.city) {
    const metaCity = html.match(/<meta[^>]+property="og:locality"[^>]+content="([^"]+)"/i)
      || html.match(/<meta[^>]+name="(?:city|locality)"[^>]+content="([^"]+)"/i);
    if (metaCity) result.city = metaCity[1];
  }

  // 5. Coordinates from page scripts / attributes
  if (!result.lat) {
    const atlasM = html.match(/data-atlas-latlng="([0-9.-]+),([0-9.-]+)"/i);
    if (atlasM) {
      result.lat = parseFloat(atlasM[1]);
      result.lon = parseFloat(atlasM[2]);
    } else {
      const coordM = html.match(/"latitude"\s*:\s*([-\d.]+).*?"longitude"\s*:\s*([-\d.]+)/s)
        || html.match(/latitude=([0-9.-]+).*?longitude=([0-9.-]+)/i);
      if (coordM) { result.lat = parseFloat(coordM[1]); result.lon = parseFloat(coordM[2]); }
    }
  }

  return result;
}

// ── Ensure Chrome with debug port ────────────────────────────────────────────
async function ensureChrome() {
  const http = require('http');
  const ping = () => new Promise((res, rej) => {
    const req = http.get(CDP_URL + '/json', () => { res(); req.destroy(); });
    req.on('error', rej);
    req.setTimeout(1500, () => { req.destroy(); rej(); });
  });
  try { await ping(); return; } catch (_) {}
  const mainRunning = (() => { try { return execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' }).includes('chrome.exe'); } catch (_) { return false; } })();
  const profile = mainRunning ? 'C:\\temp\\chrome-cdp-meta' : 'C:\\temp\\chrome-cdp';
  spawn(CHROME, ['--headless=new', '--remote-debugging-port=9222', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'],
    { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { await ping(); return; } catch (_) {}
  }
  throw new Error('Chrome failed to start.');
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  await ensureChrome();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find(p => /booking\.com/.test(p.url()));
  if (!page) page = await ctx.newPage();

  // Get cookies
  let cookies = await ctx.cookies('https://www.booking.com');
  if (cookies.length < 3) {
    try {
      await page.goto('https://www.booking.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 2000));
      cookies = await ctx.cookies('https://www.booking.com');
    } catch (err) {
      console.warn('Navigation to fetch cookies failed:', err.message);
    }
  }

  // ── Single URL mode (used by add-competitor flow) ─────────────────────────
  if (targetUrl) {
    const slug = extractSlug(targetUrl);
    if (!slug) {
      console.error('Not a valid Booking.com hotel URL');
      await browser.close();
      process.exit(1);
    }
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const html = await page.content();
      const meta = parseMeta(html, slug);
      const nameM = html.match(/<h2[^>]*class="[^"]*pp-header__name[^"]*"[^>]*>([^<]+)<\/h2>/i)
        || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (nameM) meta.name = nameM[1].trim();
      meta.slug = slug;
      meta.key = toKey(slug);
      console.log(JSON.stringify(meta));
    } catch (err) {
      console.error('Failed to load page in browser:', err.message);
    }
    await browser.close();
    return;
  }

  // ── Batch mode — scrape all or one property ───────────────────────────────
  const existing = (() => { try { return JSON.parse(fs.readFileSync(META_OUT, 'utf8')); } catch (_) { return {}; } })();
  const slugs = loadSlugs();

  // Load config to filter for properties that are missing location
  const configPath = path.join(__dirname, 'config', 'properties.json');
  let tbdIds = new Set();
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const p of cfg.properties) {
      if (p.type === 'own' && (!p.location || p.location === 'TBD')) {
        tbdIds.add(p.id);
      }
    }
  } catch (_) {}

  let toScrape = {};
  if (targetPropId) {
    toScrape = { [targetPropId]: slugs[targetPropId] };
  } else {
    for (const [id, slug] of Object.entries(slugs)) {
      if (tbdIds.has(id)) {
        toScrape[id] = slug;
      }
    }
  }

  let keys = Object.keys(toScrape);
  if (targetLimit && !targetPropId) {
    keys = keys.slice(0, targetLimit);
    const newScrape = {};
    for (const k of keys) {
      newScrape[k] = toScrape[k];
    }
    toScrape = newScrape;
  }

  console.log(`Scraping metadata for ${keys.length} properties via Playwright…`);

  let done = 0;
  for (const [key, slug] of Object.entries(toScrape)) {
    const url = `https://www.booking.com/hotel/in/${slug}.en-gb.html`;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await new Promise(res => setTimeout(res, 2500));
      const html = await page.content();
      
      if (html.includes('captcha') || html.includes('Security Verification')) {
        console.warn(`  Challenge detected on ${key} (${slug})`);
        await new Promise(res => setTimeout(res, 5000));
        continue;
      }
      
      existing[key] = parseMeta(html, slug);
      existing[key].updatedAt = new Date().toISOString();
      done++;
    } catch (e) {
      console.warn(`  Skipped ${key}: ${e.message}`);
    }
    process.stdout.write(`  ${done}/${keys.length} done\r`);
    await new Promise(res => setTimeout(res, 500)); // gentle rate limiting
  }

  await browser.close();

  fs.mkdirSync(path.dirname(META_OUT), { recursive: true });
  fs.writeFileSync(META_OUT, JSON.stringify(existing, null, 2));
  console.log(`\n✓ Metadata saved for ${done} properties → data/property-meta.json`);
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
