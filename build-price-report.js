/**
 * build-price-report.js
 *
 * Generates a Competitor Rate & Pricing Analysis report (HTML + PDF) for one property.
 *
 * Scope is deliberately rates/pricing only: competitor rates, rate differences,
 * price positioning, rate trends and rate opportunities. No ratings, reviews,
 * distance or quality factors are analysed.
 *
 * Usage:
 *   node build-price-report.js --property=1
 *   node build-price-report.js --property=1 --html-only
 *
 * Output: reports/rate-analysis-<propId>-<YYYY-MM-DD>.{html,pdf}
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { findChrome } = require('./lib/chrome');

const arg = n => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const PROP = arg('property') || '1';
const HTML_ONLY = process.argv.includes('--html-only');

const DASH = path.join(__dirname, 'data', 'latest.dashboard.json');
const CFG  = path.join(__dirname, 'config', 'properties.json');
const DISC = path.join(__dirname, 'data', 'discovery-cache.json');
const OUTDIR = path.join(__dirname, 'reports');

// ── load ──────────────────────────────────────────────────────────────────────
const dash = JSON.parse(fs.readFileSync(DASH, 'utf8'));
const cfg  = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const dc   = JSON.parse(fs.readFileSync(DISC, 'utf8'));
let hol = {}; try { hol = require('./lib/holidays.js'); } catch (_) {}

const own = dash.portfolio[PROP];
const cfgOwn = cfg.properties.find(p => p.id === PROP);
if (!own || !cfgOwn) { console.error(`Property ${PROP} not found in config/dashboard.`); process.exit(1); }
const C = dash.competitors || {};
const ids = cfgOwn.competitors || [];
const mkt = new Map((dc[PROP]?.results || []).map(r => [r.id.replace(/-/g, '_'), r]));

// ── stats ─────────────────────────────────────────────────────────────────────
const srt  = a => [...a].sort((x, y) => x - y);
const med  = a => { if (!a.length) return null; const s = srt(a), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pctl = (a, p) => { if (!a.length) return null; const s = srt(a); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; };
const cvOf = a => { const m = mean(a); if (!m) return null; return Math.sqrt(mean(a.map(v => (v-m)**2)))/m; };
const R0 = v => v == null ? null : Math.round(v);
const R2 = v => v == null ? null : Math.round(v*100)/100;
const rankOf  = (v, a) => srt(a).filter(x => x < v).length + 1;
const pctileOf = (v, a) => a.length ? Math.round(srt(a).filter(x => x < v).length / a.length * 100) : null;
const inr = v => v == null ? '—' : '₹' + Number(Math.round(v)).toLocaleString('en-IN');
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── night typing ──────────────────────────────────────────────────────────────
const lw = new Set();
try {
  const y = new Date().getFullYear();
  for (const yr of [y, y+1]) for (const x of (hol.computeLongWeekends?.(yr) || [])) for (const d of (x.dates||[])) lw.add(d);
} catch (_) {}
function nightType(d) {
  if (lw.has(d)) return 'Long weekend';
  const w = new Date(d + 'T00:00:00').getDay();
  return w === 5 ? 'Friday' : w === 6 ? 'Saturday' : w === 0 ? 'Sunday' : 'Weekday';
}
const NT = ['Weekday','Friday','Saturday','Sunday','Long weekend'];

// ── own products ──────────────────────────────────────────────────────────────
const ownRooms = Object.entries(own.rooms || {});
const isDorm = k => /dorm/i.test(k);
const dormR = ownRooms.filter(([k]) => isDorm(k));
const privR = ownRooms.filter(([k]) => !isDorm(k));
const dates = [...new Set(ownRooms.flatMap(([,r]) => Object.keys(r.observed||{})))].sort();
const lead = (rooms, d) => { const v = rooms.map(([,r]) => r.observed?.[d]).filter(x => x!=null && x>0); return v.length ? Math.min(...v) : null; };
const ownDorm = {}, ownPriv = {};
dates.forEach(d => { ownDorm[d] = lead(dormR, d); ownPriv[d] = lead(privR, d); });
const dS = Object.values(ownDorm).filter(v=>v!=null);
const pS = Object.values(ownPriv).filter(v=>v!=null);

const roomRows = ownRooms.map(([k, r]) => {
  const px = Object.values(r.observed||{}).filter(v=>v!=null&&v>0);
  return { name: r.name || k, group: isDorm(k)?'Dorm':'Private', nights: px.length,
    min: Math.min(...px), max: Math.max(...px), mean: R0(mean(px)), cv: R2(cvOf(px)) };
}).sort((a,b)=>a.mean-b.mean);

// ── peers ─────────────────────────────────────────────────────────────────────
// The market comes from the discovery scan, NOT from whichever competitors happen
// to be linked in config — curating the linked list down (via the Discover tab)
// must not shrink the market the property is measured against. A 30-night curve is
// attached wherever one has been scraped; those peers drive the trend sections.
const peers = [];
const seen = new Set();

// A peer's lead-in rate normally comes from the price on its discovery search-result card.
// The coordinate search often returns cards with no price at all — every candidate in the
// current cache has `price: null` — and this used to abort the whole report while sitting on
// 30-night curves that refresh.js had already scraped for those same peers. So fall back to the
// first available night of the scraped curve, which is what a lead-in rate actually is: the
// price a guest seeing the listing today would be quoted.
const curveLeadIn = curve => {
  for (const d of dates) { const v = curve[d]; if (v != null && v > 0) return v; }
  return null;
};

for (const r of (dc[PROP]?.results || [])) {
  const id = r.id.replace(/-/g, '_');
  if (seen.has(id)) continue;
  seen.add(id);
  const c = C[id];
  const curve = {};
  if (c) {
    const rooms = Object.values(c.rooms || {});
    dates.forEach(d => { const v = rooms.map(x=>x.observed?.[d]).filter(y=>y!=null&&y>0); if (v.length) curve[d] = Math.min(...v); });
  }
  const s = Object.values(curve);
  const cardRate = r.price != null && r.price > 0 ? r.price : null;
  const rate = cardRate ?? curveLeadIn(curve);
  peers.push({ id, name: c?.name || r.name || id, rate, curve,
    rateSource: cardRate != null ? 'card' : (rate != null ? 'scrape' : null),
    linked: ids.includes(id),
    nights: s.length, mean30: R0(mean(s)), min: s.length?Math.min(...s):null, max: s.length?Math.max(...s):null,
    cv: R2(cvOf(s)) });
}
const priced = peers.filter(p => p.rate != null && p.rate > 0);
const curved = peers.filter(p => p.nights >= 20);
const rates  = priced.map(p => p.rate);
if (!priced.length) {
  console.error(`No competitor rates available for property ${PROP}.`);
  console.error('  Neither the discovery scan nor a price scrape has produced a rate for any peer.');
  console.error('  Run: node discover.js --property=' + PROP + '   then: node refresh.js --property=' + PROP);
  process.exit(1);
}

const M = { n: peers.length, priced: priced.length,
  fromScrape: priced.filter(p => p.rateSource === 'scrape').length,
  min: R0(Math.min(...rates)), q1: R0(pctl(rates,25)),
  median: R0(med(rates)), q3: R0(pctl(rates,75)), max: R0(Math.max(...rates)),
  spread: R2(Math.max(...rates)/Math.min(...rates)), cv: R2(cvOf(rates)) };
M.iqr = M.q3 - M.q1;

const BANDS = [
  ['< ₹1,000',0,1000],['₹1,000–1,999',1000,2000],['₹2,000–2,999',2000,3000],
  ['₹3,000–4,999',3000,5000],['₹5,000–7,499',5000,7500],['₹7,500–9,999',7500,10000],['₹10,000+',10000,1e9],
].map(([label,lo,hi]) => ({ label, lo, hi, count: rates.filter(v=>v>=lo&&v<hi).length }));

// competitive band = ±40% of own lead-in ADR
function analyse(series, label) {
  const adr = mean(series);
  const set = priced.filter(p => p.rate >= adr*0.6 && p.rate <= adr*1.4).sort((a,b)=>a.rate-b.rate);
  const r = set.map(p=>p.rate);
  // Only band members that actually have a scraped curve can form a nightly median
  const bandCurvePeers = set.filter(p => p.nights >= 20);
  const bandCurve = {};
  dates.forEach(d => { const v = bandCurvePeers.map(p=>p.curve[d]).filter(x=>x!=null); if (v.length) bandCurve[d] = R0(med(v)); });
  return { label, adr: R0(adr), median: R0(med(series)), min: Math.min(...series), max: Math.max(...series),
    cv: R2(cvOf(series)), spread: R2(Math.max(...series)/Math.min(...series)),
    bandLo: R0(adr*0.6), bandHi: R0(adr*1.4), set, bandMedian: R0(med(r)),
    index: r.length ? Math.round(adr/med(r)*100) : null,
    // rankOf places the own rate among the band's competitors, so the field it should be
    // reported "of" includes the own property — otherwise a rate above both of two
    // competitors renders as the impossible "ranked 3 of 2".
    rank: r.length ? rankOf(adr, r) : null, rankTotal: r.length + 1, n: set.length,
    bandCurve, curveN: bandCurvePeers.length };
}
const D = analyse(dS, 'Dorm bed');
const P = analyse(pS, 'Private room');

// market median per night
const byNight = dates.map(d => {
  const v = curved.map(p=>p.curve[d]).filter(x=>x!=null);
  return { d, t: nightType(d), median: R0(med(v)), ownDorm: ownDorm[d], ownPriv: ownPriv[d],
           dBand: D.bandCurve[d], pBand: P.bandCurve[d] };
});
function ntAgg(get) { const o = {}; NT.forEach(t => { const v = byNight.filter(r=>r.t===t).map(get).filter(x=>x!=null); o[t] = v.length?R0(mean(v)):null; }); return o; }
const ntD = ntAgg(r=>r.ownDorm), ntP = ntAgg(r=>r.ownPriv), ntM = ntAgg(r=>r.median);
const prem = o => { const b = o['Weekday']; const x = {}; NT.forEach(t => x[t] = (b&&o[t])?Math.round((o[t]/b-1)*100):null); return x; };
const pD = prem(ntD), pP = prem(ntP), pM = prem(ntM);

// peer flex distribution
const flex = curved.map(p => {
  const wd = [], pk = [];
  dates.forEach(d => { const v=p.curve[d]; if(v==null)return; (nightType(d)==='Weekday'?wd:pk).push(v); });
  const b = mean(wd), w = mean(pk);
  return { name: p.name, premium: (b&&w)?Math.round((w/b-1)*100):null, cv: p.cv };
}).filter(x=>x.premium!=null).sort((a,b)=>b.premium-a.premium);
const flexVals = flex.map(f=>f.premium);
const flexStats = { n: flexVals.length, p25: pctl(flexVals,25), median: med(flexVals), p75: pctl(flexVals,75), max: Math.max(...flexVals) };

// rate escalation dates (demand inferred from price movement only)
const base = med(byNight.map(r=>r.median).filter(Boolean));
const esc8 = byNight.map(r => ({ ...r,
  lift: r.median ? Math.round((r.median/base-1)*100) : null,
  dLift: r.ownDorm ? Math.round((r.ownDorm/mean(dS)-1)*100) : null,
  pLift: r.ownPriv ? Math.round((r.ownPriv/mean(pS)-1)*100) : null,
})).sort((a,b)=>(b.lift??-99)-(a.lift??-99)).slice(0,10);

// ── which products does this property actually sell? ──────────────────────────
// A villa or serviced apartment has a single room, so the dorm track has no data and every
// dorm figure came out as Infinity, "—" or literal "null" in the charts.
const hasDorm = dormR.length > 0 && dS.length > 0;
const hasPriv = privR.length > 0 && pS.length > 0;
// The product the market comparisons hang off: the private/whole-unit rate when there is one.
const PRIMARY = hasPriv ? P : D;
const primaryLabel = hasPriv ? (hasDorm ? 'private room' : 'unit') : 'dorm bed';
const primaryPrem  = hasPriv ? pP : pD;
const primaryNt    = hasPriv ? ntP : ntD;
/** Strongest observed premium for a product, replacing a hardcoded "+87%". */
const maxPremium = prm => {
  const v = NT.filter(t => t !== 'Weekday').map(t => prm[t]).filter(x => x != null);
  return v.length ? Math.max(...v) : null;
};
/** Section number: the dorm section (3) is dropped for single-product properties. */
const SN = n => (hasDorm ? n : n - 1);

