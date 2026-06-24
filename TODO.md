# TODO — Deploy the hosted SnuggPro Inspector

Step-by-step guide to put the inspector online for the team (email-code login,
free Cloudflare Worker, no domain or nameserver changes). The hosted version lives
on the `claude/team-api-caller-auth-2hjsiq` branch; this `main` branch is the local
solo version. Do these in order.

> Secrets are never stored in files — they go into Cloudflare via `wrangler secret put`.
> Don't commit real keys.

## Step 1 — Get the code on your machine
```bash
cd snuggpro-inspector
git checkout claude/team-api-caller-auth-2hjsiq
git pull origin claude/team-api-caller-auth-2hjsiq
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

## Step 5 — Store the 4 secrets (run one at a time, paste when prompted)
```bash
npx wrangler secret put SNUGG_PUBLIC_KEY     # paste your public key
npx wrangler secret put SNUGG_PRIVATE_KEY    # paste your private key
npx wrangler secret put SESSION_SECRET       # paste a long random string (generate below)
npx wrangler secret put EMAIL_API_KEY        # paste your SendGrid key
```
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
3. Fetch job **332046** → confirm the Measures Table shows combined **967.82 kWh**
4. (Optional) try a non-listed email → confirm it's blocked

## Step 8 — Share with your team
Send them the URL: open it, type your email, paste the mailed code. That's it.

## Step 9 — Rotate the key (housekeeping)
Because the SnuggPro keys passed through chat in plaintext, regenerate the API key
(Settings → App Integrations), then re-run the two `wrangler secret put` commands with
the new values and `npx wrangler deploy` again.

---

## Add or remove a teammate later
Edit the `ALLOWED_EMAILS` line in `wrangler.toml`, then:
```bash
npx wrangler deploy
```
Removal takes effect immediately (the allowlist is re-checked on every request).

## Troubleshooting
- **Login email didn't arrive** → check spam; confirm `FROM_EMAIL` matches the verified
  SendGrid sender exactly; confirm `EMAIL_API_KEY` is set (`npx wrangler secret list`).
- **Job fetch fails** → re-check `SNUGG_PUBLIC_KEY` / `SNUGG_PRIVATE_KEY`.
- **Local testing** → `cp .dev.vars.example .dev.vars`, fill it in, `npx wrangler dev`
  (serves UI + login + proxy at http://localhost:8787).
