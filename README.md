# SnuggPro Inspector

A local proxy and browser UI to pull SnuggPro job records by ID and inspect them without navigating the SnuggPro web app. Includes a Measures Table that flattens recommendations and direct-install line items into a sortable, exportable grid for reporting and import.

## Why a proxy?

The SnuggPro API (`https://api.snuggpro.com`) does not send CORS headers, so a browser cannot call it directly. A proxy signs each request with your API keys (HMAC-SHA256), forwards it to SnuggPro, and returns the response to the browser. There are two ways to run it:

- **Hosted (for the team)** — a Cloudflare Worker (`worker.js`) serves the UI, gates access behind an email-code login, and signs requests. Teammates just open a link and sign in — no install. See [Team deployment](#team-deployment-cloudflare-worker).
- **Local (for solo use)** — `proxy.js` runs on `localhost:3001` exactly as before. See [Local solo use](#local-solo-use-proxyjs).

## Team deployment (Cloudflare Worker)

Hosts the inspector for ~5 teammates with **email one-time-code** login. No Node, no install, and no Google account required for your team — they open a bookmarked `*.workers.dev` link, type their email, paste the 6-digit code they receive, and the tool runs in their browser. Free tier; no custom domain or DNS changes needed.

### One-time setup (maintainer)

1. **Email sender.** Create a free [SendGrid](https://sendgrid.com) account, do **Single Sender Verification** on one from-address (click the link they email you — no DNS needed), and create an API key.
2. **Install Wrangler & log in:**
   ```
   npm install
   npx wrangler login
   ```
3. **Set the allowlist + sender** in `wrangler.toml`:
   ```toml
   [vars]
   ALLOWED_EMAILS = "alice@acme.com,bob@acme.com"   # who may sign in
   FROM_EMAIL = "you@acme.com"                       # your verified sender
   ```
4. **Set the secrets** (never committed) — a public + private key pair per program, plus session/email:
   ```
   npx wrangler secret put REGION1_PUBLIC_KEY   # then REGION1_PRIVATE_KEY
   npx wrangler secret put REGION2_PUBLIC_KEY   # then REGION2_PRIVATE_KEY
   npx wrangler secret put SDGE_PUBLIC_KEY      # then SDGE_PRIVATE_KEY
   npx wrangler secret put SCE_PUBLIC_KEY       # then SCE_PRIVATE_KEY
   npx wrangler secret put EMAIL_API_KEY        # the SendGrid key
   npx wrangler secret put SESSION_SECRET       # a long random string
   ```
   Generate `SESSION_SECRET` with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   (Only the programs you use need keys; the switcher greys out any with missing keys.)
5. **Deploy** and share the link:
   ```
   npx wrangler deploy
   ```
   Send the team the resulting `https://snuggpro-inspector.<subdomain>.workers.dev` URL to bookmark.

### Add or remove a teammate

Edit the `ALLOWED_EMAILS` line in `wrangler.toml`, then:
```
npx wrangler deploy
```
Removal takes effect immediately (the allowlist is re-checked on every request).

### Local testing of the Worker

```
cp .dev.vars.example .dev.vars   # fill in keys; gitignored
npx wrangler dev                 # serves UI + login + proxy at http://localhost:8787
```

*Deliverability:* without domain authentication, login emails can occasionally land in spam — have teammates check once and mark "not spam." Adding SPF/DKIM **DNS records** at your registrar improves it (records only, no nameserver change) but is optional.

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