// ── rate ladder + whitespace ──────────────────────────────────────────────────
// The cut-off used to be a flat ₹2,000, which was the right neighbourhood for the hostel this
// report was first written for and meaningless for a villa at ₹12,000 — the ladder came out
// empty and titled "Budget rate ladder (≤ ₹2,000)". Scale it to the product instead: the rungs
// worth seeing are the ones a repricing move would actually pass through.
const LADDER_HI  = PRIMARY.adr ? Math.round(PRIMARY.adr * 1.6) : 2000;
const ladderRung = priced.filter(p => p.rate <= LADDER_HI).sort((a,b)=>a.rate-b.rate);
// Treat a gap as whitespace at ~5% of the product's own rate, not a fixed ₹250.
const GAP_MIN = Math.max(100, Math.round((PRIMARY.adr || 5000) * 0.05));
const budget = ladderRung;
const gaps = [];
for (let i=1;i<budget.length;i++) { const g = budget[i].rate-budget[i-1].rate;
  if (g>=GAP_MIN) gaps.push({ from: budget[i-1].rate, to: budget[i].rate, width: g, pct: Math.round((budget[i].rate/budget[i-1].rate-1)*100) }); }

// ── SVG helpers ───────────────────────────────────────────────────────────────
const W = 680;
const AX = '#8a8f98', GRID = '#e6e8eb', INK = '#1a1d21';
const CD = '#c2410c', CP = '#1d4ed8', CM = '#6b7280', COWN = '#b45309';

