# Google Sheets pricing sync — setup

Replaces the old positional `data/latest.csv` export with a live Google Sheet.

There are **two transports**. Pick one; `sync-sheets.js` auto-detects which from
`config/sheets.json`.

| | **A — Apps Script** (recommended) | **B — Service account** |
|---|---|---|
| Google Cloud project | not needed | required |
| Service-account key file | not needed | required |
| Share the sheet | not needed | required (Editor) |
| Setup time | ~3 min | ~10 min |
| Credential | shared secret string | RSA private key |
| Runs unattended | yes | yes |
| Best when | you just want it working | you need server-to-server auth or many sheets |

Everything else — column mapping, upsert, change detection, audit log — is identical,
because both transports share `lib/pricing-rows.js`.

---

# A · Apps Script setup (recommended)

The script is bound to your sheet and runs as you, so there are no keys to manage.
Node pushes pricing rows to it over HTTPS.

### 1. Open the script editor

In your Google Sheet: **Extensions → Apps Script**.

### 2. Paste the receiver

Delete the placeholder `myFunction`, then paste the whole contents of
[`apps-script/Code.gs`](apps-script/Code.gs).

### 3. Set the shared secret

At the top of the script, replace the placeholder:

```js
var SHARED_SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
```

Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Save (Ctrl+S).

### 4. Deploy as a Web App

**Deploy → New deployment → ⚙ → Web app**

- **Execute as:** Me
- **Who has access:** **Anyone**

Authorise when prompted (you'll see an "unverified app" warning — it's your own
script; choose **Advanced → Go to … (unsafe)**).

Copy the deployment URL. It ends in `/exec`.

> **Why "Anyone"?** Node calls the URL without a Google login, so the endpoint must
> accept anonymous requests. `SHARED_SECRET` is what actually protects it — anyone
> with both the URL *and* the secret could write to the sheet, so treat the pair as
> a password. The script rejects any request whose secret doesn't match.

### 5. Point the sync at it

```bash
cp config/sheets.example.json config/sheets.json
```

Edit `config/sheets.json`:

```json
{
  "webAppUrl": "https://script.google.com/macros/s/AKfy.../exec",
  "sharedSecret": "the-same-string-you-put-in-Code.gs",
  "syncIntervalSec": 900
}
```

### 6. Verify, then go live

```bash
npm run sync:health   # confirms the deployment answers and the secret is set
npm run sync:dry      # shows rows + column mapping, writes nothing
npm run sync          # first real sync — creates the three tabs
```

---

# B · Service-account setup (alternative)

1. <https://console.cloud.google.com/> → create/pick a project.
2. **APIs & Services → Library →** "Google Sheets API" → **Enable**.
3. **Credentials → Create credentials → Service account** (no roles needed).
4. Open it → **Keys → Add key → Create new key → JSON**. Save as
   `config/google-service-account.json` (or set `GOOGLE_APPLICATION_CREDENTIALS`).
5. Create the sheet, copy its id from the URL
   (`/spreadsheets/d/`**`1AbC...`**`/edit`).
6. **Share** the sheet as **Editor** with the service account's `client_email`
   (`name@project.iam.gserviceaccount.com`). Skipping this is the usual cause of 403s.
7. `config/sheets.json`: `{ "spreadsheetId": "1AbC...", "syncIntervalSec": 900 }`
   and **no** `webAppUrl`.

The key is in `.gitignore` — never commit it.

---

# Running it automatically

| Command | Behaviour |
|---|---|
| `npm run sync` | One sync now. Skips if prices are unchanged. |
| `npm run sync -- --force` | Sync even when unchanged. |
| `npm run sync:watch` | **Recommended.** Syncs on startup, then on every change to `data/latest.dashboard.json`, plus the configured interval. |
| `npm run sync:dry` | Show what would be written. |
| `npm run sync:health` | Apps Script only — ping the deployment. |
| `npm run scrape:sync` | Scrape prices then sync immediately. |
| `setup-sheets-sync.bat` | Registers watch mode as a Windows task at logon. |

