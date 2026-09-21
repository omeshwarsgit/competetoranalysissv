'use strict';
/**
 * lib/geocode.js — Shared geocoding with persistent file cache
 * Uses Nominatim (OpenStreetMap) with 1 req/s rate-limit.
 * Cache stored in data/geo-cache.json.
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const GEO_CACHE_FILE = process.env.GEO_CACHE_FILE ||
  path.join(__dirname, '..', 'data', 'geo-cache.json');

// ── In-process cache (hot layer over the JSON file) ──────────────────────────
let _cache = null;

function loadCache() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8')); }
  catch (_) { _cache = {}; }
  return _cache;
}

function saveCache() {
  fs.mkdirSync(path.dirname(GEO_CACHE_FILE), { recursive: true });
  fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(_cache, null, 2));
}

function invalidateCache() { _cache = null; }

// ── Nominatim HTTP call ───────────────────────────────────────────────────────
function nominatimRequest(query) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=in`;
    const options = {
      headers: {
        'User-Agent': 'StayVista-Competitor-Monitor/2.0 (contact@stayvista.com)',
        'Accept-Language': 'en',
      },
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j[0]) {
            resolve({ lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), displayName: j[0].display_name });
          } else {
            resolve(null);
          }
        } catch (_) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Public: geocode with caching ─────────────────────────────────────────────
async function geocode(id, query, { skipCache = false, rateLimitMs = 1150 } = {}) {
  const cache = loadCache();

  if (!skipCache && cache[id] && !cache[id].approximate) {
    return cache[id];
  }

  const result = await nominatimRequest(query);
  await sleep(rateLimitMs);

  if (result) {
    cache[id] = { lat: result.lat, lng: result.lng, approximate: false, source: 'nominatim' };
    saveCache();
    return cache[id];
  }
  return null;
}

// ── Nominatim reverse lookup ──────────────────────────────────────────────────
function reverseRequest(lat, lng) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}`
              + `&format=json&zoom=14&addressdetails=1`;
    const options = {
      headers: {
        'User-Agent': 'StayVista-Competitor-Monitor/2.0 (contact@stayvista.com)',
        'Accept-Language': 'en',
      },
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

/**
 * Coordinates -> a human locality ("Candolim", "Anjuna").
 *
 * Booking.com's JSON-LD `addressLocality` is unreliable for holiday lets — it often carries
 * the street or even the building name ("monash kushal resorts 401"), which is useless as a
 * city for search, display and reporting. Reverse geocoding the coordinates gives a real
 * place name. Fields are tried most-specific first, because a Goa villa's meaningful locality
 * is the village/suburb, not the district.
 *
 * @returns {Promise<{city: string|null, district: string|null, state: string|null}>}
 */
async function reverseGeocode(lat, lng, { rateLimitMs = 1150 } = {}) {
  const j = await reverseRequest(lat, lng);
  await sleep(rateLimitMs);
  if (!j || !j.address) return { city: null, district: null, state: null };
  const a = j.address;
  const city = a.village || a.suburb || a.town || a.city || a.municipality
            || a.city_district || a.county || null;
  return {
    city,
    district: a.state_district || a.county || null,
    state:    a.state || null,
  };
}

// ── Public: get from cache only (no network) ─────────────────────────────────
function getCached(id) {
  return loadCache()[id] || null;
}

// ── Public: save manually-placed coords ──────────────────────────────────────
function saveManual(id, lat, lng) {
  const cache = loadCache();
  cache[id] = { lat, lng, approximate: false, source: 'manual' };
  saveCache();
}

// ── Public: get full cache object ────────────────────────────────────────────
function getAllCached() {
  return { ...loadCache() };
}

// ── Haversine distance (km) ───────────────────────────────────────────────────
function haversineDist(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

module.exports = { geocode, reverseGeocode, getCached, saveManual, getAllCached, haversineDist, invalidateCache };
