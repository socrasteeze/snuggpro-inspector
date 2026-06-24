# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A tool for inspecting SnuggPro energy-audit jobs via the SnuggPro API. The signing proxy exists because SnuggPro's API has no CORS support. Two ways to run it:

1. **Hosted (team) — `worker.js` + `wrangler.toml`.** A Cloudflare Worker that (a) gates access behind an email one-time-code login restricted to an `ALLOWED_EMAILS` allowlist, (b) serves the UI from `public/` as a static asset, and (c) signs (HMAC-SHA256) and forwards `/proxy/*` to `https://api.snuggpro.com`. Same origin as the UI, so no CORS dance. Secrets (`SNUGG_*`, `SESSION_SECRET`, `EMAIL_API_KEY`) live as Wrangler secrets. This is how the team uses it — `npx wrangler deploy`.
2. **Local (solo) — `proxy.js`.** A Node HTTP server on `localhost:3001` that signs requests with API keys from `.env` and forwards them, adding CORS headers. Offline/solo fallback only.

The browser UI is `public/index.html` — a single-file vanilla-JS app (no framework, no build step) that calls the proxy at the same-origin `/proxy` path and renders job data, including a flattened Measures Table for reporting and CSV export.

There is no build, bundler, or test runner. Edit files; for local runs use `npx wrangler dev` (serves UI + login + proxy at `localhost:8787`) since the same-origin `/proxy` path means opening the HTML via `file://` no longer reaches a proxy.

## Running it

**Team (hosted):**
```
npm install
npx wrangler login
# set ALLOWED_EMAILS + FROM_EMAIL in wrangler.toml, then:
npx wrangler secret put SNUGG_PUBLIC_KEY    # + SNUGG_PRIVATE_KEY, EMAIL_API_KEY, SESSION_SECRET
npx wrangler deploy
```
See README "Team deployment" for the full walkthrough (SendGrid sender, adding teammates).

**Local (solo, offline):**
```
npm install
cp .env.example .env   # fill in real keys
npx wrangler dev       # serves UI + login + proxy at http://localhost:8787
```
(`npm start` still runs the bare `proxy.js` on :3001, but the UI's same-origin `/proxy` path means you should drive local testing through `wrangler dev`.)

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
