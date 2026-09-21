/**
 * lib/sheets-appscript.js
 *
 * Sync transport that POSTs pricing rows to a bound Apps Script Web App.
 *
 * Chosen over the service-account REST path when config/sheets.json has a
 * webAppUrl. Needs no Google Cloud project, no service-account key and no sheet
 * sharing — the script runs as the sheet's owner. The shared secret is the only
 * credential.
 */
'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Apps Script /exec answers a POST with a 302 to script.googleusercontent.com.
// fetch follows it and returns the real body — the write has already happened by
// the time the redirect is issued.
async function post(url, payload, attempt = 0) {
  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    text = await res.text();
  } catch (e) {
    if (attempt < 4) { await sleep(1500 * 2 ** attempt); return post(url, payload, attempt + 1); }
    throw new Error(`Web App unreachable: ${e.message}`);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt < 4) { await sleep(2000 * 2 ** attempt); return post(url, payload, attempt + 1); }
  }

  let json;
  try { json = JSON.parse(text); }
  catch (_) {
    // A login page instead of JSON means the deployment isn't public
    if (/accounts\.google\.com|Sign in/i.test(text)) {
      throw new Error(
        'Web App returned a Google sign-in page. Re-deploy with "Who has access: Anyone" ' +
        '(Deploy → Manage deployments → edit → Who has access).'
      );
    }
    throw new Error(`Web App returned non-JSON (${res.status}): ${text.slice(0, 250)}`);
  }

  if (!json.ok) {
    if (json.error === 'unauthorized') {
      throw new Error('Rejected: sharedSecret in config/sheets.json does not match SHARED_SECRET in Code.gs.');
    }
    throw new Error(`Web App error: ${json.error || JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

/**
 * Push rows in chunks. Each chunk is a self-contained upsert keyed on column A,
 * so chunking cannot create duplicates and a failed chunk can simply be retried.
 */
async function sync(cfg, built, cols, logRow, opts = {}) {
  const { webAppUrl, sharedSecret } = cfg;
  if (!webAppUrl) throw new Error('No webAppUrl in config/sheets.json.');
  if (!sharedSecret) throw new Error('No sharedSecret in config/sheets.json.');
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(webAppUrl)) {
    throw new Error(`webAppUrl does not look like an Apps Script URL: ${webAppUrl}`);
  }
  if (!/\/exec\/?$/.test(webAppUrl)) {
    throw new Error('webAppUrl must end in /exec (a /dev URL only works while you are logged in).');
  }

  const CHUNK = Math.max(200, opts.chunkSize || 2000);
  const totals = { added: 0, updated: 0, unchanged: 0 };
  let sumTotals = { added: 0, updated: 0, unchanged: 0 };

  const rateChunks = [];
  for (let i = 0; i < built.rateRows.length; i += CHUNK) rateChunks.push(built.rateRows.slice(i, i + CHUNK));
  if (!rateChunks.length) rateChunks.push([]);

  for (let i = 0; i < rateChunks.length; i++) {
    const isLast = i === rateChunks.length - 1;
    const payload = {
      secret: sharedSecret,
      isLastChunk: isLast,
      rates: { tab: opts.ratesTab || 'Rates', headers: cols.RATES_COLS, rows: rateChunks[i] },
    };
    // wipe stale rows once, before the first chunk lands — only the tabs being written
    if (i === 0 && opts.reset) payload.reset = opts.resetTabs || [payload.rates.tab];
    // send the summary and the log line with the final chunk
    if (isLast) {
      if (built.sumRows && built.sumRows.length) payload.summary = { tab: 'Property Summary', headers: cols.SUM_COLS, rows: built.sumRows };
      if (logRow) payload.log = { headers: cols.LOG_COLS, row: logRow };
    }
    const out = await post(webAppUrl, payload);
    if (out.tabs?.rates) {
      totals.added += out.tabs.rates.added || 0;
      totals.updated += out.tabs.rates.updated || 0;
      totals.unchanged += out.tabs.rates.unchanged || 0;
    }
    if (out.tabs?.summary) sumTotals = out.tabs.summary;
    if (rateChunks.length > 1) {
      console.log(`    chunk ${i + 1}/${rateChunks.length}: +${out.tabs?.rates?.added || 0} added · ${out.tabs?.rates?.updated || 0} updated`);
    }
  }

  console.log(`  Rates: +${totals.added} added · ${totals.updated} updated · ${totals.unchanged} unchanged`);
  console.log(`  Property Summary: +${sumTotals.added || 0} added · ${sumTotals.updated || 0} updated · ${sumTotals.unchanged || 0} unchanged`);
  return { rates: totals, summary: sumTotals };
}

async function health(cfg) {
  const res = await fetch(cfg.webAppUrl, { redirect: 'follow' });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (_) { throw new Error(`Health check returned non-JSON: ${text.slice(0, 200)}`); }
}

module.exports = { sync, health };