function svgWrap(h, body, title) {
  return `<svg viewBox="0 0 ${W} ${h}" width="100%" height="${h}" role="img" aria-label="${esc(title)}" style="max-width:100%">${body}</svg>`;
}
function yScale(vals, top, bot, pad = 0.12) {
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const span = (mx - mn) || 1, lo = Math.max(0, mn - span*pad), hi = mx + span*pad;
  return { lo, hi, y: v => bot - (v - lo)/(hi - lo)*(bot - top) };
}
function histSvg() {
  const h = 210, top = 16, bot = 160, L = 8, bw = (W - 20)/BANDS.length;
  const mx = Math.max(...BANDS.map(b=>b.count)) || 1;
  let s = '';
  BANDS.forEach((b, i) => {
    const bh = b.count/mx*(bot-top), x = L + i*bw;
    s += `<rect x="${x+7}" y="${bot-bh}" width="${bw-14}" height="${bh}" fill="#93a3b8" rx="2"/>`;
    s += `<text x="${x+bw/2}" y="${bot-bh-5}" font-size="10" fill="${INK}" text-anchor="middle" font-weight="600">${b.count}</text>`;
    s += `<text x="${x+bw/2}" y="${bot+15}" font-size="8.5" fill="${AX}" text-anchor="middle">${b.label.replace('₹','')}</text>`;
  });
  s += `<line x1="${L}" y1="${bot}" x2="${W-12}" y2="${bot}" stroke="${AX}" stroke-width="1"/>`;
  // own markers
  const mkr = (v, col, lab) => {
    // A null ADR (product the property does not sell) matched band 0 via `null >= 0`, so a
    // marker labelled "Dorm —" was drawn over the cheapest band of an unrelated villa.
    if (v == null || !Number.isFinite(v)) return '';
    const i = BANDS.findIndex(b => v >= b.lo && v < b.hi); if (i < 0) return '';
    const x = L + i*bw + bw/2;
    return `<line x1="${x}" y1="${top}" x2="${x}" y2="${bot}" stroke="${col}" stroke-width="1.6" stroke-dasharray="4 3"/>`
         + `<text x="${x}" y="${bot+32}" font-size="9" fill="${col}" text-anchor="middle" font-weight="700">${lab}</text>`;
  };
  if (hasDorm) s += mkr(D.adr, CD, `Dorm ${inr(D.adr)}`);
  s += mkr(P.adr, CP, `${hasDorm ? 'Room' : 'Own'} ${inr(P.adr)}`);
  s += `<text x="${L}" y="${bot+50}" font-size="8.5" fill="${AX}">Count of competitor lead-in rates per band (n=${M.priced})</text>`;
  return svgWrap(h, s, 'Market rate distribution');
}
function bulletSvg(A, col) {
  const h = 88, L = 8, Rr = W-14, top = 26, barH = 20;
  const r = A.set.map(p=>p.rate); if (!r.length) return '';
  const lo = Math.min(...r, A.adr)*0.96, hi = Math.max(...r, A.adr)*1.04;
  const x = v => L + (v-lo)/(hi-lo)*(Rr-L);
  let s = `<rect x="${L}" y="${top}" width="${Rr-L}" height="${barH}" fill="#eef1f4" rx="3"/>`;
  s += `<rect x="${x(pctl(r,25))}" y="${top}" width="${Math.max(2,x(pctl(r,75))-x(pctl(r,25)))}" height="${barH}" fill="#cfd6de" rx="2"/>`;
  s += `<line x1="${x(A.bandMedian)}" y1="${top-5}" x2="${x(A.bandMedian)}" y2="${top+barH+5}" stroke="${INK}" stroke-width="1.8"/>`;
  s += `<text x="${x(A.bandMedian)}" y="${top-9}" font-size="9" fill="${INK}" text-anchor="middle" font-weight="600">band median ${inr(A.bandMedian)}</text>`;
  A.set.forEach(p => { s += `<circle cx="${x(p.rate)}" cy="${top+barH/2}" r="3" fill="#6b7280" opacity=".75"/>`; });
  s += `<polygon points="${x(A.adr)},${top+barH+9} ${x(A.adr)-5},${top+barH+19} ${x(A.adr)+5},${top+barH+19}" fill="${col}"/>`;
  s += `<text x="${x(A.adr)}" y="${top+barH+31}" font-size="9.5" fill="${col}" text-anchor="middle" font-weight="700">own ${inr(A.adr)} · index ${A.index}</text>`;
  s += `<text x="${L}" y="${top+barH+31}" font-size="8.5" fill="${AX}">${inr(A.bandLo)}</text>`;
  s += `<text x="${Rr}" y="${top+barH+31}" font-size="8.5" fill="${AX}" text-anchor="end">${inr(A.bandHi)}</text>`;
  s += `<text x="${L}" y="14" font-size="10" fill="${INK}" font-weight="700">${esc(A.label)} — ±40% competitive band (n=${A.n})</text>`;
  return svgWrap(h, s, A.label + ' positioning');
}
function curveSvg(key, bandKey, col, label, unitLabel) {
  const h = 200, top = 24, bot = 150, L = 40, Rr = W-10;
  const vals = byNight.flatMap(r => [r[key], r[bandKey]]).filter(v=>v!=null);
  if (!vals.length) return '';
  const sc = yScale(vals, top, bot);
  const x = i => L + i/(byNight.length-1)*(Rr-L);
  let s = '';
  for (let g=0; g<=4; g++) { const v = sc.lo+(sc.hi-sc.lo)*g/4, y = sc.y(v);
    s += `<line x1="${L}" y1="${y}" x2="${Rr}" y2="${y}" stroke="${GRID}"/><text x="${L-5}" y="${y+3}" font-size="8" fill="${AX}" text-anchor="end">${inr(v)}</text>`; }
  // weekend shading
  byNight.forEach((r,i) => { if (r.t!=='Weekday') { const x0=x(i)-(Rr-L)/byNight.length/2;
    s += `<rect x="${x0}" y="${top}" width="${(Rr-L)/byNight.length}" height="${bot-top}" fill="#f59e0b" opacity=".07"/>`; } });
  const line = (k, c, dash) => {
    const pts = byNight.map((r,i)=>r[k]!=null?`${x(i)},${sc.y(r[k])}`:null).filter(Boolean).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" ${dash?`stroke-dasharray="${dash}"`:''} stroke-linejoin="round"/>`;
  };
  s += line(bandKey, CM, '5 4') + line(key, col, '');
  byNight.forEach((r,i)=>{ if(r[key]!=null) s += `<circle cx="${x(i)}" cy="${sc.y(r[key])}" r="2" fill="${col}"/>`; });
  byNight.forEach((r,i)=>{ if(i%4===0) s += `<text x="${x(i)}" y="${bot+13}" font-size="7.5" fill="${AX}" text-anchor="middle">${r.d.slice(5)}</text>`; });
  s += `<line x1="${L}" y1="${bot}" x2="${Rr}" y2="${bot}" stroke="${AX}"/>`;
  s += `<text x="${L}" y="13" font-size="10" fill="${INK}" font-weight="700">${esc(label)}</text>`;
  s += `<rect x="${Rr-190}" y="${top+2}" width="10" height="3" fill="${col}"/><text x="${Rr-176}" y="${top+8}" font-size="8" fill="${INK}">own ${esc(unitLabel)}</text>`;
  s += `<rect x="${Rr-104}" y="${top+2}" width="10" height="3" fill="${CM}"/><text x="${Rr-90}" y="${top+8}" font-size="8" fill="${INK}">band median</text>`;
  s += `<text x="${L}" y="${bot+30}" font-size="8" fill="${AX}">Shaded = Fri/Sat/Sun/long weekend</text>`;
  return svgWrap(h, s, label);
}
function ntSvg() {
  const h = 200, top = 20, bot = 150, L = 40, gw = (W-L-20)/NT.length;
  const series = [ ...(hasDorm ? [['Own dorm', pD, CD]] : []),
                   [hasDorm ? 'Own room' : 'Own rate', pP, CP], ['Market', pM, CM] ];
  const all = series.flatMap(([,o]) => NT.map(t=>o[t]).filter(v=>v!=null));
  const mx = Math.max(...all, 5), mn = Math.min(...all, 0);
  const y = v => bot - (v-mn)/((mx-mn)||1)*(bot-top);
  let s = '';
  [0,25,50,75,100].forEach(p => { const v = mn+(mx-mn)*p/100, yy = y(v);
    s += `<line x1="${L}" y1="${yy}" x2="${W-20}" y2="${yy}" stroke="${GRID}"/><text x="${L-5}" y="${yy+3}" font-size="8" fill="${AX}" text-anchor="end">${Math.round(v)}%</text>`; });
  NT.forEach((t,i) => {
    const bx = L + i*gw, bw2 = gw/4;
    series.forEach(([nm,o,c],j) => { const v = o[t]; if (v==null) return;
      const y0 = Math.min(y(v), y(0)), hh = Math.abs(y(v)-y(0));
      s += `<rect x="${bx+8+j*bw2}" y="${y0}" width="${bw2-4}" height="${Math.max(1,hh)}" fill="${c}" rx="1.5"/>`;
      s += `<text x="${bx+8+j*bw2+(bw2-4)/2}" y="${y0-3}" font-size="7.5" fill="${c}" text-anchor="middle" font-weight="700">${v>0?'+':''}${v}</text>`; });
    s += `<text x="${bx+gw/2}" y="${bot+14}" font-size="8.5" fill="${AX}" text-anchor="middle">${t}</text>`;
  });
  s += `<line x1="${L}" y1="${y(0)}" x2="${W-20}" y2="${y(0)}" stroke="${AX}"/>`;
  s += `<text x="${L}" y="12" font-size="10" fill="${INK}" font-weight="700">Rate premium vs own weekday base (%)</text>`;
  let lx = W-250; series.forEach(([nm,,c])=>{ s += `<rect x="${lx}" y="4" width="9" height="9" fill="${c}" rx="1.5"/><text x="${lx+13}" y="12" font-size="8" fill="${INK}">${nm}</text>`; lx += 78; });
  return svgWrap(h, s, 'Night-type rate premium');
}
function flexSvg() {
  const h = 170, top = 22, bot = 120, L = 30, Rr = W-14;
  const buckets = [[-100,0],[0,10],[10,20],[20,30],[30,45],[45,70]];
  const cnt = buckets.map(([lo,hi]) => flexVals.filter(v=>v>=lo&&v<hi).length);
  const mx = Math.max(...cnt)||1, bw = (Rr-L)/buckets.length;
  let s = '';
  buckets.forEach(([lo,hi],i) => { const bh = cnt[i]/mx*(bot-top), x = L+i*bw;
    s += `<rect x="${x+6}" y="${bot-bh}" width="${bw-12}" height="${bh}" fill="#93a3b8" rx="2"/>`;
    s += `<text x="${x+bw/2}" y="${bot-bh-4}" font-size="9" fill="${INK}" text-anchor="middle" font-weight="600">${cnt[i]}</text>`;
    s += `<text x="${x+bw/2}" y="${bot+14}" font-size="8" fill="${AX}" text-anchor="middle">${lo<0?'≤0':lo+'–'+hi}%</text>`; });
  s += `<line x1="${L}" y1="${bot}" x2="${Rr}" y2="${bot}" stroke="${AX}"/>`;
  // A null premium (product absent, or that night sold out) used to render literally, so the
  // chart carried the text "own dorm +null% (p0)".
  const mark = (v,c,lab,dy) => { if (v==null || !Number.isFinite(v)) return '';
    const i = buckets.findIndex(([lo,hi])=>v>=lo&&v<hi); if(i<0) return '';
    const x = L+i*bw+bw/2;
    return `<line x1="${x}" y1="${top}" x2="${x}" y2="${bot}" stroke="${c}" stroke-width="1.6" stroke-dasharray="4 3"/>`
         + `<text x="${x}" y="${bot+26+dy}" font-size="8.5" fill="${c}" text-anchor="middle" font-weight="700">${lab}</text>`; };
  // Mark each product at its own strongest peak night rather than a fixed Saturday/Friday.
  const dPk = hasDorm ? maxPremium(pD) : null, pPk = maxPremium(pP);
  if (dPk != null) s += mark(dPk, CD, `own dorm +${dPk}% (p${pctileOf(dPk,flexVals)})`, 0);
  if (pPk != null) s += mark(pPk, CP, `own ${hasDorm?'room':'rate'} +${pPk}% (p${pctileOf(pPk,flexVals)})`, dPk!=null?12:0);
  s += `<text x="${L}" y="12" font-size="10" fill="${INK}" font-weight="700">How hard competitors flex rates on peak nights (n=${flex.length})</text>`;
  return svgWrap(h, s, 'Peer rate flex distribution');
}
function ladderSvg() {
  const rows = budget.slice(0, 16);
  const h = 34 + rows.length*17 + 26, L = 200, Rr = W-56;
  const ownAdr = PRIMARY.adr;
  if (!rows.length || !ownAdr) return '';
  const mx = Math.max(...rows.map(r=>r.rate), ownAdr);
  const x = v => L + v/mx*(Rr-L);
  let s = `<text x="0" y="12" font-size="10" fill="${INK}" font-weight="700">Rate ladder up to ${inr(LADDER_HI)} — own ${hasDorm?'dorm':'lead-in'} marked</text>`;
  let y = 30;
  const ownIdx = rows.findIndex(r => r.rate > ownAdr);
  const drawOwn = () => { s += `<rect x="0" y="${y-9}" width="${W}" height="15" fill="#fef3c7"/>`;
    s += `<text x="${L-6}" y="${y+2}" font-size="9" fill="${COWN}" text-anchor="end" font-weight="700">OWN — ${hasDorm?'dorm':primaryLabel} lead-in</text>`;
    s += `<rect x="${L}" y="${y-5}" width="${Math.max(2,x(ownAdr)-L)}" height="10" fill="${COWN}" rx="2"/>`;
    s += `<text x="${x(ownAdr)+5}" y="${y+3}" font-size="8.5" fill="${COWN}" font-weight="700">${inr(ownAdr)}</text>`; y += 17; };
  rows.forEach((r,i) => {
    if (i === ownIdx) drawOwn();
    const g = gaps.find(g => g.from === (rows[i-1]?.rate) && g.to === r.rate);
    if (g) { s += `<text x="${L}" y="${y+2}" font-size="8" fill="#b91c1c" font-weight="700">▲ whitespace ${inr(g.width)} (+${g.pct}%) — no competitor between ${inr(g.from)} and ${inr(g.to)}</text>`; y += 15; }
    s += `<text x="${L-6}" y="${y+2}" font-size="8.5" fill="${INK}" text-anchor="end">${esc(r.name.slice(0,34))}</text>`;
    s += `<rect x="${L}" y="${y-5}" width="${Math.max(2,x(r.rate)-L)}" height="10" fill="#9aa7b5" rx="2"/>`;
    s += `<text x="${x(r.rate)+5}" y="${y+3}" font-size="8" fill="${AX}">${inr(r.rate)}</text>`;
    y += 17;
  });
  if (ownIdx === -1) drawOwn();
  return svgWrap(y+8, s, 'Budget rate ladder');
}

