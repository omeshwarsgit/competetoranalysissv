'use strict';
/**
 * verify-dashboard.js — end-to-end check that the dashboard actually renders.
 *
 * The unit tests cover the CSV contract; this covers the half that only a browser can:
 * it drives the real dashboard in the CDP Chrome this project already uses, visits every
 * panel for every property, and reports what rendered plus any console/page errors. This is
 * how BUG-004 (the Leaflet null-latLng crash) was confirmed fixed — a null coordinate throws
 * from inside Leaflet at render time, which no amount of Node-side testing would catch.
 *
 * Requires a running server. Exits non-zero if any panel errors or renders nothing.
 *
 * Usage:
 *   node serve.js --no-open &            # or: PORT=3199 node serve.js --no-open
 *   node verify-dashboard.js                       # port 3000, properties from the CSV
 *   node verify-dashboard.js --port=3199
 *   node verify-dashboard.js --properties=1,3,6
 *   node verify-dashboard.js --screenshots=./shots
 *   node verify-dashboard.js --theme=light         # one theme only (default: both)
 */
const { chromium } = require('playwright');
const { ensureChrome, CDP_URL } = require('./lib/chrome');
const { readProperties } = require('./lib/csv-properties');
const path = require('path');

const PANELS = ['overview', 'calendar', 'longwknds', 'analysis', 'suggestions', 'discover', 'history'];

const arg = n => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const PORT  = arg('port') || process.env.PORT || '3000';
const SHOTS = arg('screenshots');
const PROPS = (arg('properties') || '').split(',').filter(Boolean);

// The dashboard ships two themes and remembers the choice in localStorage, so a light-theme-only
// rendering fault is invisible to a dark-theme-only run. Both are checked by default.
const THEME_ARG = (arg('theme') || 'both').toLowerCase();
const THEMES = THEME_ARG === 'both' ? ['dark', 'light'] : [THEME_ARG];
if (THEMES.some(t => t !== 'dark' && t !== 'light')) {
  console.error(`--theme must be dark, light or both (got "${THEME_ARG}")`);
  process.exit(1);
}

// A panel that renders almost nothing is a failure, not a pass. These floors are set well
// below what a property with data produces, so they catch "blank panel" without being brittle.
const MIN_CHARS = { overview: 300, calendar: 500, longwknds: 300, analysis: 300, suggestions: 200, discover: 100, history: 60 };

