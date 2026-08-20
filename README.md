# SnuggPro Inspector

A local proxy and browser UI to pull SnuggPro job records by ID or customer name and inspect them without navigating the SnuggPro web app. Includes a Measures Table that flattens recommendations and direct-install line items into a sortable, exportable grid for reporting and import.

## Why a proxy?

The SnuggPro API (`https://api.snuggpro.com`) does not send CORS headers, so a browser cannot call it directly. A proxy signs each request with your API keys (HMAC-SHA256), forwards it to SnuggPro, and returns the response to the browser. There are two ways to run it:

- **Hosted (for the team)** — a Cloudflare Worker (`worker.js`) serves the UI, gates access behind an email-code login, and signs requests. Teammates just open a link and sign in — no install. See [Team deployment](#team-deployment-cloudflare-worker).
- **Local (for solo use)** — `proxy.js` on `localhost:3001` serves the UI, the program list, the XLSX template, and the signing proxy, and saves exports into `exports/`. See [Local solo use](#local-solo-use-proxyjs).

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
   You should see `SnuggPro proxy running -> http://localhost:3001`. (If 3001 is busy it auto-binds the next free port.)
4. Open **http://localhost:3001** in Chrome — the proxy serves the UI same-origin, so everything (endpoints, program switcher, exports) just works.

Leave the proxy terminal running while you use the inspector. Exports (CSV/XLSX) are saved into the repo's `exports/` folder in this mode.

### Portable USB (Windows)

Copy the project folder onto a stick and run it on a PC that does **not** have Node installed. The stick still needs internet (the proxy calls `api.snuggpro.com`) and should be writable (exports).

**Once**, on a machine with internet:

1. Copy this folder to the USB drive.
2. Copy `.env.example` to `.env` and fill in your keys (keep the stick private — `.env` holds live API keys).
3. Double-click `setup-portable.bat`. It downloads official Node LTS into `runtime/` (SHA256-checked, not committed) and runs `npm install --omit=dev` onto the stick.

**On any Windows PC after that:** double-click `start-portable.bat`. It starts `proxy.js` with the stick's `runtime\node.exe` (or system Node if `runtime\` is missing), then opens `http://localhost:3001`. Close that window to stop. If 3001 is already in use it just opens the browser.

`runtime/` is gitignored. Re-run setup with `setup-portable.bat -Force` to replace Node. This path is `proxy.js` only — `start.bat` / Wrangler are not portable.

**Alternative: run the hosted stack locally.** `npx wrangler dev` serves the Worker (UI + email login + proxy) at `http://localhost:8787`; set `LOCAL_BYPASS_AUTH=true` in `.dev.vars` to skip the login gate when working solo. On Windows, `start.bat` does checkout/pull/install and launches `wrangler dev` on port 2023 (`stop.bat` / `restart.bat` manage it).

## Usage

- Enter a Job ID (visible in the SnuggPro URL: `app.snuggpro.com/jobs/XXXXX`) or a customer name and click Fetch. Numeric IDs may be separated by commas or spaces. Names containing spaces stay intact; separate multiple names, or a name and an ID, with commas (for example, `Jane Doe, 123456`). Name matching is case-insensitive and supports partial first/last names. Jobs are deduplicated after name matching, so entering the same job by both ID and name fetches it only once. The API's job list contains IDs only, so the first name search for a program builds an in-memory name index and can take longer; later searches reuse it until the page reloads or the program changes.
- Sidebar groups every GET endpoint (job, building systems, appliances, program/financials, account/company).
- Toggle Fields vs Raw JSON; Copy exports the full JSON for the active endpoint.
- Click any cell value to copy it to the clipboard.

### Measures Table (Reporting)

Pulls `/jobs/{id}/all-data` and flattens line items into one sortable grid:

- **REC rows** — active recommendations only (`status == "1"`), carrying modeled savings (saved kWh / Therms / MMBTU). Declined measures are excluded.
- **DI rows** — direct-install line items, carrying deemed savings. Deemed values are per-unit in the API and are multiplied by quantity here so totals reconcile.
- **Combined summary** — sums modeled + deemed into one reportable figure and flags the reporting basis from `combinedTotalEnergySavings`: over 15% defaults to modeled (saved); 5-15% to deemed; under 5% is flagged for review.
- **Download CSV** — exports the full flattened set for import.
- **Export XLSX** — fills the `public/template_range.xlsx` workbook (main/measures/electric/gas sheets) for one or many jobs; against `proxy.js` the file is saved to `exports/`, on the hosted Worker it downloads in the browser.

### Usage / Billing (Reporting)

Also pulls `/jobs/{id}/all-data` and flattens the `utilities` bill history into one row per fuel per billing period:

- **Columns** — Job, Fuel (Electric/Gas), Bill Start, Bill End, Billed Days, Usage, Units, MMBTU.
- **Billed Days** is computed from the two read dates; each period runs from the prior read date to the current one.
- **MMBTU** is computed from usage (kWh × 3,412.14 BTU; therm × 100,000 BTU) and left blank when a bill is entered in dollars.
- **Download CSV** — exports the full set (`usage_job_{id}.csv`) at full precision.
- Supports multiple Job IDs at once; the TOTAL row sums billed days and MMBTU (usage is mixed-unit, so its total is omitted).

### Table 2B (Reporting)

Builds the ESA monthly report's Table 2B — the Pilot Plus and Pilot Deep blocks side by side — from the same job set, and shows what SnuggPro says next to what the numbers should be.

SnuggPro does not choose deemed savings by climate zone: its per-unit values are the CZ10 row of the consolidated measure list for every home. Within one zone the same measure can differ by more than 50× between heating systems, and across zones by up to 7×, which is why jobs near the 5% and 15% path boundaries land in the wrong block. This view re-reads every installed measure against the home's actual zone (from the job ZIP) and re-runs the DeemedSavingsCalculator percentage for the jobs SnuggPro puts in the Plus band.

- **Table 2B** — every measure row in report order, both program blocks, with quantity, kWh, kW, therms, expenses and % of expenditure. Cells copy at full precision like the Measures Table.
- **SnuggPro vs. corrected** — per job: ZIP, climate zone, HVAC type, both percentages, both paths, and the savings the correction moved. Disagreements sort first.
- **Exceptions** — jobs whose path changed, zones with no published measures, measures with no catalog row for that home, unpaired system halves, short billing history, and any line item that reached no 2B row, with the dollars each carries.
- **Toggles** — *Completed jobs only* (2B reports completed and expensed installations), *Include non-measure costs* (rolls audit, blower-door, testing and marketing spend into ESA WH Outreach & Assessment so the block reconciles 1:1 with the SnuggPro project record — off by default, matching what gets reported), and *Hide empty rows*.
- **Export 2B XLSX** — three sheets: `Table 2B`, `By Job`, `Exceptions`.

Reference data is generated from the ESA source workbooks and committed under `public/reference/`. Regenerate it whenever one of those workbooks is revised:

```bash
node tools/build-reference.js      # reads the workbooks in ../report-tool
node tools/verify-reference.js     # join coverage against a real export
node tools/verify-calculator.js    # reproduces DeemedSavingsCalculator's worked example
node tools/verify-table2b.js       # end-to-end on a synthetic job
node tools/verify-cpuc.js          # reconciles against the filed Summary_CPUC-*.csv
```

## Files

- `worker.js` — Cloudflare Worker: email-code login + signing proxy + serves the UI (team deployment)
- `wrangler.toml` — Worker config (allowlist, sender, assets binding)
- `public/index.html` — browser UI (no build step, no framework)
- `public/template_range.xlsx` — XLSX export template (single source, served by both proxy and Worker)
- `template.xlsx` — legacy XLSX template (kept for reference)
- `proxy.js` — local signing proxy: serves UI, templates, `/reference/*.json`, `/programs`, and saves exports
- `public/reference/` — generated ESA reference data for the Table 2B view (climate zones, deemed savings by zone, the 2B row list, the measure crosswalk, the fee schedule)
- `tools/build-reference.js` — regenerates `public/reference/` from the ESA workbooks; holds the curated crosswalk
- `tools/xlsx-read.js` — dependency-free XLSX reader used by the tools
- `tools/verify-*.js` — hand-run checks for the reference data and the Table 2B math
- `exports/` — where local-mode CSV/XLSX exports are saved (contents gitignored)
- `start.bat` / `stop.bat` / `restart.bat` — Windows one-click launchers for `wrangler dev` (port 2023)
- `setup-portable.bat` / `start-portable.bat` — USB prep (download Node into `runtime/`) and double-click launch of `proxy.js`
- `.env` — your API keys for `proxy.js` (gitignored, never committed)
- `.env.example` — template for `proxy.js`
- `.dev.vars` / `.dev.vars.example` — secrets for local `wrangler dev` (gitignored)
- `swagger.json` — SnuggPro API spec for reference (optional)

## Notes

- Single-file HTML, no build step. Edit and reload.
- Auth uses the Web Crypto API in the browser only for the standalone key-entry mode; the proxy path signs server-side from `.env`.
