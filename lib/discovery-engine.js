'use strict';
/**
 * lib/discovery-engine.js — Multi-factor competitor matching & scoring engine
 *
 * Replaces the single-dimension distance+rating relevance score with a
 * weighted, multi-signal scoring system that properly matches competitors
 * by property type, price tier, capacity, rating, and proximity.
 */

// ── Property-type compatibility matrix ───────────────────────────────────────
// How compatible is property type A as a competitor for type B?
// 1.0 = perfect match, 0.0 = not a competitor
const TYPE_COMPAT = {
  villa:             { villa: 1.0, luxury_villa: 0.9, heritage_villa: 0.8, resort: 0.4, serviced_apartment: 0.1, hotel: 0.2, glamping: 0.3, chalet: 0.7, homestay: 0.5, property: 0.5 },
  luxury_villa:      { villa: 0.9, luxury_villa: 1.0, heritage_villa: 0.8, resort: 0.5, serviced_apartment: 0.1, hotel: 0.2, glamping: 0.3, chalet: 0.7, homestay: 0.3, property: 0.5 },
  heritage_villa:    { villa: 0.8, luxury_villa: 0.8, heritage_villa: 1.0, resort: 0.5, serviced_apartment: 0.1, hotel: 0.3, glamping: 0.2, chalet: 0.6, homestay: 0.4, property: 0.5 },
  resort:            { villa: 0.4, luxury_villa: 0.5, heritage_villa: 0.5, resort: 1.0, serviced_apartment: 0.2, hotel: 0.6, glamping: 0.4, chalet: 0.5, homestay: 0.3, property: 0.5 },
  serviced_apartment:{ villa: 0.1, luxury_villa: 0.1, heritage_villa: 0.1, resort: 0.2, serviced_apartment: 1.0, hotel: 0.7, glamping: 0.0, chalet: 0.1, homestay: 0.3, property: 0.4 },
  hotel:             { villa: 0.2, luxury_villa: 0.2, heritage_villa: 0.3, resort: 0.6, serviced_apartment: 0.7, hotel: 1.0, glamping: 0.1, chalet: 0.3, homestay: 0.3, property: 0.6 },
  glamping:          { villa: 0.3, luxury_villa: 0.3, heritage_villa: 0.2, resort: 0.4, serviced_apartment: 0.0, hotel: 0.1, glamping: 1.0, chalet: 0.7, homestay: 0.5, property: 0.4 },
  chalet:            { villa: 0.7, luxury_villa: 0.7, heritage_villa: 0.6, resort: 0.5, serviced_apartment: 0.1, hotel: 0.3, glamping: 0.7, chalet: 1.0, homestay: 0.5, property: 0.5 },
  homestay:          { villa: 0.5, luxury_villa: 0.3, heritage_villa: 0.4, resort: 0.3, serviced_apartment: 0.3, hotel: 0.3, glamping: 0.5, chalet: 0.5, homestay: 1.0, property: 0.5 },
  property:          { villa: 0.5, luxury_villa: 0.5, heritage_villa: 0.5, resort: 0.5, serviced_apartment: 0.4, hotel: 0.6, glamping: 0.4, chalet: 0.5, homestay: 0.5, property: 0.7 },
};

function getTypeCompat(ownType, candidateType) {
  const ot = (ownType || 'property').toLowerCase();
  const ct = (candidateType || 'property').toLowerCase();
  const row = TYPE_COMPAT[ot] || TYPE_COMPAT.property;
  return row[ct] ?? 0.5;
}

// ── Individual scoring functions (each returns 0..1) ─────────────────────────

function scoreDistance(distKm, maxKm = 40) {
  if (distKm == null || isNaN(distKm)) return 0.2;
  if (distKm <= 1)  return 1.0;
  if (distKm <= 3)  return 0.92;
  if (distKm <= 5)  return 0.82;
  if (distKm <= 10) return 0.70;
  if (distKm <= 15) return 0.55;
  if (distKm <= 20) return 0.40;
  if (distKm <= maxKm) return Math.max(0.05, 0.40 - (distKm - 20) * 0.017);
  return 0;
}

