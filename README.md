# SnuggPro Inspector

A local proxy and browser UI to pull SnuggPro job records by ID and inspect them without navigating the SnuggPro web app. Includes a Measures Table that flattens recommendations and direct-install line items into a sortable, exportable grid for reporting and import.

## Why a proxy?

The SnuggPro API (`https://api.snuggpro.com`) does not send CORS headers, so a browser cannot call it directly. A proxy signs each request with your API keys (HMAC-SHA256), forwards it to SnuggPro, and returns the response to the browser. There are two ways to run it:

- **Hosted (for the team)** — a Cloudflare Worker (`worker.js`) serves the UI, gates access behind an email-code login, and signs requests. Teammates just open a link and sign in — no install. See [Team deployment](#team-deployment-cloudflare-worker).
- **Local (for solo use)** — `proxy.js` runs on `localhost:3001` exactly as before. See [Local solo use](#local-solo-use-proxyjs).

## Team deployment (Cloudflare Worker)

Hosts the inspector for your team with **email one-time-code** login. No Node, no install, and no Google account required for your team — they open a bookmarked `*.workers.dev` link, type their email, paste the 6-digit code they receive, and the tool runs in their browser. Free tier; no custom domain or DNS changes needed.

**→ Full step-by-step guide: [SETUP.md](SETUP.md)** (prerequisites, configure, deploy, manage). The short version:

```bash
npm install
npx wrangler login
# set ALLOWED_EMAILS + FROM_EMAIL in wrangler.toml, then add the program key pairs + session/email:
npx wrangler secret put REGION1_PUBLIC_KEY    # + REGION1_PRIVATE_KEY, REGION2_*, SDGE_*, SCE_*
npx wrangler secret put SESSION_SECRET        # + EMAIL_API_KEY
npx wrangler deploy                           # prints your https://…workers.dev URL — share it
```

To add/remove a teammate later: edit `ALLOWED_EMAILS` in `wrangler.toml` and `npx wrangler deploy` (effective immediately). See [SETUP.md](SETUP.md) for the rest, including local testing with `npx wrangler dev`.

## Local solo use (proxy.js)

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
4. Open `public/index.html` in Chrome — but note: the UI now uses a same-origin `/proxy` path, so opening it directly via `file://` won't reach `localhost:3001`. For local use, prefer the Worker dev server (`npx wrangler dev`, see above), which serves the UI and proxy together. `proxy.js` remains as an offline fallback.

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

### Usage / Billing (Reporting)

Also pulls `/jobs/{id}/all-data` and flattens the `utilities` bill history into one row per fuel per billing period:

- **Columns** — Job, Fuel (Electric/Gas), Bill Start, Bill End, Billed Days, Usage, Units, MMBTU.
- **Billed Days** is computed from the two read dates; each period runs from the prior read date to the current one.
- **MMBTU** is computed from usage (kWh × 3,412.14 BTU; therm × 100,000 BTU) and left blank when a bill is entered in dollars.
- **Download CSV** — exports the full set (`usage_job_{id}.csv`) at full precision.
- Supports multiple Job IDs at once; the TOTAL row sums billed days and MMBTU (usage is mixed-unit, so its total is omitted).

## Files

- `worker.js` — Cloudflare Worker: email-code login + signing proxy + serves the UI (team deployment)
- `wrangler.toml` — Worker config (allowlist, sender, assets binding)
- `public/index.html` — browser UI (no build step, no framework)
- `proxy.js` — local signing proxy (solo/offline fallback)
- `.env` — your API keys for `proxy.js` (gitignored, never committed)
- `.env.example` — template for `proxy.js`
- `.dev.vars` / `.dev.vars.example` — secrets for local `wrangler dev` (gitignored)
- `swagger.json` — SnuggPro API spec for reference (optional)

## Notes

- Single-file HTML, no build step. Edit and reload.
- Auth uses the Web Crypto API in the browser only for the standalone key-entry mode; the proxy path signs server-side from `.env`.
