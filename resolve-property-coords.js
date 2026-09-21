/**
 * resolve-property-coords.js
 *
 * Gives every property in properties.csv an accurate Booking.com slug and coordinates.
 *
 * Why this exists: the sheet may hold booking.com/Share-xxxx short links, which carry no
 * hotel slug. Without a slug import-properties.js rejects the row, refresh.js cannot build
 * a scrape URL, and the map has no location to plot. This resolves each link to its
 * canonical /hotel/<cc>/<slug> URL and reads the property's real latitude/longitude off the
 * page, so coordinates come from Booking.com itself rather than a Nominatim name guess.
 *
 * Two stages per row:
 *   1. Follow the link's redirects with plain fetch  -> canonical URL + slug
 *   2. Load that page in Chrome (cookies + JS) and parse JSON-LD / data-atlas-latlng -> lat,lng
 *      A bare fetch is not enough: Booking.com answers unauthenticated requests with a
 *      202 bot-check stub containing no coordinates.
 *
 * Writes: config/properties.json (slug, lat, lng, city, location, propertyType)
 *         data/geo-cache.json    (keyed by property id AND slug, as the rest of the code expects)
 *         data/property-meta.json
 *
 * Usage:
 *   node resolve-property-coords.js --dry-run     resolve and report, write nothing
 *   node resolve-property-coords.js               resolve and persist
 *   node resolve-property-coords.js --write-csv   also rewrite the CSV links to canonical URLs
 *   node resolve-property-coords.js --property=3  just one row
 *   node resolve-property-coords.js --force       re-resolve rows that already have coordinates
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ensureChrome, CDP_URL } = require('./lib/chrome');
const { reverseGeocode } = require('./lib/geocode');
const { readProperties, formatCSVLine, parseCSVLine, slugFromUrl } = require('./lib/csv-properties');
const { readTracked, writeIfUnchanged } = require('./lib/json-store');

const arg = n => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const has = n => process.argv.includes(`--${n}`);
const DRY       = has('dry-run');
const WRITE_CSV = has('write-csv');
// --links-only: run just the redirect follow that turns a booking.com/Share-xxxx link into a
// canonical hotel URL, and skip the browser + reverse-geocode stages. This is the mode
// import-properties.js delegates to, so a plain import can handle a share-link row without
// requiring Chrome — coordinates still come from a later full run or from discovery.
const LINKS_ONLY = has('links-only');
const FORCE     = has('force');
const ONLY      = arg('property');

const ROOT        = __dirname;
const CSV_FILE    = path.join(ROOT, 'properties.csv');
const CONFIG_FILE = path.join(ROOT, 'config', 'properties.json');
const GEO_FILE    = path.join(ROOT, 'data', 'geo-cache.json');
const META_FILE   = path.join(ROOT, 'data', 'property-meta.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The CSV contract lives in lib/csv-properties.js — see the header there. `readProperties`
// hands back the raw `lines` and column `index` as well as the parsed rows, which is what
// --write-csv needs to rewrite a single link in place without reformatting the sheet.
const slugOf = slugFromUrl;

// ── Stage 1: resolve a share link to its canonical hotel URL ─────────────────
async function resolveLink(url) {
  if (slugOf(url)) return { url, slug: slugOf(url), resolved: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' } });
      try { await r.body?.cancel?.(); } catch (_) {}
      const slug = slugOf(r.url);
      if (slug) return { url: r.url.split('?')[0], slug, resolved: true };
      return { url: null, slug: null, resolved: false, error: `redirect gave no hotel slug (${r.status})` };
    } catch (e) {
      if (attempt === 2) return { url: null, slug: null, resolved: false, error: e.message };
      await sleep(1200 * (attempt + 1));
    }
  }
}

// ── Stage 2: read coordinates off the rendered page ──────────────────────────
function parseGeo(html) {
  const out = { lat: null, lng: null, city: null, area: null, type: null, name: null, stars: null };

  for (const [, json] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const obj = JSON.parse(json);
      for (const it of (Array.isArray(obj) ? obj : [obj])) {
        if (!it || typeof it !== 'object') continue;
        if (it.geo && it.geo.latitude != null) {
          out.lat = parseFloat(it.geo.latitude);
          out.lng = parseFloat(it.geo.longitude);
        }
        if (it.name && !out.name) out.name = String(it.name).trim();
        if (it.address) {
          out.city = out.city || it.address.addressLocality || it.address.addressRegion || null;
          out.area = out.area || it.address.streetAddress || null;
        }
        if (it['@type'] && !out.type) out.type = it['@type'];
        if (it.starRating?.ratingValue && !out.stars) out.stars = parseFloat(it.starRating.ratingValue);
      }
    } catch (_) {}
  }

  if (out.lat == null) {
    const m = html.match(/data-atlas-latlng="([0-9.-]+),([0-9.-]+)"/i);
    if (m) { out.lat = parseFloat(m[1]); out.lng = parseFloat(m[2]); }
  }
  if (out.lat == null) {
    const m = html.match(/"latitude"\s*:\s*([-\d.]+)[\s\S]{0,200}?"longitude"\s*:\s*([-\d.]+)/);
    if (m) { out.lat = parseFloat(m[1]); out.lng = parseFloat(m[2]); }
  }
  if (!out.name) {
    const m = html.match(/<h2[^>]*class="[^"]*pp-header__name[^"]*"[^>]*>([^<]+)<\/h2>/i)
           || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (m) out.name = m[1].trim();
  }
  const valid = Number.isFinite(out.lat) && Number.isFinite(out.lng)
             && Math.abs(out.lat) <= 90 && Math.abs(out.lng) <= 180
             && !(out.lat === 0 && out.lng === 0);
  return valid ? out : { ...out, lat: null, lng: null };
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  const { lines, index, properties } = readProperties(CSV_FILE);
  const urlIdx = index.url;
  if (index.id < 0 || urlIdx < 0) throw new Error('properties.csv is missing a Property ID or Booking.com Link column.');

  const rows = properties
    .filter(p => !ONLY || p.id === ONLY)
    .map(p => ({ id: p.id, line: p.line, name: p.name, rawUrl: p.url }));
  if (!rows.length) { console.log('\n  Nothing to resolve.\n'); return; }

  // Tracked read: stages 2 and 3 below drive a browser and geocode for minutes before this is
  // written back, so a dashboard edit in the meantime would otherwise be silently discarded.
  const cfgT   = readTracked(CONFIG_FILE);
  const cfg    = cfgT.data;
  const cfgOwn = new Map(cfg.properties.filter(p => p.type === 'own').map(p => [String(p.id), p]));
  const geo    = (() => { try { return JSON.parse(fs.readFileSync(GEO_FILE, 'utf8')); } catch (_) { return {}; } })();
  const meta   = (() => { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (_) { return {}; } })();

  // In --links-only mode the question is purely "does this row's link yield a slug?" — a row
  // that already has a canonical URL needs nothing, regardless of whether it has coordinates.
  const todo = LINKS_ONLY
    ? rows.filter(r => FORCE || !slugOf(r.rawUrl))
    : rows.filter(r => {
        const e = cfgOwn.get(r.id);
        return FORCE || !e || e.lat == null || e.lng == null || !e.slug;
      });
  console.log(`\n  ${rows.length} propert${rows.length === 1 ? 'y' : 'ies'} in the sheet · ${todo.length} needing ${LINKS_ONLY ? 'link resolution' : 'resolution'}`);
  if (!todo.length) {
    console.log(LINKS_ONLY ? '  Every link is already canonical.\n' : '  All resolved already. Pass --force to redo.\n');
    return;
  }

  // Stage 1 — link resolution (no browser needed)
  console.log('\n  Resolving links…');
  for (const r of todo) {
    const res = await resolveLink(r.rawUrl);
    r.url = res.url; r.slug = res.slug; r.resolvedFromShare = res.resolved; r.linkError = res.error;
    console.log(`    ${r.id.padEnd(5)} ${res.slug ? (res.resolved ? '→ ' : '  ') + res.slug : '✗ ' + (res.error || 'no slug')}`);
    await sleep(400);
  }

  // Stage 2 — coordinates, one browser for all rows
  const withSlug = todo.filter(r => r.slug);
  if (withSlug.length && !LINKS_ONLY) {
    console.log('\n  Reading coordinates from Booking.com…');
    await ensureChrome();
    const browser = await chromium.connectOverCDP(CDP_URL);
    const ctx  = browser.contexts()[0];
    let page = ctx.pages().find(p => /booking\.com/.test(p.url())) || await ctx.newPage();
    for (const r of withSlug) {
      try {
        await page.goto(`https://www.booking.com/hotel/in/${r.slug}.en-gb.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1800);
        const html = await page.content();
        if (/Security Verification|captcha/i.test(html)) { r.geoError = 'bot challenge'; console.log(`    ${r.id.padEnd(5)} ⚠ challenge — skipped`); await sleep(4000); continue; }
        const g = parseGeo(html);
        if (g.lat == null) { r.geoError = 'no coordinates on page'; console.log(`    ${r.id.padEnd(5)} ✗ no coordinates found`); continue; }
        r.geo = g;
        console.log(`    ${r.id.padEnd(5)} ${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}  ${(g.city || '').slice(0, 28)}`);
      } catch (e) {
        r.geoError = e.message;
        console.log(`    ${r.id.padEnd(5)} ✗ ${e.message.slice(0, 60)}`);
      }
      await sleep(600);
    }
    await browser.close();
  }

  // Stage 3 — turn coordinates into a real locality.
  // Booking.com's addressLocality is unreliable for holiday lets: it frequently returns the
  // street or building ("monash kushal resorts 401"), which is worthless as a city for the
  // sidebar, the Sheets City column and discover.js's city search. Reverse geocoding the
  // coordinates we just captured gives an actual place name.
  const geoOk = todo.filter(r => r.geo);
  if (geoOk.length) {
    console.log('\n  Resolving localities from coordinates…');
    for (const r of geoOk) {
      const rev = await reverseGeocode(r.geo.lat, r.geo.lng);
      if (rev.city) {
        r.locality = rev.city;
        r.district = rev.district;
        r.state    = rev.state;
        console.log(`    ${r.id.padEnd(5)} ${rev.city}${rev.district && rev.district !== rev.city ? ', ' + rev.district : ''}`);
      } else {
        console.log(`    ${r.id.padEnd(5)} ⚠ no locality found — keeping "${r.geo.city || '(none)'}"`);
      }
    }
  }

  // Persist ------------------------------------------------------------------
  let updatedCfg = 0, updatedGeo = 0;
  for (const r of todo) {
    if (!r.slug) continue;
    let entry = cfgOwn.get(r.id);
    if (!entry) {
      entry = { id: r.id, type: 'own', display: r.name || r.id, country: 'IN', competitors: [], deal: 0, beds: 1, pax: 2, amenities: [] };
      cfg.properties.push(entry);
      cfgOwn.set(r.id, entry);
    }
    entry.slug = r.slug;
    if (r.url) entry.sourceUrl = r.url;
    if (r.name) entry.display = r.name;
    if (r.geo) {
      entry.lat = r.geo.lat;
      entry.lng = r.geo.lng;
      // Reverse-geocoded locality wins; Booking.com's addressLocality is the fallback, and the
      // street address it often returns is at least kept separately as `address`.
      const locality = r.locality || r.geo.city || null;
      if (locality) { entry.city = locality; entry.location = locality; }
      if (r.district) entry.district = r.district;
      if (r.state)    entry.state    = r.state;
      if (r.geo.city && r.geo.city !== locality) entry.address = r.geo.city;
      if (r.geo.area) entry.street = r.geo.area;
      if (r.geo.type) entry.propertyType = /villa/i.test(r.geo.type) ? 'villa'
                                        : /apartment|residence/i.test(r.geo.type) ? 'serviced_apartment'
                                        : /resort/i.test(r.geo.type) ? 'resort'
                                        : /hotel/i.test(r.geo.type) ? 'hotel' : (entry.propertyType || 'property');
      geo[r.id]   = { lat: r.geo.lat, lng: r.geo.lng, approximate: false, source: 'booking_property_page' };
      geo[r.slug] = { lat: r.geo.lat, lng: r.geo.lng, approximate: false, source: 'booking_property_page' };
      // import-properties.js derives an own property's location from propMeta.city when the CSV
      // Location column is blank, so the resolved locality must land here — not Booking.com's
      // addressLocality, or a re-import silently reverts city/location to a street address.
      meta[r.id]  = { stars: r.geo.stars, type: r.geo.type, city: locality, area: r.geo.area,
                      bookingLocality: r.geo.city || null,
                      district: r.district || null, state: r.state || null,
                      lat: r.geo.lat, lon: r.geo.lng, slug: r.slug, updatedAt: new Date().toISOString() };
      updatedGeo++;
    }
    updatedCfg++;
  }

  if (!DRY) {
    cfg.updatedAt = new Date().toISOString();
    const write = (p, o) => { const t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, p); };
    writeIfUnchanged(cfgT, cfg);   // aborts instead of clobbering a concurrent edit
    write(GEO_FILE, geo);
    write(META_FILE, meta);

    if (WRITE_CSV) {
      let changed = 0;
      for (const r of todo) {
        if (!r.url || !r.resolvedFromShare) continue;
        const v = parseCSVLine(lines[r.line]);
        v[urlIdx] = r.url;
        lines[r.line] = formatCSVLine(v);
        changed++;
      }
      if (changed) {
        try {
          fs.writeFileSync(CSV_FILE, lines.join('\n'));
          console.log(`\n  ✓ properties.csv: ${changed} link(s) rewritten to canonical hotel URLs`);
        } catch (e) {
          console.log(`\n  ⚠ Could not rewrite properties.csv (${e.code || e.message}).`);
          console.log('    It is probably open in Excel — close it and re-run with --write-csv.');
        }
      }
    }
  }

  // Report -------------------------------------------------------------------
  const ok      = todo.filter(r => r.geo);
  const noCoord = todo.filter(r => r.slug && !r.geo);
  const noSlug  = todo.filter(r => !r.slug);
  console.log(`\n  ${DRY ? 'DRY RUN — nothing written' : 'Written'}`);
  if (LINKS_ONLY) {
    // Reporting "0 with accurate coordinates" here would read as a failure, when in this mode
    // the browser stage was skipped on purpose.
    console.log(`    ${todo.length - noSlug.length} link(s) resolved to a canonical hotel URL`);
    if (noSlug.length) console.log(`    ${noSlug.length} unresolvable link(s): ${noSlug.map(r => r.id).join(', ')}`);
    if (!DRY) console.log(`    config entries updated: ${updatedCfg} · coordinates skipped (--links-only)`);
    console.log('');
    return;
  }
  console.log(`    ${ok.length} with accurate coordinates`);
  if (noCoord.length) console.log(`    ${noCoord.length} resolved but no coordinates: ${noCoord.map(r => r.id).join(', ')}`);
  if (noSlug.length)  console.log(`    ${noSlug.length} unresolvable link(s): ${noSlug.map(r => r.id).join(', ')}`);
  if (!DRY) console.log(`    config entries updated: ${updatedCfg} · geo-cache entries: ${updatedGeo}`);
  if (ok.length && !DRY) console.log('\n  Next: node refresh.js   to scrape prices for these properties.\n');
  else console.log('');
})().catch(e => {
  if (e.code === 'ESTALE') { console.error('\n  ABORTED: ' + e.message + '\n'); process.exit(3); }
  console.error('\n  FAILED:', e.message, '\n');
  process.exit(1);
});