// ── narrative helpers ─────────────────────────────────────────────────────────
const uplift = (from, to) => ({ abs: Math.round(to-from), pct: from ? Math.round((to/from-1)*100) : null });

// The parity targets used to be three hardcoded hostels — "Craft Hostels" at ₹599, "La GoYa" at
// ₹620, "The Beachside Hostel" at ₹502 — left over from when Property ID 1 was Backspace Anjuna
// Beach. Property IDs get reused between sheet revisions, so the report kept naming those
// hostels (and their rates) while analysing an unrelated villa. Derive them from the data:
// the cheapest priced competitors sitting ABOVE the product's own rate are what "parity" means.
function parityTargets(adr, n = 3) {
  if (!adr) return [];
  return priced.filter(p => p.rate > adr).sort((a, b) => a.rate - b.rate).slice(0, n)
    .map(p => ({ name: p.name, rate: p.rate, ...uplift(adr, p.rate) }));
}
/** The nearest priced competitor below the product's rate — the floor beneath it, if any. */
function floorBelow(adr) {
  if (!adr) return null;
  const below = priced.filter(p => p.rate < adr).sort((a, b) => b.rate - a.rate);
  return below.length ? below[0] : null;
}
/** Nearest priced competitor above, used when nothing sits below. */
function nearestAbove(adr) {
  const t = parityTargets(adr, 1);
  return t.length ? t[0] : null;
}