function scorePriceSimilarity(ownAvgPrice, candidatePrice) {
  if (!ownAvgPrice || !candidatePrice) return 0.5;
  const ratio = candidatePrice / ownAvgPrice;
  // Perfect match within ±20%; drops sharply outside ±50%
  if (ratio >= 0.8 && ratio <= 1.2) return 1.0;
  if (ratio >= 0.6 && ratio <= 1.5) return 0.7;
  if (ratio >= 0.4 && ratio <= 2.0) return 0.4;
  return 0.1;
}

function scoreRatingSimilarity(ownRating, candidateRating) {
  if (!ownRating || !candidateRating) return 0.5;
  const diff = Math.abs(ownRating - candidateRating);
  if (diff <= 0.3) return 1.0;
  if (diff <= 0.7) return 0.8;
  if (diff <= 1.2) return 0.6;
  if (diff <= 2.0) return 0.3;
  return 0.1;
}

function scoreReviewCount(reviews) {
  if (!reviews) return 0.3;
  if (reviews >= 500)  return 1.0;
  if (reviews >= 200)  return 0.85;
  if (reviews >= 100)  return 0.70;
  if (reviews >= 50)   return 0.55;
  if (reviews >= 10)   return 0.40;
  return 0.25;
}

function scoreCapacitySimilarity(ownBeds, candidateBeds) {
  if (!ownBeds || !candidateBeds) return 0.5;
  const diff = Math.abs(ownBeds - candidateBeds);
  if (diff === 0) return 1.0;
  if (diff <= 1)  return 0.85;
  if (diff <= 2)  return 0.65;
  if (diff <= 3)  return 0.40;
  return 0.15;
}

function scorePropertyType(ownType, candidateType) {
  return getTypeCompat(ownType, candidateType);
}

function scoreGeocodeQuality(geocoded, approximate) {
  if (geocoded && !approximate) return 1.0;
  if (geocoded && approximate)  return 0.6;
  return 0.4;
}

function scoreDataQuality(hasPrice, hasRating) {
  if (hasPrice && hasRating) return 1.0;
  if (hasPrice || hasRating) return 0.7;
  return 0.4;
}

// ── Scoring weights (must sum to 1.0) ────────────────────────────────────────
const WEIGHTS = {
  propertyType:   0.25,  // type compatibility (villa vs hotel etc.)
  distance:       0.20,  // geographic proximity
  priceTier:      0.20,  // price similarity
  capacity:       0.15,  // bedroom/guest count similarity
  rating:         0.10,  // rating similarity
  reviewCount:    0.05,  // data confidence signal
  geocodeQuality: 0.03,  // location accuracy
  dataQuality:    0.02,  // data completeness
};

/**
 * Compute a 0–100 confidence-weighted relevance score.
 *
 * @param {object} own      - own property { propertyType, beds, rating, avgPrice }
 * @param {object} candidate - { propertyType, distance, price, rating, reviews, geocoded, approximate }
 * @returns {{ score: number, breakdown: object, confidence: 'high'|'medium'|'low', reject: boolean }}
 */
