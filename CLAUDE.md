# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A tool for inspecting SnuggPro energy-audit jobs via the SnuggPro API. The signing proxy exists because SnuggPro's API has no CORS support. Two ways to run it:

1. **Hosted (team) — `worker.js` + `wrangler.toml`.** A Cloudflare Worker that (a) gates access behind an email one-time-code login restricted to an `ALLOWED_EMAILS` allowlist, (b) serves the UI from `public/` as a static asset, and (c) signs (HMAC-SHA256) and forwards `/proxy/*` to `https://api.snuggpro.com`. Same origin as the UI, so no CORS dance. Secrets (a public/private key pair per program — `REGION1_*`, `REGION2_*`, `SDGE_*`, `SCE_*` — plus `SESSION_SECRET`, `EMAIL_API_KEY`) live as Wrangler secrets. This is how the team uses it — `npx wrangler deploy`.
2. **Local (solo) — `proxy.js`.** A Node HTTP server on `localhost:3001` (auto-binds the next port if busy) that serves the UI same-origin at `/`, the program list at `/programs`, the XLSX templates, and the signing proxy at `/proxy/*` with keys from `.env`; `POST /exports` saves export files into `exports/`. No login.

The browser UI is `public/index.html` — a single-file vanilla-JS app (no framework, no build step) that calls the proxy at the same-origin `/proxy` path (with `?program=` from the program switcher) and renders job data, including a flattened Measures Table and Usage/Billing view with CSV and template-based XLSX export.

There is no build, bundler, or test runner. Edit files and reload. Local runs: `npm start` → `http://localhost:3001` (no login), or `npx wrangler dev` → `localhost:8787` to exercise the hosted login flow (set `LOCAL_BYPASS_AUTH=true` in `.dev.vars` to skip it; `start.bat`/`stop.bat`/`restart.bat` use port 2023 on Windows).

## Running it

**Team (hosted):**
```
npm install
npx wrangler login
# set ALLOWED_EMAILS + FROM_EMAIL in wrangler.toml, then:
npx wrangler secret put REGION1_PUBLIC_KEY  # + each program's *_PUBLIC/_PRIVATE pair, EMAIL_API_KEY, SESSION_SECRET
npx wrangler deploy
```
See README "Team deployment" for the full walkthrough (SendGrid sender, adding teammates).

**Local (solo, offline):**
```
npm install
cp .env.example .env   # fill in real keys
npm start              # proxy.js serves UI + proxy at http://localhost:3001, no login
```
(To test the hosted flow locally instead: `npx wrangler dev` on :8787, with `LOCAL_BYPASS_AUTH=true` in `.dev.vars` to skip the email login.)

## Architecture and key invariants

### Auth
- Signature = `HMAC-SHA256(privateKey, x-date-iso-timestamp)`, hex digest.
- Header: `Authorization: Credential={public},Signature={sig}` plus `X-Date: {same timestamp}`.
- The timestamp used in the signature MUST be the same one sent in `X-Date`. Do not regenerate it between signing and sending. (`worker.js` reuses one `date` value; `proxy.js` likewise.)
- Keys live only in `.env` (proxy) or Wrangler secrets (worker). Never hardcode them in `proxy.js`, `worker.js`, or the HTML. Never commit `.env` or `.dev.vars`.

### Worker login (email one-time code)
- Login is gated by `ALLOWED_EMAILS` (comma-separated, in `wrangler.toml`). The allowlist is re-checked on **every** request, so removing an email + redeploy revokes access immediately.
- Session and OTP are **stateless signed cookies**: `base64url(payloadJSON) + "." + hmacHex(base64url(payloadJSON), SESSION_SECRET)`, verified with a constant-time compare and an `exp` check. There is no datastore; the OTP is bound to the same browser via its cookie.
- The 6-digit code is never stored in plaintext — the OTP cookie holds `hmacHex(email:code, SESSION_SECRET)`, compared on verify.
- `LOCAL_BYPASS_AUTH=true` (in gitignored `.dev.vars` only) skips the gate for local dev. It is double-guarded: the Worker also requires the request hostname to be `localhost`/`127.0.0.1`. NEVER add it to `wrangler.toml` or as a production secret.

### The Measures Table (most important business logic)
Lives in `public/index.html`, in `flattenMeasures(data)` and `buildCombinedSummary()`. It reads `/jobs/{id}/all-data`.

Rules that MUST hold (each was a real correction — do not regress them):

1. **Active recommendations only.** Filter `recommendations` to `status == "1"`. Status `"3"` is declined, `"4"` is health/safety. Declined measures inflate totals and must be excluded.
2. **Recommendation savings are line-totals.** `rec.savedKwh` / `savedTherms` / `savedMbtu` are already totals for the measure. Do NOT multiply by quantity.
3. **Direct-install deemed savings are PER UNIT.** `deemedAnnualKwhSavings` / `deemedThermsSavings` / `deemedMmbtuSavings` must be multiplied by `quantity`. Several line items have quantity 2 (e.g. TSV showerhead, faucet aerator); skipping the multiply undercounts the combined total.
4. **Modeled and deemed are separate columns.** They are never added within a row. The combined figure (modeled + deemed) only appears in the summary panel, computed across the two column groups.
5. **Reporting basis** comes from `rebatesIncentives` -> entry with `code == "deemedAndModeledKwhSavings"` -> `metadataJSON` -> `combinedTotalEnergySavings`. Over 15% = modeled (saved) basis; 5-15% = deemed; under 5% = flag for review.

Historical live validation confirmed that combined savings equal modeled plus deemed values and that a borderline result above 15% selects the modeled basis. Use only non-production test jobs for future validation; do not record customer identifiers here.