const missed = byNight.filter(r => r.median && r.ownPriv && (r.median/base-1) >= 0.04 && (r.ownPriv/mean(pS)-1) <= 0);
const dormFlat = esc8.filter(e => e.dLift != null && e.dLift < 0).length;

const stamp = new Date().toISOString().slice(0,10);
const scraped = dash.meta?.scrapedAt ? new Date(dash.meta.scrapedAt).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) : '—';

function kpi(label, value, sub, col) {
  return `<div class="kpi"><div class="kl">${esc(label)}</div><div class="kv" ${col?`style="color:${col}"`:''}>${value}</div><div class="ks">${sub||''}</div></div>`;
}
function tbl(head, rows, cls) {
  return `<table class="${cls||''}"><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ── HTML ──────────────────────────────────────────────────────────────────────
const html = `<meta charset="utf-8">
<title>Rate &amp; Pricing Analysis — ${esc(own.name)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 13mm; }
  * { box-sizing: border-box; }
  body { font: 10.5px/1.5 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1d21; margin: 0; }
  h1 { font-size: 21px; margin: 0 0 2px; letter-spacing: -.3px; }
  h2 { font-size: 13.5px; margin: 0 0 8px; padding-bottom: 5px; border-bottom: 2px solid #1a1d21; letter-spacing: -.2px; }
  h3 { font-size: 11px; margin: 14px 0 6px; color: #374151; text-transform: uppercase; letter-spacing: .5px; }
  p { margin: 0 0 8px; }
  .sub { color: #6b7280; font-size: 10px; }
  section { page-break-inside: avoid; margin-bottom: 20px; }
  .cover { border-bottom: 3px solid #b45309; padding-bottom: 12px; margin-bottom: 18px; }
  .meta { display: flex; gap: 22px; flex-wrap: wrap; font-size: 9.5px; color: #6b7280; margin-top: 8px; }
  .kpis { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 14px; }
  .kpi { flex: 1 1 118px; border: 1px solid #e2e5e9; border-radius: 5px; padding: 8px 9px; background: #fafbfc; }
  .kl { font-size: 8px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; }
  .kv { font-size: 17px; font-weight: 700; margin: 2px 0; letter-spacing: -.5px; }
  .ks { font-size: 8.5px; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; font-size: 9.3px; margin: 6px 0 10px; }
  th { text-align: left; background: #f3f5f7; padding: 5px 7px; font-size: 8.3px; text-transform: uppercase; letter-spacing: .4px; color: #374151; border-bottom: 1px solid #d8dce1; }
  td { padding: 4.5px 7px; border-bottom: 1px solid #eef1f4; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tr.own td { background: #fef3c7; font-weight: 700; }
  .callout { border-left: 3px solid #b45309; background: #fffbeb; padding: 8px 11px; margin: 9px 0; font-size: 10px; }
  .warn { border-left-color: #b91c1c; background: #fef2f2; }
  .ok { border-left-color: #15803d; background: #f0fdf4; }
  .fig { margin: 8px 0 4px; }
  .cap { font-size: 8.5px; color: #6b7280; margin-bottom: 10px; }
  ol, ul { margin: 4px 0 8px; padding-left: 18px; }
  li { margin-bottom: 5px; }
  .pb { page-break-before: always; }
  .foot { font-size: 8px; color: #9ca3af; border-top: 1px solid #e2e5e9; padding-top: 6px; margin-top: 14px; }
  .tag { display:inline-block; font-size:8px; padding:1.5px 6px; border-radius:9px; background:#e5e7eb; color:#374151; font-weight:600; }
</style>

<div class="cover">
  <h1>Competitor Rate &amp; Pricing Analysis</h1>
  <div class="sub"><strong>${esc(own.name)}</strong> — ${esc(own.city || '')} · Property ID ${esc(PROP)}</div>
  <div class="meta">
    <span><strong>Rate window</strong> ${dates[0]} → ${dates[dates.length-1]} (${dates.length} nights)</span>
    <span><strong>Competitors</strong> ${M.priced} priced / ${M.n} tracked</span>
    <span><strong>Rate data</strong> ${curved.length} full curves</span>
    ${M.fromScrape ? `<span><strong>Lead-in source</strong> ${M.priced - M.fromScrape} from search cards, ${M.fromScrape} from scraped curves</span>` : ''}
    <span><strong>Scraped</strong> ${esc(scraped)}</span>
  </div>
  <div class="meta"><span class="tag">SCOPE: RATES &amp; PRICING ONLY</span></div>
</div>

<section>
  <h2>1 · Executive Rate Summary</h2>
  <div class="kpis">
    ${hasDorm ? kpi('Dorm lead-in ADR', inr(D.adr), `${inr(D.min)}–${inr(D.max)}`, CD) : ''}
    ${hasDorm ? kpi('Dorm price index', String(D.index), `vs band median ${inr(D.bandMedian)}`, D.index<100?CD:INK) : ''}
    ${hasPriv ? kpi(hasDorm ? 'Room lead-in ADR' : 'Lead-in ADR', inr(P.adr), `${inr(P.min)}–${inr(P.max)}`, CP) : ''}
    ${hasPriv ? kpi(hasDorm ? 'Room price index' : 'Price index', String(P.index), `rank ${P.rank}/${P.rankTotal} in band`, INK) : ''}
    ${kpi('Market median', inr(M.median), `${M.priced} competitors`)}
    ${kpi('Market spread', M.spread + '×', `${inr(M.min)} – ${inr(M.max)}`)}
  </div>
  ${hasDorm && hasPriv
    ? `<p>The property sells two products whose rates differ by <strong>${R2(mean(pS)/mean(dS))}×</strong>, so they occupy
       different positions in the market and are assessed separately throughout. Every comparison uses a
       <strong>lead-in rate</strong> — the cheapest available room per night — on a single normalised basis.</p>`
    : `<p>The property sells a single rate product (${esc(ownRooms.map(([,r])=>r.name||'').filter(Boolean).join(', ') || primaryLabel)}),
       so it holds one position in the market. Every comparison uses a <strong>lead-in rate</strong> — the
       cheapest available room per night — on a single normalised basis.</p>`}
  ${hasDorm ? (() => {
    const t = parityTargets(D.adr, 1)[0];
    return `<div class="callout"><strong>Dorm — the price floor.</strong> At ${inr(D.adr)} the dorm is the
    <strong>cheapest rate in its band</strong> (rank ${D.rank} of ${D.rankTotal}), index ${D.index} against a band median of ${inr(D.bandMedian)}.
    ${t ? `Reaching parity with ${esc(t.name)} is <strong>+${inr(t.abs)}/night (+${t.pct}%)</strong>` : 'No priced competitor sits above it'}${gaps.length?`, and the ladder is empty from ${inr(gaps[0].from)} to ${inr(gaps[0].to)} (+${gaps[0].pct}%), so a move up meets no competitor`:''}.</div>`;
  })() : ''}
  ${hasPriv ? (() => {
    const within6 = P.set.filter(p=>Math.abs(p.rate/P.adr-1)<=0.06).length;
    // Whether this reads as "at parity", "above" or "below" has to follow the index, not be
    // asserted: the same sentence used to claim parity at any index at all.
    const pos = P.index == null ? 'unplaced' : P.index > 106 ? 'above the band' : P.index < 94 ? 'below the band' : 'at parity';
    const cls = pos === 'at parity' ? 'ok' : '';
    return `<div class="callout ${cls}"><strong>${hasDorm ? 'Room' : 'Unit'} — ${pos}.</strong> Index ${P.index ?? '—'} against a band median of ${inr(P.bandMedian)},
    ranked ${P.rank ?? '—'} of ${P.rankTotal}. ${within6} competitor${within6===1?'':'s'} sit within ±6% of the current rate.
    ${pos === 'at parity'
      ? 'There is no broad rate headroom — the opportunity here is date-selective, not across the board.'
      : pos === 'below the band'
        ? 'That gap to the band median is the first place to look for headroom.'
        : 'Holding a premium at this level needs the date-by-date evidence in sections 4–6.'}</div>`;
  })() : ''}
</section>

<section>
  <h2>2 · Market Rate Structure</h2>
  <div class="kpis">
    ${kpi('Lowest rate', inr(M.min))}
    ${kpi('Lower quartile', inr(M.q1))}
    ${kpi('Median', inr(M.median))}
    ${kpi('Upper quartile', inr(M.q3))}
    ${kpi('Highest rate', inr(M.max))}
    ${kpi('IQR', inr(M.iqr), 'Q3 − Q1')}
  </div>
  <div class="fig">${histSvg()}</div>
  <div class="cap">Distribution of competitor lead-in rates. Dashed lines mark the property's ${hasDorm&&hasPriv?'two products':'rate'}.</div>
  <div class="callout warn"><strong>Why whole-market comparison is rejected.</strong> At a
  <strong>${M.spread}× spread</strong> (CV ${M.cv}) this set spans very different product classes. Measured against
  all ${M.priced} competitors the ${primaryLabel} indexes ${PRIMARY.adr&&M.median?Math.round(PRIMARY.adr/M.median*100):'—'} — an artefact of range, not a finding.
  All positioning in this report therefore uses a ±40% competitive band around each product's own rate.</div>
</section>

${hasDorm ? `
<section class="pb">
  <h2>3 · Price Positioning — Dorm Bed</h2>
  <div class="fig">${bulletSvg(D, CD)}</div>
  <div class="cap">Grey band = interquartile range of competitor rates; dots = individual competitors.</div>
  ${tbl(['Competitor','Lead-in rate','30-night mean','vs own'],
    [[`<strong>${esc(own.name)} — dorm</strong>`, `<strong>${inr(D.adr)}</strong>`, `<strong>${inr(D.adr)}</strong>`, '<strong>—</strong>']]
      .concat(D.set.map(p => [esc(p.name.slice(0,46)), inr(p.rate), inr(p.mean30),
        `${p.rate>=D.adr?'+':''}${Math.round((p.rate/D.adr-1)*100)}%`])))}
  <h3>Rate headroom</h3>
  ${parityTargets(D.adr, 3).length
    ? tbl(['Target','Rate','Uplift per room-night','%'],
        parityTargets(D.adr, 3).map(t => [`Parity — ${esc(t.name.slice(0,46))}`, inr(t.rate), '+' + inr(t.abs), '+' + t.pct + '%']))
    : '<div class="callout">No priced competitor sits above this rate, so there is no parity target to state.</div>'}
  <p class="sub">Uplift is stated per room-night. This project holds no occupancy or booking data, so total
  revenue impact is not calculable and is deliberately not asserted.</p>
</section>` : ''}

<section>
  <h2>${SN(4)} · Price Positioning${hasDorm ? ' — Private Room' : ''}</h2>
  <div class="fig">${bulletSvg(P, CP)}</div>
  ${P.set.length
    ? tbl(['Competitor','Lead-in rate','30-night mean','vs own'],
        [[`<strong>${esc(own.name)}</strong>`, `<strong>${inr(P.adr)}</strong>`, `<strong>${inr(R0(mean(pS)))}</strong>`, '<strong>—</strong>']]
          .concat(P.set.map(p => [esc(p.name.slice(0,46)), inr(p.rate), inr(p.mean30),
            `${p.rate>=P.adr?'+':''}${Math.round((p.rate/P.adr-1)*100)}%`])))
    : `<div class="callout warn">No priced competitor falls within ±40% of ${inr(P.adr)}, so this ${primaryLabel} has no
       directly comparable set in the current market data. The nearest priced competitors are
       ${esc(priced.slice().sort((a,b)=>Math.abs(a.rate-P.adr)-Math.abs(b.rate-P.adr)).slice(0,3).map(p=>`${p.name.slice(0,30)} (${inr(p.rate)})`).join(', '))}.</div>`}
  ${(() => {
    // "Dense band, minimal pricing power" was asserted regardless of n — it read as a finding
    // over a band of two. Let the density claim follow the count.
    const w6 = P.set.filter(p=>P.adr&&Math.abs(p.rate/P.adr-1)<=0.06).length;
    if (!P.set.length) return '';
    if (P.n >= 8) return `<div class="callout"><strong>Dense band, minimal pricing power.</strong> ${P.n} competitors price
      within ±40% of this ${primaryLabel}, ${w6} of them within ±6%. Rate moves here are highly substitutable.</div>`;
    return `<div class="callout"><strong>Sparse band — rate is weakly constrained.</strong> Only ${P.n} competitor${P.n===1?'':'s'}
      price within ±40% of this ${primaryLabel}${w6?`, ${w6} within ±6%`:', none within ±6%'}. With so few direct comparators, the
      band median is a thin reference and the date-by-date evidence below carries more weight than the cross-section.</div>`;
  })()}
</section>

<section class="pb">
  <h2>${SN(5)} · Rate Trends Over the Booking Window</h2>
  <p class="sub">Night-by-night comparison needs a full 30-night curve per competitor.
  ${curved.length} of ${priced.length} priced competitors currently carry one${curved.length < priced.length
    ? `, so the trend comparisons below run against those ${curved.length} — the tracked competitor set — while sections 2–${SN(4)} use all ${priced.length} market rates.` : '.'}</p>
  ${!hasDorm ? '' : D.curveN ? `<div class="fig">${curveSvg('ownDorm','dBand',CD,`Dorm lead-in vs tracked-competitor median (n=${D.curveN}), night by night`,'dorm')}</div>`
    : `<div class="callout warn">No competitor in the dorm band has a 30-night curve, so no nightly comparison line can be drawn.</div>`}
  ${P.curveN ? `<div class="fig">${curveSvg('ownPriv','pBand',CP,`Private room lead-in vs tracked-competitor median (n=${P.curveN}), night by night`,'room')}</div>`
    : `<div class="fig">${curveSvg('ownPriv','ownPriv',CP,'Private room lead-in, night by night','room')}</div>
       <div class="callout warn"><strong>No comparison line for the room.</strong> None of the ${P.n} competitors in the room's
       price band currently has a 30-night curve, so only the property's own rate movement is shown. Link some of those
       competitors and re-run <code>refresh.js</code> to enable the comparison.</div>`}
  <h3>Rate by night type</h3>
  ${tbl(['Night type', ...(hasDorm?['Own dorm','vs weekday']:[]), hasDorm?'Own room':'Own rate','vs weekday',`Tracked comps (n=${curved.length})`,'vs weekday'],
    NT.filter(t=>ntD[t]||ntP[t]||ntM[t]).map(t => [t,
      ...(hasDorm?[inr(ntD[t]), pD[t]==null?'—':(pD[t]>0?'+':'')+pD[t]+'%']:[]),
      inr(primaryNt[t]), primaryPrem[t]==null?'—':(primaryPrem[t]>0?'+':'')+primaryPrem[t]+'%',
      inr(ntM[t]), pM[t]==null?'—':(pM[t]>0?'+':'')+pM[t]+'%']))}
  <div class="fig">${ntSvg()}</div>
  <div class="fig">${flexSvg()}</div>
  <div class="cap">Peer peak-night premium distribution — p25 ${flexStats.p25}%, median ${flexStats.median}%, p75 ${flexStats.p75}%, max ${flexStats.max}%.</div>
  ${(() => {
    // This used to assert "not pricing flat" unconditionally, quoting a Saturday dorm premium
    // and a Friday room premium that may not exist. Report whichever peak premiums the data
    // actually has, and let the verdict follow them.
    const parts = [];
    if (hasDorm) NT.filter(t=>t!=='Weekday').forEach(t => { if (pD[t]!=null) parts.push(`the dorm's ${t.toLowerCase()} premium of ${pD[t]>0?'+':''}${pD[t]}% (${pctileOf(pD[t],flexVals)}th percentile of competitors)`); });
    NT.filter(t=>t!=='Weekday').forEach(t => { if (primaryPrem[t]!=null) parts.push(`the ${primaryLabel}'s ${t.toLowerCase()} premium of ${primaryPrem[t]>0?'+':''}${primaryPrem[t]}% (${pctileOf(primaryPrem[t],flexVals)}th)`); });
    if (!parts.length) return `<div class="callout warn"><strong>No peak-night premium is measurable.</strong> Every non-weekday night in the window is sold out or unpriced, so rate flex cannot be assessed from this data.</div>`;
    const best = Math.max(...[hasDorm?maxPremium(pD):null, maxPremium(primaryPrem)].filter(x=>x!=null));
    const flat = best <= 2;
    return `<div class="callout ${flat?'warn':'ok'}"><strong>This property is ${flat?'pricing close to flat':'not pricing flat'}.</strong>
    Measured against the peer premium distribution: ${parts.slice(0,4).join(', ')}.
    ${flat ? 'Rate flex capability is not visible in the current window.' : `Peak premium reaches ${best>0?'+':''}${best}%, versus a peer median of ${flexStats.median}%.`}</div>`;
  })()}
</section>

<section class="pb">
  <h2>${SN(6)} · Rate Opportunities</h2>
  ${(() => {
    const t = parityTargets(PRIMARY.adr, 2);
    if (!t.length) return `<div class="callout"><strong>1 · No upward parity target.</strong> Nothing in the priced
    set sits above the ${primaryLabel}'s ${inr(PRIMARY.adr)}, so repricing upward has no competitor reference in this market.</div>`;
    return `<div class="callout"><strong>1 · Reprice the ${primaryLabel} — largest single gain.</strong>
    ${t.map(x => `+${inr(x.abs)}/night (+${x.pct}%) reaches ${esc(x.name.slice(0,40))} parity`).join('; ')}.
    ${PRIMARY.rank === 1 ? 'At either level it stays the cheapest or joint-cheapest rate in its band' : `It currently ranks ${PRIMARY.rank} of ${PRIMARY.rankTotal} in its band`}${gaps.length?`, and the ${inr(gaps[0].width)} (+${gaps[0].pct}%) whitespace above ${inr(gaps[0].from)} means no competitor is encountered`:''}.</div>`;
  })()}
  <div class="fig">${ladderSvg()}</div>
  <div class="callout"><strong>2 · Capture the dates the market is already lifting.</strong>
  ${missed.length ? `On ${missed.length} night${missed.length>1?'s':''} the market median rises ≥4% above its own base while this ${primaryLabel} sits at or below its ADR: <strong>${missed.map(m=>m.d).join(', ')}</strong>.` : `No nights currently show the market lifting while this ${primaryLabel} lags.`}</div>
  ${(() => {
    // "+87%" was hardcoded from the property this report was originally written for.
    const track = hasDorm ? pD : primaryPrem;
    const best  = maxPremium(track);
    const label = hasDorm ? 'dorm' : primaryLabel;
    const belowAdr = hasDorm ? dormFlat : esc8.filter(e => e.pLift != null && e.pLift < 0).length;
    if (best == null) return `<div class="callout"><strong>3 · Peak-date flex cannot be assessed.</strong> No non-weekday
    night in the window has a price for the ${label}, so there is no premium to extend across the calendar.</div>`;
    return `<div class="callout"><strong>3 · Apply the ${label}'s flex to every peak date, not one weekend.</strong>
    The ${label} reaches ${best>0?'+':''}${best}% on its strongest night, yet sits below its own ADR on ${belowAdr} of the
    ${esc8.length} highest market-escalation dates. ${best>2?'The capability exists; the calendar coverage does not.':'Flex is currently minimal on both counts.'}</div>`;
  })()}
  <h3>Highest rate-escalation nights (tracked competitors)</h3>
  ${tbl(['Night','Type','Market median','Market lift', ...(hasDorm?['Own dorm vs ADR']:[]), `Own ${hasDorm?'room':'rate'} vs ADR`],
    esc8.map(e => [e.d, e.t, inr(e.median), (e.lift>0?'+':'')+e.lift+'%',
      ...(hasDorm?[e.dLift==null?'—':(e.dLift>0?'+':'')+e.dLift+'%']:[]),
      e.pLift==null?'—':(e.pLift>0?'+':'')+e.pLift+'%']))}
  <p class="sub">Demand here is inferred purely from competitor rate movement — the dates on which the market raises
  its own median. No availability or occupancy input is used.</p>
</section>

<section>
  <h2>${SN(7)} · Rate Risks</h2>
  ${(() => {
    // Risk 1 used to assert "no floor beneath the dorm" and name ₹502 as the nearest
    // competitor — both fixed constants. Whether a floor exists is a property of the data.
    const adr = PRIMARY.adr, below = floorBelow(adr), above = nearestAbove(adr);
    if (!below) {
      return `<div class="callout warn"><strong>1 · No floor beneath the ${primaryLabel}.</strong> At ${inr(adr)} nothing
      in the priced set is cheaper${above?`; the nearest competitor is ${esc(above.name.slice(0,40))} at ${inr(above.rate)}, +${above.pct}% away`:''}.
      Any undercut leaves no room to respond and converts the rate into a loss-leading position.</div>`;
    }
    const gapPct = Math.round((1 - below.rate/adr) * 100);
    return `<div class="callout ${gapPct<=5?'warn':''}"><strong>1 · ${gapPct<=5?'Thin':'Some'} floor beneath the ${primaryLabel}.</strong>
    The nearest cheaper competitor is ${esc(below.name.slice(0,40))} at ${inr(below.rate)}, ${gapPct}% below this rate${above?`, and the nearest above is ${esc(above.name.slice(0,40))} at ${inr(above.rate)} (+${above.pct}%)`:''}.
    ${gapPct<=5?'That leaves very little room to respond to an undercut.':'There is room to absorb an undercut without going to the bottom of the market.'}</div>`;
  })()}
  <div class="callout warn"><strong>2 · The ${primaryLabel} sits in a ${PRIMARY.n>=8?'crowded':'sparse'} band.</strong> ${PRIMARY.n} competitors within ±40% and
  ${PRIMARY.set.filter(p=>PRIMARY.adr&&Math.abs(p.rate/PRIMARY.adr-1)<=0.06).length} within ±6% means rate is ${PRIMARY.n>=8?'not a defensible differentiator at the current level':'only weakly constrained by direct comparison'}.</div>
  ${(() => {
    const cv = PRIMARY.cv, peerCv = flex.map(f=>f.cv).filter(Boolean);
    if (cv == null || !Number.isFinite(cv)) return '';
    const p = peerCv.length ? pctileOf(cv, peerCv) : null;
    return `<div class="callout warn"><strong>3 · ${primaryLabel[0].toUpperCase()+primaryLabel.slice(1)} rate movement.</strong> CV ${cv}
    ${p!=null?`(${p}th percentile of competitors)`:''} across the window${maxPremium(primaryPrem)!=null?`, peaking at ${maxPremium(primaryPrem)>0?'+':''}${maxPremium(primaryPrem)}% over weekday`:''}.
    ${p!=null&&p>=60?'That is more volatile than most peers — check it follows a calendar rule rather than ad-hoc moves.':'That is in line with or below peer volatility.'}</div>`;
  })()}
</section>

<section>
  <h2>${SN(8)} · Basis &amp; Method</h2>
  ${tbl(['Item','Detail'],[
    ['Rate window', `${dates[0]} → ${dates[dates.length-1]} (${dates.length} nights, forward-looking)`],
    ['Rate metric', 'Lead-in rate — cheapest available room per property per night'],
    ['Competitor rates', `${M.priced} priced of ${M.n} tracked; ${curved.length} with ≥20-night curves`],
    ['Price basis', 'All competitor rates normalised to one basis (earliest available night, cheapest room, INR)'],
    ['Competitive band', '±40% of the property\'s own lead-in ADR, computed separately per product'],
    ['Demand signal', 'Inferred from competitor rate escalation only'],
    ['Night typing', 'Weekday / Friday / Saturday / Sunday / long weekend via the project holiday calendar'],
    ['Source', `Booking.com via ${esc(dash.meta?.source || 'booking.com')}, scraped ${esc(scraped)}`],
  ])}
  <h3>Own rate detail by room type</h3>
  ${tbl(['Room type','Group','Nights priced','Min','Mean','Max','CV'],
    roomRows.map(r => [esc(r.name), r.group, String(r.nights), inr(r.min), inr(r.mean), inr(r.max), String(r.cv)]))}
  <div class="callout warn"><strong>Out of scope by instruction.</strong> This report analyses rates and pricing only.
  Guest ratings, review volume, distance, amenities and property quality are excluded. Occupancy, ADR-vs-budget,
  RevPAR and revenue impact are not calculated — no booking or revenue data exists in this project, and any such
  figure would be fabricated.</div>
  <div class="foot">Generated ${stamp} from ${M.priced} competitor rates and ${dates.length} nights of forward rate data.
  Rates change continuously; re-run before acting on specific figures.</div>
</section>`;

// ── write ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUTDIR, { recursive: true });
const base2 = `rate-analysis-${PROP}-${stamp}`;
const htmlPath = path.join(OUTDIR, base2 + '.html');
fs.writeFileSync(htmlPath, html);
console.log(`  ✓ HTML → reports/${base2}.html`);

if (HTML_ONLY) process.exit(0);

(async () => {
  const { chromium } = require('playwright');
  const exe = findChrome();
  // Headless is required: page.pdf() is unsupported when driving a headful browser
  const browser = await chromium.launch(exe ? { executablePath: exe, headless: true } : { headless: true });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  const pdfPath = path.join(OUTDIR, base2 + '.pdf');
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true,
    margin: { top: '14mm', bottom: '14mm', left: '13mm', right: '13mm' },
    displayHeaderFooter: true, headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;font:8px 'Segoe UI',sans-serif;color:#9ca3af;padding:0 13mm;display:flex;justify-content:space-between">
      <span>Rate &amp; Pricing Analysis — ${esc(own.name)}</span><span class="pageNumber"></span></div>` });
  await browser.close();
  const kb = Math.round(fs.statSync(pdfPath).size/1024);
  console.log(`  ✓ PDF  → reports/${base2}.pdf  (${kb} KB)`);
})().catch(e => { console.error('  PDF FAILED:', e.message); process.exit(1); });