Watch mode is the reliable option: it reacts to the *data* changing, whatever
triggered the scrape — CLI, the dashboard Refresh button, or a scheduled task.

Flags: `--property=1`, `--dry-run`, `--force`, `--interval=900`, `--health`,
`--trigger=<label>` (labels the Sync Log row).

---

# What lands in the sheet

### `Rates` — one row per property × room type × stay date

The pricing fact table, long/tidy so Sheets pivot tables work directly on it.

`Key` · `Property ID` · `Property Name` · `Role` · `Tracked For` · `Booking Slug` ·
`Room Key` · `Room Name` · `Occupancy` · `Bed Type` · `Primary Room` · `Stay Date` ·
`Day` · `Night Type` · `Rate (INR)` · `Available` · `Currency` · `Source` ·
`Scraped At` · `Last Synced`

Unavailable nights are written with a blank rate and `Available = No`, so sold-out
dates are visible rather than missing.

### `Property Summary` — one row per property

`Key` · `Property ID` · `Property Name` · `Role` · `Tracked For` · `Booking Slug` ·
`City` · `Property Type` · `Room Types` · `Nights Priced` · `Nights Unavailable` ·
`Lead-in Rate (INR)` · `Lead-in ADR 30N` · `Min Rate` · `Max Rate` · `Median Rate` ·
`Rate Spread x` · `Rate CV` · `Weekday Mean` · `Peak Mean` · `Peak Premium %` ·
`Price Index vs Band` · `Rank in Band` · `Band Size` · `Currency` · `Scraped At` ·
`Last Synced`

### `Sync Log` — one row per run

Timestamp, trigger, data hash, rows built/added/updated/unchanged, duration, status,
error detail. Your audit trail for "did it actually run".

---

# Duplicates and data integrity

- **Natural key in column A.** `Rates` uses `propertyId|roomKey|stayDate`,
  `Property Summary` uses `propertyId`. Each run **updates** rows whose values
  changed and **appends** only new keys. Re-running identical data is a no-op —
  no duplicate rows.
- **No destructive deletes.** Rows the current scrape no longer covers are left
  alone, so dates ageing out of the 30-night window remain as history.
- **Change detection.** A SHA-256 of the payload (excluding `Last Synced`) is kept
  in `data/sheets-sync-state.json`; unchanged data is skipped, so watch mode
  doesn't churn quota or version history.
- **Header repair.** A drifted header row is rewritten before any data is written,
  so columns can never silently misalign.
- **Only changed rows are written.**
- **Concurrency.** The Apps Script path takes a `LockService` lock, so two
  overlapping posts can't interleave a read-merge-write.
- **Retries.** Network errors, 429 and 5xx get exponential backoff.

# Limits worth knowing

- Apps Script transport chunks at 2,000 rows/request (`chunkSize` in config) to stay
  inside the 6-minute execution limit. Each chunk is an independent keyed upsert, so
  chunking cannot create duplicates and a failed chunk is safe to retry.
- Sheets allows 10M cells per spreadsheet — at 20 columns, `Rates` supports roughly
  500k rows. Current volume is ~1,250 rows.
- "Real time" is bounded by the scraper: rates change in the sheet only when
  `refresh.js` produces new prices. Watch mode propagates them within seconds.

# Troubleshooting

| Symptom | Cause |
|---|---|
| Web App returned a Google sign-in page | Deployment isn't public. Re-deploy with **Who has access: Anyone**. |
| `Rejected: sharedSecret … does not match` | `config/sheets.json` and `Code.gs` disagree. |
| `webAppUrl must end in /exec` | You copied the `/dev` test URL, which only works while logged in. |
| `SHARED_SECRET not set in Code.gs` | Step A.3 skipped. |
| `403 The caller does not have permission` (service account) | Sheet not shared with `client_email` as Editor. |
| `Token exchange failed (400)` (service account) | Key JSON malformed, or `private_key` newlines mangled by copy-paste. |
| "unchanged — nothing to sync" | Correct behaviour. Use `--force`. |
| Edited `Code.gs` but nothing changed | Apps Script serves the last **deployment**. Deploy → Manage deployments → edit → **New version**. |