function computeRelevance(own, candidate) {
  const components = {
    propertyType:   scorePropertyType(own.propertyType, candidate.type || candidate.propertyType),
    distance:       scoreDistance(candidate.distance),
    priceTier:      scorePriceSimilarity(own.avgPrice, candidate.price),
    capacity:       scoreCapacitySimilarity(own.beds, candidate.beds),
    rating:         scoreRatingSimilarity(own.rating, candidate.rating),
    reviewCount:    scoreReviewCount(candidate.reviews),
    geocodeQuality: scoreGeocodeQuality(candidate.geocoded, candidate.approximate),
    dataQuality:    scoreDataQuality(!!candidate.price, !!candidate.rating),
  };

  let score = 0;
  for (const [key, w] of Object.entries(WEIGHTS)) {
    score += (components[key] || 0) * w;
  }

  const finalScore = Math.round(score * 100);

  // Hard rejection rules
  const maxKm = candidate._maxDistKm || 40;
  const reject = (
    components.propertyType < 0.15 ||
    (candidate.geocoded && !candidate.approximate && candidate.distance > maxKm) ||
    (candidate.approximate && candidate.distance > 25) ||
    (candidate.approximate && components.propertyType < 0.3)
  );

  const confidence = finalScore >= 65 ? 'high' : finalScore >= 45 ? 'medium' : 'low';

  return { score: finalScore, breakdown: components, confidence, reject };
}

/**
 * Infer property type from Booking.com type text and name.
 */
function inferPropertyType(typeText, name) {
  const t = (typeText || '').toLowerCase();
  const n = (name || '').toLowerCase();

  const both = `${t} ${n}`;

  if (/villa/.test(both)) return 'villa';
  if (/resort/.test(both)) return 'resort';
  if (/glamping|camp/.test(both)) return 'glamping';
  if (/chalet/.test(both)) return 'chalet';
  if (/haveli|heritage/.test(both)) return 'heritage_villa';
  if (/apartment|suite|residenc/.test(both)) return 'serviced_apartment';
  // Indian listings rarely say "apartment" — they say "2 BHK", "studio" or "flat". Without these
  // a large share of the market fell through to the generic 'property' bucket, and property type
  // carries the single heaviest relevance weight (25%), so those candidates were scored on a flat
  // 0.5 compatibility and ranked poorly regardless of how comparable they actually were.
  // "BR" is deliberately excluded: it reads as a bedroom count for villas as often as for flats.
  if (/\d\s*bhk\b|\bstudio\b|\bflats?\b|\bapt\b/.test(both)) return 'serviced_apartment';
  if (/homestay|home stay/.test(both)) return 'homestay';
  // Was previously tested against the type text only, so "Hotel Carnival The Goa" and
  // "Grand Mercure Goa - An Accor Hotels Brand" were classified as generic properties.
  if (/hotel|inn|lodge/.test(both)) return 'hotel';
  return 'property';
}

/**
 * Sort and filter a list of discovered candidates against an own property.
 *
 * @param {object}   ownProp     - from config/properties.json
 * @param {number}   ownAvgPrice - scraped average price (null if no data)
 * @param {object[]} candidates  - from discover.js extraction loop
 * @param {number}   maxDistKm   - hard cutoff distance
 * @returns {object[]} - sorted, filtered, scored candidates
 */
function rankCandidates(ownProp, ownAvgPrice, candidates, maxDistKm = 40) {
  const own = {
    propertyType: ownProp.propertyType || 'villa',
    beds:         ownProp.beds || null,
    rating:       ownProp.rating || null,
    avgPrice:     ownAvgPrice || null,
  };

  const results = [];
  for (const c of candidates) {
    // Never rank one of our own properties as a competitor. Nearby portfolio properties do turn up
    // in the search (two can share a building), and rate-shopping a property against itself skews
    // price index, rank and the suggestions engine. discover.js tags these; they remain in
    // fullMarket for map context.
    if (c.isOwnPortfolio) continue;
    // Skip if properly geocoded and beyond hard cutoff
    if (c.geocoded && !c.approximate && c.distance > maxDistKm) continue;

    const inferredType = inferPropertyType(c.type, c.name);
    const enriched = { ...c, type: inferredType, _maxDistKm: maxDistKm };

    const { score, breakdown, confidence, reject } = computeRelevance(own, enriched);
    if (reject) continue;

    results.push({ ...enriched, relevanceScore: score, breakdown, confidence });
  }

  return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

module.exports = { computeRelevance, rankCandidates, inferPropertyType, scoreDistance, getTypeCompat };
