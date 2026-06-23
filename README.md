# SnuggPro Inspector

A local proxy and browser UI to pull SnuggPro job records by ID and inspect them without navigating the SnuggPro web app. Includes a Measures Table that flattens recommendations and direct-install line items into a sortable, exportable grid for reporting and import.

## Why a proxy?

The SnuggPro API (`https://api.snuggpro.com`) does not send CORS headers, so a browser cannot call it directly. `proxy.js` runs locally, signs each request with your API keys (HMAC-SHA256), forwards it to SnuggPro, and returns the response to the browser with CORS enabled. Keys never leave your machine.

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy the env template and add your keys:
   ```
   cp .env.example .env
   ```
   Generate keys at: Settings > Your Companies > Your company > App Integrations > Generate API Key.
3. Start the proxy:
   ```
   npm start
   ```
   You should see `SnuggPro proxy running -> http://localhost:3001`.
4. Open `snuggpro-inspector.html` in Chrome.

Leave the proxy terminal running while you use the inspector.

## Usage

- Enter a Job ID (visible in the SnuggPro URL: `app.snuggpro.com/jobs/XXXXX`) and click Fetch.
- Sidebar groups every GET endpoint (job, building systems, appliances, program/financials, account/company).
- Toggle Fields vs Raw JSON; Copy exports the full JSON for the active endpoint.
- Click any cell value to copy it to the clipboard.

### Measures Table (Reporting)

Pulls `/jobs/{id}/all-data` and flattens line items into one sortable grid:

- **REC rows** — active recommendations only (`status == "1"`), carrying modeled savings (saved kWh / Therms / MMBTU). Declined measures are excluded.
- **DI rows** — direct-install line items, carrying deemed savings. Deemed values are per-unit in the API and are multiplied by quantity here so totals reconcile.
- **Combined summary** — sums modeled + deemed into one reportable figure and flags the reporting basis from `combinedTotalEnergySavings`: over 15% defaults to modeled (saved); 5-15% to deemed; under 5% is flagged for review.
- **Download CSV** — exports the full flattened set for import.

## Files

- `proxy.js` — local signing proxy
- `snuggpro-inspector.html` — browser UI (no build step, no framework)
- `.env` — your API keys (gitignored, never committed)
- `.env.example` — template
- `swagger.json` — SnuggPro API spec for reference (optional)

## Notes

- Single-file HTML, no build step. Edit and reload.
- Auth uses the Web Crypto API in the browser only for the standalone key-entry mode; the proxy path signs server-side from `.env`.
