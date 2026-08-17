# TODO — Deploy the hosted SnuggPro Inspector

Step-by-step guide to put the inspector online for the team (email-code login,
free Cloudflare Worker, no domain or nameserver changes). Do these in order.

> For the full explanation (how it works, configuration model, troubleshooting, security),
> see **[SETUP.md](SETUP.md)**. This file is the quick run sheet + verification checklist.

> Secrets are never stored in files — they go into Cloudflare via `wrangler secret put`.
> Don't commit real keys.

## Step 1 — Get the code on your machine
```bash
cd snuggpro-inspector
git checkout main
git pull
npm install
```

## Step 2 — Set up the email sender (SendGrid)
1. Create a free account at sendgrid.com
2. Settings → Sender Authentication → **Single Sender Verification** → add one "from"
   address (e.g. your work email) → click the verification link they email you (no DNS)
3. Settings → API Keys → **Create API Key** (Mail Send) → copy it somewhere temporary

## Step 3 — Log into Cloudflare
```bash
npx wrangler login
```
Approve in the browser. (Creates a free Cloudflare account if you don't have one.)

## Step 4 — Set your team + sender in `wrangler.toml`
```toml
[vars]
ALLOWED_EMAILS = "you@company.com,teammate2@company.com,teammate3@company.com"
FROM_EMAIL = "the-address-you-verified-in-sendgrid@company.com"
```
- `ALLOWED_EMAILS` = who may log in (any email type works)
- `FROM_EMAIL` = the exact address verified in Step 2

## Step 5 — Store the secrets (run one at a time, paste when prompted)
One public + private key pair per SnuggPro program, plus the session and email secrets:
```bash
# Region 1 — CA LIWP Farmworkers
npx wrangler secret put REGION1_PUBLIC_KEY
npx wrangler secret put REGION1_PRIVATE_KEY
# Region 2 — CA LIWP Farmworkers
npx wrangler secret put REGION2_PUBLIC_KEY
npx wrangler secret put REGION2_PRIVATE_KEY
# SDGE — Whole Home Program
npx wrangler secret put SDGE_PUBLIC_KEY
npx wrangler secret put SDGE_PRIVATE_KEY
# SCE/SCG ESA Whole Home
npx wrangler secret put SCE_PUBLIC_KEY
npx wrangler secret put SCE_PRIVATE_KEY
# Session signing + email sender
npx wrangler secret put SESSION_SECRET       # paste a long random string (generate below)
npx wrangler secret put EMAIL_API_KEY        # paste your SendGrid key
```
You only need the pairs for programs you actually use — the switcher greys out any program
whose keys are missing.
Generate the `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Step 6 — Deploy
```bash
npx wrangler deploy
```
Copy the printed `https://snuggpro-inspector.<something>.workers.dev` URL.

## Step 7 — Test it yourself first (incognito window)
1. Open the URL → you should see a login page
2. Enter one of your `ALLOWED_EMAILS` → check email for the 6-digit code → paste it
3. Fetch a non-production test job you are authorized to access → confirm the Measures Table loads and its totals reconcile with the source job
4. (Optional) try a non-listed email → confirm it's blocked

## Step 8 — Share with your team
Send them the URL: open it, type your email, paste the mailed code. That's it.

## Step 9 — Rotate keys (housekeeping)
If any SnuggPro key was shared in plaintext, regenerate it (Settings → App Integrations),
then re-run the matching `wrangler secret put` command(s) with the new value and
`npx wrangler deploy` again.

---

## Add or remove a teammate later
Edit the `ALLOWED_EMAILS` line in `wrangler.toml`, then:
```bash
npx wrangler deploy
```
Removal takes effect immediately (the allowlist is re-checked on every request).

## Pending checks (my verification list)

These couldn't be tested without real keys / a live deploy. The **data checks are
identical** in both run modes — only **how you launch** differs.

### How to launch (both modes live on `main`)
- **Hosted (team):** after `wrangler deploy`, open the `*.workers.dev` URL → sign in with an
  allowlisted email + the mailed code. (Locally: `npx wrangler dev` → port 8787, or `start.bat` → port 2023.)
- **Local (solo):** `npm start` (runs `proxy.js` on :3001) → open **http://localhost:3001**
  in Chrome. No deploy, login, or email involved; exports save into `exports/`.

### Checks for BOTH modes
- [ ] **Measures Table**, non-production test job → combined totals reconcile with modeled + deemed source values.
- [ ] **Usage / Billing**, same test job → electric + gas rows with Bill Start / Bill End /
      Billed Days / Usage / Units / MMBTU populated.
- [ ] **MMBTU spot-check** → a ~1000 kWh period ≈ 3.412 MMBTU; a 50-therm period = 5.0 MMBTU.
      Spot-check one Billed Days against its two dates.
- [ ] **Download CSV** (`usage_job_{id}.csv`) → opens with full-precision values + correct headers.
      Local mode: lands in `exports/`; hosted: browser download.
- [ ] **Export XLSX** → works in BOTH modes (hosted serves the template as a static asset;
      local serves it from `public/template_range.xlsx`).
- [ ] **Multi-job** → enter two Job IDs → Job column separates them.
- [ ] **Edge case to decide:** if a job uses "Simple" / "No Bills" entry (no per-period bills),
      the Usage view shows "no periodic utility bills found." Decide whether you want that
      case handled (would be a follow-up).

### Hosted-only checks
- [ ] `wrangler deploy` succeeds and prints the `*.workers.dev` URL.
- [ ] Allowlisted email → receives code → signs in. **Non-listed email is blocked.**
- [ ] Login email actually arrives (check spam the first time).
- [ ] Rotate the SnuggPro key after confirming everything works (Step 9).

## Open questions from the code review (need live data to settle)

- [x] **Confirm the units of "Yearly Energy Cost Savings."** Checked against a sanitized validation case:
      the `totalSavings` key inside the `deemedAndModeledKwhSavings` incentive's `metadataJSON`
      was energy (kWh), not dollars — it matched the combined energy figure, not a
      plausible dollar amount. Dropped that source; `getYearlyCostSavings()` now reads
      `totals.totalSavings` alone (swagger: "the total cost of energy saved by the improved
      home per year", dollars — modeled only, same scope as `installedCosts`, which is
      documented "excluding direct installs"). Note this means the column undercounts jobs
      with a large deemed (direct-install) share, since `totals` doesn't see those savings —
      that's a real gap, not a bug, and there's no documented field that reports combined
      modeled+deemed dollars to fall back to.
- [ ] **Decide whether recommendation savings should be split across line items.**
      `flattenMeasures()` copies each recommendation's `savedKwh` / `savedTherms` / `savedMbtu`
      / `savings` / `sir` onto **every** one of its `detailedCosts` line items. A measure billed
      as separate "Labor" and "Material" lines therefore contributes its savings **twice** to the
      TOTAL row and to the Combined kWh/Therms/MMBTU cards. This is long-standing behaviour, not
      new — prior single-line-item validation cases do not expose it. Confirm against a test job
      whose recommendations have multiple line items; if the totals inflate, the fix is to
      attribute savings to the first line item only (or split it),
      and the validation reference numbers need re-checking afterwards.
- [ ] **XLSX export omits Stage and Yearly Energy Cost Savings.** The workbook's sheet layout is
      fixed by `template_range.xlsx` (18 measure columns, matched by position), so the two new
      columns appear in the table and the CSV but not in the workbook. Savings % is already on
      sheet1. Adding the other two means editing the template first.

## Backlog / enhancements
- [ ] **Measures export: add a per-row program tier** (Plus vs Deep). Each row should show
      whether the job is on the Plus or Deep tier, and it should carry through to the CSV/XLSX
      export. Source is already computed — `getReportingContext().tier` returns
      `'deep'` / `'plus'` / `'review'` per job. Add a `tier` column to the Measures table +
      export (label it "Tier", values "Deep" / "Plus"). Leave the cell **blank** for the
      `'review'` tier (below 5% savings).

## Troubleshooting
- **Login email didn't arrive** → check spam; confirm `FROM_EMAIL` matches the verified
  SendGrid sender exactly; confirm `EMAIL_API_KEY` is set (`npx wrangler secret list`).
- **Job fetch fails / "No keys configured for program"** → confirm that program's
  `*_PUBLIC_KEY` / `*_PRIVATE_KEY` pair is set (`npx wrangler secret list`).
- **Local testing** → `cp .dev.vars.example .dev.vars`, fill it in, `npx wrangler dev`
  (serves UI + login + proxy at http://localhost:8787).
