# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A local tool for inspecting SnuggPro energy-audit jobs via the SnuggPro API. Two pieces:

1. `proxy.js` — a Node HTTP server on `localhost:3001` that signs requests (HMAC-SHA256) with API keys from `.env` and forwards them to `https://api.snuggpro.com`, adding CORS headers so the browser can read responses. SnuggPro's API has no CORS support, which is the entire reason this proxy exists.
2. `snuggpro-inspector.html` — a single-file browser UI (vanilla JS, no framework, no build step) that calls the proxy and renders job data, including a flattened Measures Table for reporting and CSV export.

There is no build, bundler, or test runner. Edit files and reload the browser.

## Running it

```
npm install        # installs dotenv (only dependency)
cp .env.example .env   # then fill in real keys
npm start          # node proxy.js
```
Open `snuggpro-inspector.html` in Chrome. Proxy must stay running.

## Architecture and key invariants

### Auth
- Signature = `HMAC-SHA256(privateKey, x-date-iso-timestamp)`, hex digest.
- Header: `Authorization: Credential={public},Signature={sig}` plus `X-Date: {same timestamp}`.
- The timestamp used in the signature MUST be the same one sent in `X-Date`. Do not regenerate it between signing and sending.
- Keys live only in `.env`. Never hardcode them in `proxy.js` or the HTML. Never commit `.env`.

### The Measures Table (most important business logic)
Lives in `snuggpro-inspector.html`, in `flattenMeasures(data)` and `buildCombinedSummary()`. It reads `/jobs/{id}/all-data`.

Rules that MUST hold (each was a real correction — do not regress them):

1. **Active recommendations only.** Filter `recommendations` to `status == "1"`. Status `"3"` is declined, `"4"` is health/safety. Declined measures inflate totals and must be excluded.
2. **Recommendation savings are line-totals.** `rec.savedKwh` / `savedTherms` / `savedMbtu` are already totals for the measure. Do NOT multiply by quantity.
3. **Direct-install deemed savings are PER UNIT.** `deemedAnnualKwhSavings` / `deemedThermsSavings` / `deemedMmbtuSavings` must be multiplied by `quantity`. Several line items have quantity 2 (e.g. TSV showerhead, faucet aerator); skipping the multiply undercounts the combined total.
4. **Modeled and deemed are separate columns.** They are never added within a row. The combined figure (modeled + deemed) only appears in the summary panel, computed across the two column groups.
5. **Reporting basis** comes from `rebatesIncentives` -> entry with `code == "deemedAndModeledKwhSavings"` -> `metadataJSON` -> `combinedTotalEnergySavings`. Over 15% = modeled (saved) basis; 5-15% = deemed; under 5% = flag for review.

Validation reference (job 332046, Bissonette): combined 967.82 kWh = 538.69 modeled + 429.13 deemed. (Job 355981, Goehring): combined 1351.32 kWh, 107.07 therms, 16.65% savings (borderline, flags modeled).

### Field-access conventions in the HTML
- All displayed numbers round only for display (`toFixed(2)`); the raw full-precision value is what gets copied to clipboard and exported to CSV. Keep that split — reporting needs full precision.
- Cells copy on click via `copyCell()` using a `data-copy` attribute holding the raw value.
- Sorting is column-wise; the TOTAL row sums each numeric column independently.

## When adding endpoints
Endpoints are listed as `<button class="nav-item" data-path="/jobs/{jobId}/...">` in the sidebar. `{jobId}` is substituted at fetch time. The special `data-path="MEASURES"` token routes to the reporting view instead of a raw GET. The full endpoint list came from `swagger.json` (kept in repo for reference).

## Style / conventions
- Vanilla JS only. No frameworks, no bundlers, no new runtime dependencies unless necessary.
- Keep the HTML a single self-contained file.
- Git commits authored as the repo owner; no AI attribution lines.
- Do not weaken the `.env` / `.gitignore` boundary or print secrets to logs.