### Conventions the measures/usage code relies on
- **Job payloads are passed as arguments, never read from `lastData`.** `getReportingContext(data)`,
  `getYearlyCostSavings(data)`, `stageLabel(data)` and `stampCalcColumns(row, tier)` all take what
  they need. `lastData` is only the backing store for the raw-JSON pane and its Copy button —
  reading it for reporting values lets one view's fetch silently repoint another view's numbers.
- **Read the incentive metadata through `metaNum(data, key)`.** It goes through `num()`, so `''`,
  `null` and non-numeric strings all collapse to `null`. Raw `Number()` turns `''` into `0` and
  `'N/A'` into `NaN`, and both survive a `== null` check — they reach the table and the CSV as a
  fabricated reading, and `NaN` additionally makes the column's sort comparator a silent no-op.
- **`MEASURE_COLS` flags carry column policy.** `job: true` = a per-job fact repeated on every row
  of that job; those are excluded from `TOTAL_KEYS` because summing them would report the figure
  multiplied by the line-item count. `farmworker: true` = Region 1/2 only; `noFarmworker: true` =
  hidden on Region 1/2 (used for the tier-basis `savingsPct`, which those programs don't use —
  same reason `buildCombinedSummary` hides the basis/tier badges there).
- **Anything from the API goes through `esc()` before it lands in an `innerHTML` string or in the
  XLSX sheet XML** — measure titles, line-item names, stage ids and units are free-form SnuggPro
  fields, and on the hosted Worker the page shares an origin with the session cookie.
- **Multi-job fetches go through `fetchJobsAllData(jobIds, { refresh })`**, which loads up to
  `JOB_FETCH_CONCURRENCY` jobs at once and returns `{ data, errors }` index-aligned with the input.
  Don't reintroduce a per-job `await` loop. Successful payloads are memoized in `jobDataCache`
  under `program:jobId` — program-scoped because the same id signed against another program is a
  different request, and failures are never cached so the next attempt retries. The view fetches
  (`fetchMeasures`, `fetchUsageBilling`) pass `refresh: true` so pressing Fetch always re-reads the
  job; `exportXlsx` deliberately doesn't, so exporting a batch you just pulled into a view costs no
  requests. Keep that split — making the export refresh too restores the double round-trip.
- Sidebar `.nav-item` buttons without a `data-path` (Export XLSX) are action buttons: the delegated
  nav handler returns early for them, so they don't blank `currentPath` or steal the active view.

### Field-access conventions in the HTML
- All displayed numbers round only for display (`toFixed(2)`); the raw full-precision value is what gets copied to clipboard and exported to CSV. Keep that split — reporting needs full precision.
- Cells copy on click via `copyCell()` using a `data-copy` attribute holding the raw value.
- Sorting is column-wise; the TOTAL row sums each numeric column independently.
- All exports save via `saveOrDownload()`: it tries `POST /exports` (proxy.js writes into `exports/`) and falls back to a plain browser download on the hosted Worker. Never put a path separator in `a.download` — browsers strip it.
- The XLSX template is fetched at `/template_range.xlsx` — keep the extension. The Worker serves it as a static asset from `public/`, and extension-less paths 404 there (proxy.js accepts both forms).
- **The export writes values positionally into the template's own header row — the row arrays in `exportXlsx()` must match row 1 of each sheet, not the table XML.** Sheet2 (`MeasureSavings`) is 19 columns: the reporting upload block in A–J (`AuditId, ReportingCode, Code, MeasureQty, Unit, SavedkWh, kW, SavedTherms, SavedMBTUs, MeasureCostOverride`) then the backing detail in K–S (`Measure, Src, Cost/Unit, Saved kWh/Therms/MMBTU, Deemed kWh/Therms/MMBTU`). F/H/I carry the tier-basis *calculated* figures (`stampCalcColumns`), N–S the modeled/deemed breakdown behind them; G (kW) has no source in `/all-data` and stays blank. If you change the template header, change the push in `exportXlsx()` in the same commit.
- **`xl/tables/table<N>.xml` numbering does not track sheet numbering.** `patchSheet()` resolves each sheet's tables through its own `xl/worksheets/_rels/sheet<N>.xml.rels`. Don't go back to guessing table paths by sheet index — in this template table1 belongs to sheet3 and table2 to sheet4, and deleting them by guessed name left sheet3/sheet4 pointing at missing parts, which is exactly the "Excel found unreadable content" repair prompt.

## When adding endpoints
Endpoints are listed as `<button class="nav-item" data-path="/jobs/{jobId}/...">` in the sidebar. `{jobId}` is substituted at fetch time. The special `data-path="MEASURES"` and `data-path="USAGE"` tokens route to reporting views (`fetchMeasures` / `fetchUsageBilling`) instead of a raw GET. The full endpoint list came from `swagger.json` (kept in repo for reference).

### The Usage / Billing view
`flattenUsage(data)` reads `data.utilities` from `/jobs/{id}/all-data` into one row per fuel per billing period. The bill series is flat & numbered: electric uses `startElectricDate1` + `endElectricDate1..N` + `endElectricBill1..N` (units in `electricBillUnits`); gas uses the `…Fuel…` equivalents (`fuelBillUnits`). Period N spans (prior read date → `endDate N`). MMBTU is computed from usage (kWh×3412.14, therm×100000 BTU) only when units are energy units — blank for "Dollars" etc. Mirrors the Measures CSV/sort/copy conventions.

## Style / conventions
- Vanilla JS only. No frameworks, no bundlers, no new runtime dependencies unless necessary.
- Keep the HTML a single self-contained file.
- Git commits authored as the repo owner; no AI attribution lines.
- Do not weaken the `.env` / `.gitignore` boundary or print secrets to logs.