(async () => {
  const ids = PROPS.length
    ? PROPS
    : readProperties(path.join(__dirname, 'properties.csv')).properties.map(p => p.id);
  if (!ids.length) { console.error('No properties to verify.'); process.exit(1); }

  await ensureChrome();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = await browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });

  const consoleErrors = [], pageErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));

  // Opening a panel must never start a Booking.com crawl. The Discover panel used to fire a
  // `force: true` scan whenever its cache was over 24h old, so a run of this very suite launched
  // one scan per property in the background — rewriting the discovery cache and
  // config/properties.json while the pages it was checking were still rendering.
  const forcedScans = [];
  page.on('request', r => {
    if (r.method() !== 'POST') return;
    if (!/\/api\/discover\/(start|scan-all)$/.test(new URL(r.url()).pathname)) return;
    let body = {};
    try { body = JSON.parse(r.postData() || '{}'); } catch (_) {}
    if (body.force) forcedScans.push(`${new URL(r.url()).pathname} propId=${body.propId || '-'}`);
  });

  const failures = [];

  // Every colour in the dashboard is a CSS custom property so the two themes stay in step. The
  // failure mode that check exists to catch is a surface that was hardcoded for one theme while
  // its text kept reading var(--text): the Leaflet popups and the confirm modal were pinned to
  // #1E2130 / #161924, so in light theme they rendered near-black text on a near-black box. A
  // panel sweep cannot see that — a popup only exists after a click, and the text is *present*,
  // just invisible. So assert the invariant at the token level instead: every surface a theme
  // defines must contrast with that theme's body text.
  const checkThemeTokens = (thm) => page.evaluate((theme) => {
    const cs = getComputedStyle(document.documentElement);
    const tok = n => cs.getPropertyValue(n).trim();
    // Accepts #rgb, #rrggbb, rgb() and rgba(); returns [r,g,b,a].
    const parse = (s) => {
      if (!s) return null;
      if (s[0] === '#') {
        const h = s.slice(1);
        const x = h.length === 3 ? h.split('').map(c => c + c) : h.match(/../g);
        if (!x || x.length < 3) return null;
        return [...x.slice(0, 3).map(v => parseInt(v, 16)), 1];
      }
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (p.length < 3 || p.slice(0, 3).some(Number.isNaN)) return null;
      return [p[0], p[1], p[2], p.length > 3 && !Number.isNaN(p[3]) ? p[3] : 1];
    };
    // A translucent film (--surface, --overlay-veil) is only ever seen over the page background,
    // so judge it composited, the way the eye meets it.
    const over = (fg, bg) => fg[3] >= 1 ? fg
      : [0, 1, 2].map(i => Math.round(fg[i] * fg[3] + bg[i] * (1 - fg[3]))).concat(1);
    const chan = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = c => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2]);
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };

    const bg   = parse(tok('--bg'));
    const text = parse(tok('--text'));
    if (!bg || !text) return [`theme ${theme}: --bg or --text is unreadable`];

    // Body text must clear WCAG AA (4.5). Muted text is secondary by design, so it is held to the
    // large-text bar (3.0) — enough to catch "invisible", not so tight it fails a deliberate hint.
    const SURFACES = ['--bg', '--sidebar-bg', '--popup-bg', '--modal-bg', '--chart-bg', '--overlay-veil',
                      '--surface', '--surface-2', '--surface-3'];
    const FG = [['--text', 4.5], ['--text-muted', 3.0]];
    const out = [];
    for (const s of SURFACES) {
      const raw = tok(s);
      if (!raw) { out.push(`theme ${theme}: ${s} is not defined`); continue; }
      const sc = parse(raw);
      if (!sc) { out.push(`theme ${theme}: ${s} ("${raw}") is unparseable`); continue; }
      const solid = over(sc, bg);
      for (const [f, min] of FG) {
        const fc = parse(tok(f));
        if (!fc) continue;
        const r = ratio(over(fc, solid), solid);
        if (r < min) out.push(`theme ${theme}: ${f} on ${s} is ${r.toFixed(2)}:1 (needs ${min}:1) — unreadable`);
      }
    }
    return out;
  }, thm);

  // Applied the way the app itself does it, so a reload keeps the theme and the panels re-render
  // with it (Chart.js bakes its colours in at construction time).
  const setTheme = (theme) => page.evaluate((t) => {
    localStorage.setItem('sv-theme', t);
    document.documentElement.dataset.theme = t;
  }, theme);

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  // The sidebar status shipped as a literal "Loading…" that only the SSE refresh handler ever
  // overwrote, so a fully-loaded dashboard still claimed to be loading until someone hit Refresh.
  const sbStatus = (await page.textContent('#lastUpdated').catch(() => ''))?.trim() || '';
  console.log(`sidebar status: "${sbStatus}"`);
  if (/^loading/i.test(sbStatus) || !sbStatus) {
    failures.push(`sidebar status is still "${sbStatus || '(empty)'}" after load — it must report data freshness`);
  }

  const opts = await page.$$eval('#propSelect option', els => els.map(e => e.value));
  console.log(`dropdown: ${opts.length} option(s); verifying ${ids.length}\n`);
  for (const id of ids) {
    if (!opts.includes(id)) failures.push(`property ${id} is in properties.csv but absent from the dropdown`);
  }

  for (const theme of THEMES) {
   await setTheme(theme);
   await page.waitForTimeout(250);
   console.log(`\n════════ ${theme.toUpperCase()} THEME ════════`);
   for (const issue of await checkThemeTokens(theme)) failures.push(issue);

   for (const pid of ids.filter(i => opts.includes(i))) {
    await page.selectOption('#propSelect', pid);
    await page.waitForTimeout(700);
    console.log(`───── property ${pid} ─────`);
    for (const panel of PANELS) {
      await page.click(`.nav-item[data-panel="${panel}"]`);
      await page.waitForTimeout(panel === 'discover' ? 7000 : 1500);
      const r = await page.evaluate((p) => {
        const el = document.getElementById('panel-' + p);
        const txt = el ? el.innerText : '';
        // Competitor names are real Booking.com listings and contain ordinary English words —
        // one of them is "…Riverfront Estate with 2 Infinity Pools…", which a bare search for
        // "Infinity" flags as a broken number. Only treat these as artifacts when they sit
        // where a VALUE would: next to a currency symbol, sign, percent or multiplier.
        //
        // Also caught here, each from a bug this suite previously passed straight over:
        //   **bold**          markdown injected via innerHTML, rendered as literal asterisks
        //   Position Score:-N a negative percentage where only 0–100 is meaningful — it computed
        //                     (null-1)/(n-1) when the property had no rate tonight
        //   over 0 snapshots  a statistic reported over an empty sample ("Most Stable Competitor
        //                     (volatility ₹0 over 0 snapshots)" — chosen because nothing was known)
        //   of 0 nights       same shape, for the occupancy/coverage figures
        //   : null            a null leaking into visible text
        //
        // Note: a bare "₹0" is NOT an artifact. Revenue upside and risk are genuinely 0 when no
        // night qualifies, and the Discover price slider's floor label is literally "₹0".
        //
        // `(?!\s+[A-Za-z])` is what keeps property names out of this. The market pool holds real
        // listings called "…Luxury 5BR Villa - Infinity Pool & Sea View" and "…Riverfront Estate
        // with 2 Infinity Pools…", and the leading hyphen satisfies the sign test on its own. A
        // genuine artifact is never followed by another word: it is "₹Infinity", "NaN%", "(undefined)".
        const BAD = String.raw`(?:Infinity|NaN|undefined)(?!\s+[A-Za-z])`;
        const ARTIFACT = new RegExp(
          `(?:[₹+\\-=(]\\s?${BAD})|(?:${BAD}\\s?[%×)/])`
          + String.raw`|\[object Object\]|Error loading|\*\*[^*\n]{1,60}\*\*`
          + String.raw`|Position Score:\s*-\d|over 0 snapshots|of 0 nights|:\s?null\b`
        );
        const m = txt.match(ARTIFACT);
        return {
          chars:    txt.replace(/\s+/g, ' ').trim().length,
          rows:     el ? el.querySelectorAll('tr').length : 0,
          soldOut:  (txt.match(/Sold Out/g) || []).length,
          errorish: !!m,
          // Show the artifact in context, not the top of the panel — the offending text is
          // usually far down and the first 90 chars say nothing about it.
          sample:   m ? txt.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, ' ').trim()
                      : txt.replace(/\s+/g, ' ').trim().slice(0, 90),
        };
      }, panel);
      const thin = r.chars < (MIN_CHARS[panel] || 50);
      if (r.errorish) failures.push(`[${theme}] property ${pid} / ${panel}: suspect text — "${r.sample}"`);
      if (thin)       failures.push(`[${theme}] property ${pid} / ${panel}: rendered only ${r.chars} chars`);
      console.log(`   ${panel.padEnd(11)} chars=${String(r.chars).padStart(5)} rows=${String(r.rows).padStart(3)}`
                + ` soldOut=${String(r.soldOut).padStart(3)}${r.errorish ? ' ⚠ SUSPECT TEXT' : ''}${thin ? ' ⚠ THIN' : ''}`);
      if (r.errorish) console.log(`      -> "${r.sample}"`);
    }
    console.log('');
   }

   if (SHOTS) {
    for (const panel of ['overview', 'calendar', 'analysis', 'discover']) {
      await page.click(`.nav-item[data-panel="${panel}"]`);
      await page.waitForTimeout(panel === 'discover' ? 4000 : 1500);
      await page.screenshot({ path: path.join(SHOTS, `${panel}-${theme}.png`) });
    }
    console.log(`screenshots (${theme}) → ${SHOTS}\n`);
   }
  }

  for (const s of forcedScans) failures.push(`a forced scan was triggered just by browsing: ${s}`);

  console.log(`forced scans        : ${forcedScans.length}`);
  console.log(`console errors      : ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach(e => console.log('   ! ' + e.slice(0, 150)));
  console.log(`uncaught page errors: ${pageErrors.length}`);
  pageErrors.slice(0, 10).forEach(e => console.log('   !! ' + e.slice(0, 150)));

  await page.close();
  await browser.close();

  const total = failures.length + consoleErrors.length + pageErrors.length;
  if (total) {
    console.log(`\n✗ ${total} problem(s):`);
    failures.forEach(f => console.log('   - ' + f));
    process.exit(1);
  }
  console.log(`\n✓ ${ids.length} propert${ids.length===1?'y':'ies'} × ${PANELS.length} panels`
            + ` × ${THEMES.length} theme${THEMES.length===1?'':'s'} (${THEMES.join(', ')}) rendered with no errors.`);
})().catch(e => { console.error('VERIFY FAILED:', e.message); process.exit(1); });
